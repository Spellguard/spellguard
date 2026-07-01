// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier → recipient-agent message delivery over SLIM (Task 27).
 *
 * The bilateral router used to deliver to a slim-profile recipient via the
 * amp `SlimTransport` (a WebSocket `{type:'send'}` frame to the gateway's
 * legacy `dispatchSend`, which is a scaffold that never completes). That left
 * verifier→agent delivery broken whenever a recipient carried a slimName —
 * i.e. exactly the no-Management / AGNTCY-dir path. This module replaces it.
 *
 * We publish an HTTP-over-SLIM request (the SAME `@spellguard/gateway/wire`
 * envelope the gateway uses for agent→verifier forwards) addressed to the
 * recipient's slimName. The gateway — which subscribed to that slimName on
 * the agent's behalf when the Verifier pushed its registry entry — receives
 * it on its inbound listener, POSTs the body to the agent's
 * `/_spellguard/receive` callback, and publishes the agent's HTTP response
 * back as the SLIM reply. So the gateway side needs no change; this is the
 * verifier-side sender that was missing.
 *
 * Mirrors `push-registry.ts` (same worker file, same handle pattern) with
 * three differences: an arbitrary per-send destination (the recipient, not a
 * fixed control name), the `spellguard.http.req.v1` payload type, and the
 * 120s `msg` lane (the recipient may run a full LLM turn). It never throws —
 * bindings-missing, unreachable data plane, and a wedged worker all fold into
 * `{ ok: false, error }`.
 */

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  type SlimHttpResponse,
  bytesToBase64,
  decodeResponse,
  encodeRequest,
} from '@spellguard/gateway/wire';
import { buildAgentDeliveryBody } from '../proxy/delivery-encryption';
import {
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  createRestartTracker,
  escalateProcessExit,
  failAllPending,
} from './worker-supervision';

export interface SendToAgentConfig {
  controlPlaneUrl: string;
  publisherName: { org: string; namespace: string; agent: string };
  sharedSecret: string;
  /** Reply budget. Must be >= 60s so the worker routes to the concurrent
   *  'msg' lane (laneFor in slim-worker.mjs), not the serialized 'ctl' lane. */
  replyTimeoutMs: number;
}

export function sendToAgentConfigFromEnv(): SendToAgentConfig {
  return {
    controlPlaneUrl:
      process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357',
    publisherName: {
      org: process.env.SPELLGUARD_SLIM_ORG ?? 'spellguard',
      namespace: process.env.SPELLGUARD_SLIM_NAMESPACE ?? 'verifier',
      // Distinct from push-registry's 'control-publisher' so the two verifier
      // worker Apps don't register the same SLIM identity on the control plane.
      agent: 'message-publisher',
    },
    sharedSecret:
      process.env.SLIM_SHARED_SECRET ??
      'spellguard-dev-shared-secret-needs-at-least-32-bytes',
    // Own knob, NOT SPELLGUARD_VERIFIER_FORWARD_TIMEOUT_MS: the router's
    // HTTP delivery leg reads that var with a deliberately staggered 110s
    // default (just under the 120s SLIM reply budgets). While this leg
    // shared the var, setting it collapsed the 110<120 stagger.
    replyTimeoutMs:
      Number(process.env.SPELLGUARD_VERIFIER_SLIM_DELIVERY_TIMEOUT_MS) ||
      120_000,
  };
}

export interface SendToAgentResult {
  ok: boolean;
  /** Parsed JSON of the agent's reply body (or raw text if not JSON). */
  response?: unknown;
  error?: string;
  /**
   * Worker-side failure class, surfaced so callers can retry SAFELY.
   * `'session-failed'` means createSession found no subscriber — the message
   * never reached the agent, so re-delivery is safe. Any other code may have
   * reached the agent already (don't blindly retry).
   */
  errorCode?: string;
}

function resolveWorkerPath(): string {
  // `createRequire` is built HERE, not at module top level, so importing this
  // module executes no Node-only code at load — safe to bundle into the
  // Cloudflare verifier (original profile). The resolve only runs when a SLIM
  // worker is actually spawned (Node slim profile).
  const require = createRequire(import.meta.url);
  return require.resolve('@spellguard/gateway/slim-worker');
}

interface SendDestination {
  org: string;
  namespace: string;
  agent: string;
}

