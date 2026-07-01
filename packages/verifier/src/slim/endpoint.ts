// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier-side SLIM endpoint.
 *
 * Main-thread shim around the worker_thread in `./worker-listener.ts`.
 * Every async method in @agntcy/slim-bindings@1.4.0 is generated without
 * `liftError` and silently fails as "CALL_ERROR but no errorClass
 * specified". We use the sync methods inside a worker thread instead, and
 * postMessage protocol bridges inbound SLIM messages out to the caller's
 * handler.
 *
 * Wire-up unchanged from the original endpoint contract:
 *   startSlimEndpoint(config, handler) → SlimEndpointHandle
 * The handler receives a SlimMessage and returns the reply bytes; the
 * worker forwards both directions over `session.publishTo(...)`.
 *
 * If `@agntcy/slim-bindings` is not installed (host has no native binary)
 * or the worker fails to initialise, the returned handle is a no-op so
 * the rest of the Verifier process still boots.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createConcurrencyGate } from './concurrency-gate';
import { classifyInboundLane } from './inbound-lane';
import {
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  createRestartTracker,
} from './worker-supervision';

export interface SlimEndpointConfig {
  controlPlaneUrl: string;
  /** Three-component SLIM name the Verifier listens on. */
  listenName: { org: string; namespace: string; agent: string };
  /** Shared secret for the SharedSecret identity provider/verifier. */
  sharedSecret: string;
  /** Per-inbound timeout for the handler to produce a reply. Defaults to 30s. */
  replyTimeoutMs?: number;
  /** Optional logger override. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface SlimMessage {
  payload: Uint8Array;
  payloadType: string | undefined;
  sourceName: string;
  destinationName: string | undefined;
  metadata: Map<string, string>;
}

export type SlimMessageHandler = (input: SlimMessage) => Promise<Uint8Array>;

export interface SlimEndpointHandle {
  done: Promise<void>;
  ready: Promise<void>;
  /**
   * True while a SLIM listener worker is alive and subscribed. The
   * verifier's /ready probe surfaces this so a crashed/unsubscribed SLIM
   * worker fails readiness (and ECS culls the task), unlike /health which
   * is served locally and stays 200 even when the SLIM endpoint is gone.
   */
  isReady: () => boolean;
  shutdown: () => void;
}

// Worker is hand-written .mjs (not .ts) so it can be spawned with plain
// node — see slim-worker-host.ts in @spellguard/gateway for the rationale.
const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'worker-listener.mjs',
);

