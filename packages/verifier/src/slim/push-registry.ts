// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier → Gateway registry push (Task 28).
 *
 * Sends control messages to the gateway's `spellguard/gateway/control`
 * SLIM name. We use a dedicated sender worker because every `*Async`
 * method in @agntcy/slim-bindings@1.4.0 is broken (missing liftError
 * generation) — only the synchronous methods actually work, and those
 * would block Node's HTTP event loop if called directly.
 *
 * The worker is the same code as the gateway's combined worker — we
 * import it from `@spellguard/gateway/slim-worker` (worker-only file,
 * no init code at module load time when imported normally).
 *
 * Behaviour parity with the previous direct-bindings implementation:
 *   • pushControlMessage(msg) returns { ok, error? }
 *   • Never throws; bindings-not-installed and unreachable control plane
 *     both fold into ok:false with descriptive error.
 */

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  GATEWAY_CONTROL_NAME,
  type GatewayControlMessage,
  decodeControlAck,
  encodeControlMessage,
} from '@spellguard/gateway/control';
import {
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  createRestartTracker,
  escalateProcessExit,
  failAllPending,
} from './worker-supervision';

export interface PushConfig {
  controlPlaneUrl: string;
  publisherName: { org: string; namespace: string; agent: string };
  sharedSecret: string;
  ackTimeoutMs?: number;
}

export function pushConfigFromEnv(): PushConfig {
  return {
    controlPlaneUrl:
      process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357',
    publisherName: {
      org: process.env.SPELLGUARD_SLIM_ORG ?? 'spellguard',
      namespace: process.env.SPELLGUARD_SLIM_NAMESPACE ?? 'verifier',
      agent: 'control-publisher',
    },
    sharedSecret:
      process.env.SLIM_SHARED_SECRET ??
      'spellguard-dev-shared-secret-needs-at-least-32-bytes',
    ackTimeoutMs:
      Number(process.env.SPELLGUARD_VERIFIER_PUSH_TIMEOUT_MS) || 5_000,
  };
}

export interface PushOutcome {
  ok: boolean;
  error?: string;
}

// We resolve the gateway worker file path via the package's main module
// path. The gateway exports `./slim-worker` so we can import as a normal
// module too, but Worker constructor needs a file path.
function resolveWorkerPath(): string {
  // Subpath export points at the hand-written .mjs worker — see
  // packages/gateway/src/slim-worker-host.ts comment for why we don't
  // use the .ts version here.
  // `createRequire` is constructed HERE, not at module top level, so importing
  // this module executes no Node-only code at load. That lets the module be
  // bundled into the Cloudflare verifier (which runs the `original` profile and
  // never spawns a SLIM worker); the Node-only call only runs in the Node slim
  // profile, when a worker is actually resolved.
  const require = createRequire(import.meta.url);
  return require.resolve('@spellguard/gateway/slim-worker');
}

interface WorkerHandle {
  ready: Promise<void>;
  send(msg: {
    destination: typeof GATEWAY_CONTROL_NAME;
    payload: Uint8Array;
  }): Promise<{
    ok: boolean;
    payload?: Uint8Array;
    error?: string;
  }>;
  shutdown(): void;
}

let workerPromise: Promise<WorkerHandle | null> | null = null;
// Supervision state shared across respawns (module-level on purpose): a
// control-push worker that keeps dying must escalate to a task replacement,
// same semantics as the endpoint listener's supervisor
// (worker-supervision.ts). Before this, a crashed/wedged worker stayed
// cached forever and registry pushes silently never reached the gateway
// until something else recycled the task.
const restartTracker = createRestartTracker();
let lastExitAt = 0;