interface WorkerHandle {
  ready: Promise<void>;
  send(input: {
    destination: SendDestination;
    payload: Uint8Array;
    replyTimeoutMs: number;
  }): Promise<{
    ok: boolean;
    payload?: Uint8Array;
    error?: string;
    errorCode?: string;
  }>;
  shutdown(): void;
}

let workerPromise: Promise<WorkerHandle | null> | null = null;
// Supervision state shared across respawns (module-level on purpose): a
// sender worker that keeps dying must escalate to a task replacement, same
// semantics as the endpoint listener's supervisor (worker-supervision.ts).
// Before this, a crashed/wedged sender worker stayed cached forever and
// permanently broke verifier→agent delivery until something else recycled
// the task.
const restartTracker = createRestartTracker();
let lastExitAt = 0;

async function getWorker(
  config: SendToAgentConfig,
): Promise<WorkerHandle | null> {
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
    // back-to-back send must not respawn hot into the same crash.
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
        replyTimeoutMs: config.replyTimeoutMs,
        // This is the Verifier's 2nd/3rd SLIM app (the endpoint listener is the
        // 1st). getGlobalService() permits only ONE connectAsync per process,
        // so without an own Service this connect throws "CALL_ERROR but no
        // errorClass specified" and verifier→agent delivery silently never
        // starts. See slim-worker.mjs.
        ownService: true,
        // No prewarmDestination: recipients vary, so the msg pool builds a
        // session per destination on first send (serialized by the worker's
        // session-create lock, so no session_moderator race). prewarmWithRetry
        // returns early when prewarmDestination is unset, so this sender worker
        // does not recycle on "never paired".
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
      (out: {
        ok: boolean;
        payload?: Uint8Array;
        error?: string;
        errorCode?: string;
      }) => void
    >();
    let nextReq = 1;
    let stopped = false;
    // Set the instant this handle's worker is gone. `send()` checks it so a
    // send that loses the race to the exit macrotask fails fast instead of
    // sitting on its backstop timer for the full reply budget (~125s) — the
    // per-request backstop below still bounds it, but failing fast is correct
    // and matches push-registry.
    let exited = false;
    worker.on('message', (m: unknown) => {
      const msg = m as {
        type?: string;
        requestId?: string;
        ok?: boolean;
        payload?: Uint8Array;
        error?: string;
        errorCode?: string;
        reason?: string;
      };
      if (msg.type === 'ready') readyResolve();
      else if (msg.type === 'send-result' && msg.requestId) {
        const r = pending.get(msg.requestId);
        if (r) {
          pending.delete(msg.requestId);
          r({
            ok: !!msg.ok,
            payload: msg.payload,
            error: msg.error,
            errorCode: msg.errorCode,
          });
        }
      } else if (msg.type === 'request-process-exit') {
        // The worker's wedge detector reports a state only a fresh process
        // recovers from (the bindings' Tokio thread survives a JS Worker
        // exit). Previously this signal was IGNORED here — the wedged
        // sender stayed cached and delivery silently died.
        escalateProcessExit(
          'verifier-slim-sender',
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
      // Fail in-flight sends fast (the module's never-throws contract folds
      // this into ok:false) instead of leaving each to hang until its
      // backstop timer fires.
      const failed = failAllPending(pending, () => ({
        ok: false,
        error: 'SLIM sender worker exited mid-send',
        // NOT 'session-failed': the message may have reached the agent, so
        // the router must not blindly re-deliver.
        errorCode: 'worker-exited',
      }));
      // Drop the cached handle so the next send respawns a fresh worker.
      // Guarded so a stale exit can never clobber a newer respawn's cache.
      if (workerPromise === promise) workerPromise = null;
      const verdict = restartTracker.recordExit();
      if (verdict.escalate) {
        escalateProcessExit(
          'verifier-slim-sender',
          `worker exited ${verdict.recentExits}x within ${RESTART_WINDOW_MS}ms`,
        );
        return;
      }
      console.warn(
        `[verifier-slim-sender] worker exited unexpectedly (#${verdict.recentExits} in window, ${failed} in-flight failed) — next send respawns it`,
      );
    });
    const handle: WorkerHandle = {
      ready,
      send(input) {
        if (stopped || exited) {
          // The worker is already gone — fail fast rather than arming a
          // backstop timer that would resolve only after the full reply budget.
          return Promise.resolve({
            ok: false,
            error: 'SLIM sender worker exited before send',
            errorCode: 'worker-exited',
          });
        }
        const requestId = `m${nextReq++}`;
        return new Promise<{
          ok: boolean;
          payload?: Uint8Array;
          error?: string;
          errorCode?: string;
        }>((resolve) => {
          // Main-thread backstop: the worker's getMessage reply-wait is a
          // blocking call, so a wedged data plane would otherwise hang this
          // send forever (the router no longer wraps it in an AbortSignal).
          // Resolve a few seconds past the worker's own budget. Mirrors the
          // gateway host's backstop (slim-worker-host.ts).
          const budgetMs = input.replyTimeoutMs + 5_000;
          const timer = setTimeout(() => {
            if (!pending.has(requestId)) return;
            pending.delete(requestId);
            resolve({
              ok: false,
              error: `SLIM send exceeded ${budgetMs}ms (worker thread likely wedged)`,
            });
          }, budgetMs);
          pending.set(requestId, (out) => {
            clearTimeout(timer);
            resolve(out);
          });
          worker.postMessage({
            type: 'send',
            requestId,
            destination: input.destination,
            payload: input.payload,
            payloadType: 'spellguard.http.req.v1',
            replyTimeoutMs: input.replyTimeoutMs,
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

/**
 * Deliver a bilateral message to a recipient agent over SLIM and return the
 * agent's reply. `recipientSlimName` MUST be a 3-component `org/namespace/agent`
 * name — the same shape the gateway subscribes (slim-worker.mjs doSubscribe
 * requires exactly 3 parts) and that the Verifier publishes for agents.
 */
export async function sendMessageToAgentOverSlim(
  recipientSlimName: string,
  secureMessage: { id: string; sender: string; timestamp: number },
  decryptedMessage: unknown,
  channelToken: string,
  recipientPublicKey?: string,
  config: SendToAgentConfig = sendToAgentConfigFromEnv(),
): Promise<SendToAgentResult> {
  const parts = recipientSlimName.split('/');
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `recipient slimName must be 3-component org/namespace/agent, got "${recipientSlimName}"`,
    };
  }
  const destination: SendDestination = {
    org: parts[0],
    namespace: parts[1],
    agent: parts[2],
  };

  const worker = await getWorker(config);
  if (!worker) {
    return {
      ok: false,
      error:
        '@agntcy/slim-bindings unavailable or worker unresolvable — SLIM delivery skipped',
    };
  }
  try {
    await worker.ready;
  } catch (err) {
    return { ok: false, error: `worker not ready: ${(err as Error).message}` };
  }

  // Build the HTTP-over-SLIM request the gateway's inbound dispatcher decodes
  // (decodeRequest) and POSTs to callbackUrl + path. Body shape matches the
  // HTTP delivery path's body exactly (router.ts) so the agent's
  // /_spellguard/receive handler reads it identically.
  const bodyJson = JSON.stringify(
    buildAgentDeliveryBody(decryptedMessage, secureMessage, recipientPublicKey),
  );
  const payload = encodeRequest({
    method: 'POST',
    path: '/_spellguard/receive',
    headers: {
      'content-type': 'application/json',
      'x-spellguard-channel-token': channelToken,
    },
    body: bytesToBase64(new TextEncoder().encode(bodyJson)),
  });

  const result = await worker.send({
    destination,
    payload,
    replyTimeoutMs: config.replyTimeoutMs,
  });
  if (!result.ok || !result.payload) {
    return {
      ok: false,
      error: result.error ?? 'gateway did not reply',
      errorCode: result.errorCode,
    };
  }
  try {
    const res: SlimHttpResponse = decodeResponse(result.payload);
    const text = Buffer.from(res.body, 'base64').toString('utf-8');
    if (res.status >= 400) {
      return {
        ok: false,
        error: `recipient/gateway returned HTTP ${res.status}: ${text.slice(0, 500)}`,
      };
    }
    try {
      return { ok: true, response: JSON.parse(text) };
    } catch {
      return { ok: true, response: text };
    }
  } catch (err) {
    return { ok: false, error: `decode failed: ${(err as Error).message}` };
  }
}

export function _resetForTesting(): void {
  workerPromise = null;
}
