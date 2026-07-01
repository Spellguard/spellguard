// SPDX-License-Identifier: Apache-2.0

/**
 * Main-thread host for the singleton SLIM worker (`./slim-worker.ts`).
 *
 * One worker per gateway process owns the @agntcy/slim-bindings App,
 * the connection, and all subscriptions. This module hands out a
 * `WorkerHost` that bridges request/reply RPCs and inbound-message
 * subscriptions to/from the worker. slim-forward.ts and slim-inbound.ts
 * both consume the same singleton so we get one bindings connection,
 * one App, one subscription set.
 *
 * If the bindings module isn't installed (no native binary for the
 * host platform), `getWorkerHost()` returns null and callers fall
 * back to their graceful no-op paths.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface WorkerHostConfig {
  controlPlaneUrl: string;
  identity: { org: string; namespace: string; agent: string };
  sharedSecret: string;
  /** Initial subscriptions. Use subscribe() to add more later. */
  listenNames: string[];
  /** Per-inbound timeout for the parent handler. */
  replyTimeoutMs: number;
  /**
   * Destination to pre-establish an outbound session to at worker boot.
   * The first concurrent burst of agent registrations otherwise each
   * race a cold createSessionAndWait against the same destination — the
   * exact concurrency that trips the upstream session_moderator panic
   * (session_moderator.rs:671/:748, commit c52ce29d). Pre-warming one
   * session means they reuse it instead. Optional; omitted by callers
   * that only listen (no outbound sends).
   */
  prewarmDestination?: { org: string; namespace: string; agent: string };
}

export interface InboundEnvelope {
  tag: string;
  source: string;
  destination: string;
  payloadType: string | undefined;
  payload: Uint8Array;
}

export type InboundHandler = (msg: InboundEnvelope) => Promise<Uint8Array>;

export interface SendInput {
  destination: { org: string; namespace: string; agent: string };
  payload: Uint8Array;
  payloadType?: string;
  replyTimeoutMs?: number;
}

export interface SendOutcome {
  ok: boolean;
  payload?: Uint8Array;
  error?: { code: string; message: string };
}

export interface WorkerHost {
  ready: Promise<void>;
  subscribe(name: string): void;
  /** Register the handler invoked for each inbound SLIM message. */
  onInbound(handler: InboundHandler): void;
  send(input: SendInput): Promise<SendOutcome>;
  shutdown(): void;
}

// Worker is hand-written .mjs (not .ts) so it can be spawned with plain
// node — tsx can't strip TypeScript inside node_modules and
// @agntcy/slim-bindings transitively imports a .ts file from
// uniffi-bindgen-react-native that Node 24 refuses to strip.
const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'slim-worker.mjs',
);

// Headroom added to the worker's own reply budget before the host-side
// backstop fires. Must exceed a single in-band session rebuild: on the
// dead-cached-session path the worker now tears down and re-creates the
// SLIM session (createSessionAndWaitAsync — the discovery+join handshake)
// BEFORE its reply wait, and that handshake is slowest during the exact
// verifier-recovery window the retry exists to absorb. With only ~5s the
// backstop could fire mid-rebuild and surface a 502 for a send that was
// about to succeed — defeating the retry. 15s covers a worst-case
// handshake (gateway ready-timeout default 8s) plus margin, and msg-lane
// 120s + 15s = 135s stays under the 150s ALB idle timeout.
const SEND_BACKSTOP_HEADROOM_MS = 15_000;

let singleton: WorkerHost | null = null;
// In-flight creation promise. getWorkerHost must be safe to call
// concurrently — the inbound listener, the forward path, and /ready can
// all race it at boot. Without memoizing the in-flight creation, two
// callers that both observe singleton===null before the first `await`
// would each spawn a Worker: two Apps on the same gateway identity and
// two concurrent cold createSessionAndWait against the verifier — exactly
// the ≥2-concurrent-session condition that trips the upstream
// session_moderator panic this whole change exists to avoid.
let creating: Promise<WorkerHost | null> | null = null;