async function getWorker(config: PushConfig): Promise<WorkerHandle | null> {
  if (workerPromise) return workerPromise;
  const promise: Promise<WorkerHandle | null> = (async () => {
    try {
      await import('@agntcy/slim-bindings');
    } catch {
      return null;
    }
    let workerPath: string;
    try {
      workerPath = resolveWorkerPath();
    } catch {
      return null;
    }
    // Lazy-respawn backoff: the senders respawn on next use (not eagerly),
    // so space respawns the same 2s the endpoint supervisor does — a
    // back-to-back push must not respawn hot into the same crash.
    const sinceExit = Date.now() - lastExitAt;
    if (lastExitAt > 0 && sinceExit < RESTART_BACKOFF_MS) {
      await new Promise((r) => setTimeout(r, RESTART_BACKOFF_MS - sinceExit));
    }
    const worker = new Worker(workerPath, {
      workerData: {
        controlPlaneUrl: config.controlPlaneUrl,
        identity: config.publisherName,
        sharedSecret: config.sharedSecret,
        listenNames: [],
        replyTimeoutMs: config.ackTimeoutMs ?? 5_000,
        // Co-located with the endpoint listener + send-to-agent in the Verifier
        // process; getGlobalService() allows only one connectAsync per process,
        // so this worker owns its own Service or its connect bricks with
        // "CALL_ERROR but no errorClass specified". See slim-worker.mjs.
        ownService: true,
      },
    });
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    const pending = new Map<
      string,
      (out: { ok: boolean; payload?: Uint8Array; error?: string }) => void
    >();
    let nextReq = 1;
    let stopped = false;
    // Set the instant this handle's worker is gone (deliberate shutdown OR an
    // unexpected exit). `send()` checks it so a push that loses the race to the
    // exit macrotask — registered into `pending` AFTER failAllPending already
    // drained it — fails fast instead of hanging FOREVER (there is no
    // per-request backstop timer on this path, unlike send-to-agent). That hang
    // would otherwise be cached by ensureGatewayRegistered's inflight map and
    // wedge all future delivery to the recipient.
    let exited = false;
    worker.on('message', (m: unknown) => {
      const msg = m as {
        type?: string;
        requestId?: string;
        ok?: boolean;
        payload?: Uint8Array;
        error?: string;
        reason?: string;
      };
      if (msg.type === 'ready') readyResolve();
      else if (msg.type === 'send-result' && msg.requestId) {
        const r = pending.get(msg.requestId);
        if (r) {
          pending.delete(msg.requestId);
          r({ ok: !!msg.ok, payload: msg.payload, error: msg.error });
        }
      } else if (msg.type === 'request-process-exit') {
        // The worker's wedge detector reports a state only a fresh process
        // recovers from (the bindings' Tokio thread survives a JS Worker
        // exit). Previously this signal was IGNORED here — the wedged
        // worker stayed cached and registry pushes silently died.
        escalateProcessExit(
          'verifier-control-push',
          `worker reported wedge: ${msg.reason ?? 'unspecified'}`,
        );
      }
    });
    worker.on('error', (e) => readyReject(e));
    worker.on('exit', () => {
      exited = true;
      if (stopped) {
        // Deliberate shutdown — just uncache, no respawn/escalation.
        if (workerPromise === promise) workerPromise = null;
        return;
      }
      lastExitAt = Date.now();
      // Fail in-flight pushes fast (never-throws contract → ok:false).
      // Unlike send-to-agent there is no per-request backstop timer here,
      // so without this they would hang FOREVER, not just slowly.
      const failed = failAllPending(pending, () => ({
        ok: false,
        error: 'SLIM control-push worker exited mid-send',
      }));
      // Drop the cached handle so the next push respawns a fresh worker.
      // Guarded so a stale exit can never clobber a newer respawn's cache.
      if (workerPromise === promise) workerPromise = null;
      const verdict = restartTracker.recordExit();
      if (verdict.escalate) {
        escalateProcessExit(
          'verifier-control-push',
          `worker exited ${verdict.recentExits}x within ${RESTART_WINDOW_MS}ms`,
        );
        return;
      }
      console.warn(
        `[verifier-control-push] worker exited unexpectedly (#${verdict.recentExits} in window, ${failed} in-flight failed) — next push respawns it`,
      );
    });
    const handle: WorkerHandle = {
      ready,
      send(input) {
        if (stopped || exited) {
          // The worker is already gone, so failAllPending has run (or will
          // never run, on the shutdown path). Registering into `pending` now
          // would never resolve — fail fast.
          return Promise.resolve({
            ok: false,
            error: 'SLIM control-push worker exited before send',
          });
        }
        const requestId = `r${nextReq++}`;
        return new Promise<{
          ok: boolean;
          payload?: Uint8Array;
          error?: string;
        }>((resolve) => {
          pending.set(requestId, resolve);
          worker.postMessage({
            type: 'send',
            requestId,
            destination: input.destination,
            payload: input.payload,
            payloadType: 'spellguard.control.req.v1',
            replyTimeoutMs: config.ackTimeoutMs,
          });
        });
      },
      shutdown() {
        stopped = true;
        worker.postMessage({ type: 'shutdown' });
        setTimeout(() => void worker.terminate(), 250);
      },
    };
    return handle;
  })().catch(() => {
    if (workerPromise === promise) workerPromise = null;
    return null;
  });
  workerPromise = promise;
  return promise;
}

export async function pushControlMessage(
  msg: GatewayControlMessage,
  config: PushConfig = pushConfigFromEnv(),
): Promise<PushOutcome> {
  const worker = await getWorker(config);
  if (!worker) {
    return {
      ok: false,
      error:
        '@agntcy/slim-bindings unavailable or worker unresolvable — control push skipped',
    };
  }
  try {
    await worker.ready;
  } catch (err) {
    return {
      ok: false,
      error: `worker not ready: ${(err as Error).message}`,
    };
  }
  const bytes = encodeControlMessage(msg);
  const result = await worker.send({
    destination: GATEWAY_CONTROL_NAME,
    payload: bytes,
  });
  if (!result.ok || !result.payload) {
    return {
      ok: false,
      error: result.error ?? 'gateway did not reply',
    };
  }
  try {
    const ack = decodeControlAck(result.payload);
    return {
      ok: ack.ok,
      error: ack.ok ? undefined : (ack.error ?? 'gateway rejected message'),
    };
  } catch (err) {
    return { ok: false, error: `decode failed: ${(err as Error).message}` };
  }
}

export function _resetForTesting(): void {
  workerPromise = null;
}