export async function startSlimEndpoint(
  config: SlimEndpointConfig,
  handler: SlimMessageHandler,
): Promise<SlimEndpointHandle> {
  const log =
    config.log ??
    ((level, msg) => {
      const prefix = `[verifier-slim] ${msg}`;
      if (level === 'error') console.error(prefix);
      else if (level === 'warn') console.warn(prefix);
      else console.log(prefix);
    });

  // Defensive: skip if bindings aren't even on disk (e.g. running tests
  // on a host without a published platform binary). The worker would
  // fail with the same error, but checking here lets us return a
  // proper no-op handle synchronously.
  try {
    await import('@agntcy/slim-bindings');
  } catch (err) {
    log(
      'warn',
      `@agntcy/slim-bindings not installed (${(err as Error).message}). SLIM endpoint disabled — agents must use the gateway's HTTP fallback or this Verifier is unreachable via SLIM.`,
    );
    return {
      done: Promise.resolve(),
      ready: Promise.resolve(),
      // No bindings → the SLIM endpoint is genuinely not ready. In a slim
      // deploy this fails /ready so ECS replaces the task; in non-slim
      // runtimes startSlimEndpoint is never called, so this is moot.
      isReady: () => false,
      shutdown: () => undefined,
    };
  }

  const listenNames = [
    `${config.listenName.org}/${config.listenName.namespace}/${config.listenName.agent}`,
  ];

  const workerData = {
    controlPlaneUrl: config.controlPlaneUrl,
    identity: config.listenName,
    sharedSecret: config.sharedSecret,
    listenNames,
    replyTimeoutMs: config.replyTimeoutMs ?? 30_000,
    // The Verifier process runs THREE SLIM apps (this endpoint listener +
    // send-to-agent + push-registry). The bindings' getGlobalService() only
    // permits ONE connectAsync per process, so each worker must own its own
    // Service or the 2nd/3rd brick with "CALL_ERROR but no errorClass". See
    // slim-worker.mjs / worker-listener.mjs.
    ownService: true,
  };

  let readyResolve!: () => void;
  const ready = new Promise<void>((res) => {
    readyResolve = res;
  });
  let doneResolve!: () => void;
  const done = new Promise<void>((res) => {
    doneResolve = res;
  });

  // Supervision state. The SLIM worker can die (an upstream bindings
  // panic, an unhandled rejection) or wedge and self-report a fatal
  // state. Previously worker.on('exit') only logged — the verifier then
  // kept serving /health (200, local, no SLIM hop) while its SLIM
  // endpoint was silently gone: a zombie ECS never replaced. Now we
  // respawn on unexpected exit, and escalate to a process exit (so ECS
  // replaces the whole task) if respawns thrash or the worker reports a
  // wedge it cannot recover from. Window/backoff constants + the window
  // math are shared with the two sender hosts (worker-supervision.ts).
  let stopped = false;
  let workerReady = false;
  let currentWorker: Worker | null = null;
  const restartTracker = createRestartTracker();

  // Bound concurrent inbound handling. Each inbound message runs the full
  // handler (app.fetch → route → deliver) on the verifier's single main
  // event loop. Unbounded, a burst of concurrent deliveries — even now
  // that each is duration-capped (~110s forward timeout) — piles up and
  // starves the cheap /ready + heartbeat handlers on the same loop, so ECS
  // health-check-kills a busy-but-alive verifier (and the co-located slim
  // dies with it). The gates cap concurrency and FIFO-queue the rest. The
  // worker's per-tag reply timer is the backstop for items that queue too
  // long (empty reply → caller retries) — graceful degradation vs. the
  // loop going dark. TWO lanes, classified per frame (inbound-lane.ts):
  // long-running /messages/* deliveries take the msg gate; control-plane
  // calls (register, attestation, tools/check, discovery) take their own
  // ctl gate so ≤6 parked ~110s deliveries can no longer starve them past
  // the gateway's 25s ctl budget (checkToolPolicy then failed OPEN
  // client-side). Both gates are shared across worker respawns (created
  // once here, outside spawn()).
  const msgGate = createConcurrencyGate(
    Number(process.env.SPELLGUARD_VERIFIER_MAX_INFLIGHT) || 6,
  );
  const ctlGate = createConcurrencyGate(
    Number(process.env.SPELLGUARD_VERIFIER_MAX_INFLIGHT_CTL) || 4,
  );

  function fatalExit(reason: string): void {
    log(
      'error',
      `SLIM endpoint fatal: ${reason} — exiting so ECS replaces the task`,
    );
    // Brief delay so the log line flushes before the process exits.
    setTimeout(() => process.exit(1), 100);
  }

  function spawn(): void {
    const worker = new Worker(WORKER_PATH, { workerData });
    currentWorker = worker;

    const handleInbound = async (m: {
      tag: string;
      source: string;
      destination?: string;
      payloadType?: string;
      payload: Uint8Array;
    }): Promise<void> => {
      // Lane-classify BEFORE gating. This decodes the wire envelope (the
      // handler decodes it again) — accepted, it's a tiny JSON parse; see
      // inbound-lane.ts for the full rationale.
      const lane = classifyInboundLane(m.payload);
      log(
        'info',
        `inbound tag=${m.tag} lane=${lane} bytes=${m.payload.byteLength} from ${m.source}`,
      );
      const message: SlimMessage = {
        payload: m.payload,
        payloadType: m.payloadType || undefined,
        sourceName: m.source,
        destinationName: m.destination || undefined,
        metadata: new Map(),
      };
      // Gate on a concurrency slot so app.fetch chains can't pile up and
      // starve the event loop (see `msgGate`/`ctlGate` above).
      const gate = lane === 'msg' ? msgGate : ctlGate;
      let reply: Uint8Array;
      try {
        reply = await gate.run(() => handler(message));
        log(
          'info',
          `handler returned tag=${m.tag} replyBytes=${reply.byteLength}`,
        );
      } catch (err) {
        log(
          'error',
          `handler threw for sender ${message.sourceName}: ${(err as Error).message}`,
        );
        reply = new Uint8Array();
      }
      worker.postMessage({ type: 'reply', tag: m.tag, payload: reply });
    };

    worker.on('message', (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as {
        type?: string;
        tag?: string;
        source?: string;
        destination?: string;
        payloadType?: string;
        payload?: Uint8Array;
        stage?: string;
        message?: string;
        reason?: string;
      };
      switch (m.type) {
        case 'ready':
          workerReady = true;
          log(
            'info',
            `subscribed as ${config.listenName.org}/${config.listenName.namespace}/${config.listenName.agent}`,
          );
          readyResolve();
          break;
        case 'inbound':
          if (m.tag && m.payload) void handleInbound(m as Required<typeof m>);
          break;
        case 'request-process-exit':
          fatalExit(`worker reported wedge: ${m.reason ?? 'unspecified'}`);
          break;
        case 'error':
          log('error', `worker stage=${m.stage}: ${m.message}`);
          break;
      }
    });

    worker.on('error', (err) => {
      log('error', `worker errored: ${err.message}`);
    });

    worker.on('exit', () => {
      workerReady = false;
      if (stopped) {
        log('info', 'worker exited (shutdown)');
        doneResolve();
        return;
      }
      const verdict = restartTracker.recordExit();
      if (verdict.escalate) {
        fatalExit(
          `SLIM worker exited ${verdict.recentExits}x within ${RESTART_WINDOW_MS}ms`,
        );
        return;
      }
      log(
        'warn',
        `SLIM worker exited unexpectedly — respawning (#${verdict.recentExits}) in ${RESTART_BACKOFF_MS}ms`,
      );
      setTimeout(() => {
        if (!stopped) spawn();
      }, RESTART_BACKOFF_MS);
    });
  }

  spawn();

  return {
    done,
    ready,
    isReady: () => workerReady && !stopped,
    shutdown: () => {
      stopped = true;
      const w = currentWorker;
      w?.postMessage({ type: 'shutdown' });
      // Give the worker a brief moment to drain, then terminate
      // unconditionally so the Verifier process can exit.
      setTimeout(() => void w?.terminate(), 250);
      // Settle `done` even if no worker is currently alive (e.g. shutdown
      // landed during the respawn backoff after an unexpected exit, so no
      // further 'exit' event will fire). resolve is idempotent, so a later
      // exit-handler doneResolve() is harmless.
      doneResolve();
    },
  };
}