export function getWorkerHost(
  config: WorkerHostConfig,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<WorkerHost | null> {
  if (singleton) return Promise.resolve(singleton);
  if (creating) return creating;
  // Assign `creating` synchronously (no await before this point) so a
  // concurrent caller in a later turn sees it and shares the one spawn.
  creating = createWorkerHost(config, log)
    .then((host) => {
      if (host) singleton = host;
      // Clear the in-flight marker. A null result (no bindings) lets a
      // later call retry; a host result hands off to the singleton path.
      creating = null;
      return host;
    })
    .catch((err) => {
      creating = null;
      throw err;
    });
  return creating;
}

async function createWorkerHost(
  config: WorkerHostConfig,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<WorkerHost | null> {
  // Check that bindings are present before spawning a worker that will
  // just crash with ERR_MODULE_NOT_FOUND.
  try {
    await import('@agntcy/slim-bindings');
  } catch (err) {
    log(
      'warn',
      `@agntcy/slim-bindings not installed (${(err as Error).message}). SLIM worker disabled.`,
    );
    return null;
  }

  const worker = new Worker(WORKER_PATH, {
    workerData: config,
  });

  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  let inboundHandler: InboundHandler | null = null;
  const pendingSends = new Map<string, (outcome: SendOutcome) => void>();
  let nextRequestId = 1;

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
      name?: string;
      requestId?: string;
      ok?: boolean;
      error?: string;
      errorCode?: string;
    };
    if (m.type === 'ready') {
      readyResolve();
    } else if (m.type === 'subscribed') {
      log('info', `subscribed: ${m.name}`);
    } else if (m.type === 'inbound' && m.tag && m.payload) {
      if (!inboundHandler) {
        // Reply with an empty body so the worker doesn't time out.
        worker.postMessage({
          type: 'reply',
          tag: m.tag,
          payload: new Uint8Array(),
        });
        return;
      }
      void inboundHandler({
        tag: m.tag,
        source: m.source ?? '',
        destination: m.destination ?? '',
        payloadType: m.payloadType || undefined,
        payload: m.payload,
      })
        .then((reply) => {
          worker.postMessage({ type: 'reply', tag: m.tag, payload: reply });
        })
        .catch((err: unknown) => {
          log(
            'error',
            `inbound handler threw: ${(err as Error)?.message ?? String(err)}`,
          );
          worker.postMessage({
            type: 'reply',
            tag: m.tag,
            payload: new Uint8Array(),
          });
        });
    } else if (m.type === 'send-result' && m.requestId) {
      const resolver = pendingSends.get(m.requestId);
      if (!resolver) return;
      pendingSends.delete(m.requestId);
      resolver({
        ok: !!m.ok,
        payload: m.payload,
        error: m.ok
          ? undefined
          : {
              code: m.errorCode ?? 'unknown',
              message: m.error ?? 'no error message',
            },
      });
    } else if (m.type === 'error') {
      log('error', `worker stage=${m.stage}: ${m.message}`);
    } else if (
      (m as { type?: string; reason?: string }).type === 'request-process-exit'
    ) {
      // Worker has detected a wedged state it cannot recover from
      // (upstream slim-bindings panic). Take down the whole process
      // so ECS replaces the task with a fresh one. This is heavier
      // than respawning just the worker thread, but the bindings'
      // panic appears to be in a Tokio runtime thread that survives
      // a JS Worker exit — only a fresh process recovers cleanly.
      const reason = (m as { reason?: string }).reason ?? 'unspecified';
      log('error', `worker requested process exit: ${reason}`);
      // Small delay so the log line flushes before exit.
      setTimeout(() => process.exit(1), 100);
    }
  });

  worker.on('error', (err) => {
    log('error', `worker errored: ${err.message}`);
    readyReject(err);
  });

  worker.on('exit', () => {
    log('info', 'worker exited');
    // Clear both so the next getWorkerHost call respawns a fresh worker
    // (and isn't pinned to a dead in-flight promise).
    singleton = null;
    creating = null;
  });

  const host: WorkerHost = {
    ready,
    subscribe(name) {
      worker.postMessage({ type: 'subscribe', name });
    },
    onInbound(handler) {
      inboundHandler = handler;
    },
    send(input) {
      const requestId = `r${nextRequestId++}`;
      return new Promise<SendOutcome>((resolve) => {
        // Host-side backstop timeout. handleSend's getMessage is a SYNC
        // blocking call, so a wedged data plane parks the worker thread
        // and 'send-result' never arrives. Without this, send() hangs
        // until the *client's* AbortSignal fires — surfacing as a
        // confusing "TimeoutError" on the agent instead of a clean 502.
        // Resolve with a transport error a few seconds past the worker's
        // own reply budget so the HTTP catchall returns a fast 502 and
        // the caller (and ALB /ready) sees a definite failure.
        //
        // CAVEAT (symptom-masking): handleSend's getMessage is SYNC, so a
        // wedged worker thread stays parked even after this backstop fires
        // — subsequent sends queue behind it. This gives the *caller* a
        // fast, clean failure but does not free worker throughput. The
        // real fix is to make the outbound path async (publishAndWaitAsync
        // / getMessageAsync), mirroring the inbound loop (commit 5714ba7a);
        // that's deferred to the runtime-separation phase because async
        // outbound risks re-entering the session_moderator race the sync
        // serialization was added to dodge, and needs a staging soak.
        const budgetMs =
          (input.replyTimeoutMs ?? config.replyTimeoutMs) +
          SEND_BACKSTOP_HEADROOM_MS;
        const timer = setTimeout(() => {
          if (!pendingSends.has(requestId)) return;
          pendingSends.delete(requestId);
          resolve({
            ok: false,
            error: {
              code: 'send-timeout',
              message: `SLIM send exceeded ${budgetMs}ms (worker thread likely wedged)`,
            },
          });
        }, budgetMs);
        pendingSends.set(requestId, (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
        worker.postMessage({
          type: 'send',
          requestId,
          destination: input.destination,
          payload: input.payload,
          payloadType: input.payloadType,
          replyTimeoutMs: input.replyTimeoutMs,
        });
      });
    },
    shutdown() {
      worker.postMessage({ type: 'shutdown' });
      setTimeout(() => void worker.terminate(), 250);
    },
  };

  // singleton is assigned by the getWorkerHost wrapper once this resolves.
  return host;
}

export function _resetForTesting(): void {
  if (singleton) {
    singleton.shutdown();
    singleton = null;
  }
  creating = null;
}
