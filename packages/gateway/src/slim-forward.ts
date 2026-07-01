// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP-over-SLIM forward path for the Gateway.
 *
 * Agents POST to the gateway over HTTP; for each request we serialise
 * the entire HTTP envelope (see ./wire.ts), hand it to the SLIM worker
 * to publish toward the Verifier, await the reply, and decode it.
 *
 * Everything bindings-related runs in `./slim-worker.ts` via
 * `./slim-worker-host.ts`. This file is a thin main-thread shim that
 * builds the wire payload and translates the worker's structured
 * SendOutcome into a fetch Response (or a 502 with diagnostics).
 */

import { getWorkerHost } from './slim-worker-host';
import {
  type SlimHttpResponse,
  bytesToBase64,
  decodeResponse,
  encodeRequest,
} from './wire';

export interface GatewayForwardConfig {
  controlPlaneUrl: string;
  verifierName: { org: string; namespace: string; agent: string };
  gatewayName: { org: string; namespace: string; agent: string };
  sharedSecret: string;
  replyTimeoutMs?: number;
}

export function gatewayConfigFromEnv(): GatewayForwardConfig {
  return {
    controlPlaneUrl:
      process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357',
    verifierName: {
      org: process.env.SPELLGUARD_SLIM_VERIFIER_ORG ?? 'spellguard',
      namespace: process.env.SPELLGUARD_SLIM_VERIFIER_NS ?? 'verifier',
      agent: process.env.SPELLGUARD_SLIM_VERIFIER_AGENT ?? 'server',
    },
    gatewayName: {
      org: process.env.SPELLGUARD_SLIM_GATEWAY_ORG ?? 'spellguard',
      namespace: process.env.SPELLGUARD_SLIM_GATEWAY_NS ?? 'gateway',
      agent: process.env.SPELLGUARD_SLIM_GATEWAY_AGENT ?? 'edge',
    },
    sharedSecret:
      process.env.SLIM_SHARED_SECRET ??
      'spellguard-dev-shared-secret-needs-at-least-32-bytes',
    // 120s default covers LLM-bearing /messages/send round-trips
    // (verifier routes the message to the destination agent, which
    // may run an LLM call — observed ~65s in practice). The wedge
    // detector still bounds total damage (5 consecutive transport
    // failures → process exit), so a long timeout doesn't risk
    // permanent wedge.
    replyTimeoutMs:
      Number(process.env.SPELLGUARD_GATEWAY_REPLY_TIMEOUT_MS) || 120_000,
  };
}

export interface ForwardOutcome {
  ok: boolean;
  response?: SlimHttpResponse;
  error?: { code: string; message: string };
}

export async function forwardOverSlim(
  request: Request,
  config: GatewayForwardConfig = gatewayConfigFromEnv(),
  opts?: { replyTimeoutMsOverride?: number },
): Promise<ForwardOutcome> {
  const host = await getWorkerHost(
    {
      controlPlaneUrl: config.controlPlaneUrl,
      identity: config.gatewayName,
      sharedSecret: config.sharedSecret,
      listenNames: [],
      replyTimeoutMs: config.replyTimeoutMs ?? 120_000,
      // If the forward path wins the race to create the singleton worker
      // (e.g. inbound start lagged), carry the pre-warm hint here too so
      // the verifier session is established before the first agent burst.
      prewarmDestination: config.verifierName,
    },
    defaultLog,
  );
  if (!host) {
    return {
      ok: false,
      error: {
        code: 'bindings-unavailable',
        message:
          '@agntcy/slim-bindings not installed on this gateway — SLIM worker disabled',
      },
    };
  }
  // Bound the wait on host.ready. The worker's `ready` promise only ever
  // resolves (on 'ready') and never rejects — a boot-time init/connect
  // failure leaves it pending forever (the worker's message listener keeps
  // the thread alive). Without this race, every forward and every /ready
  // probe would hang until the client's own AbortSignal fired (a confusing
  // TimeoutError). The worker also asks the host to recycle the process on
  // init failure, so a fresh boot recovers; this just bounds the per-request
  // wait. Use the readiness-probe override when present so /ready stays snappy.
  const readyTimeoutMs =
    opts?.replyTimeoutMsOverride ??
    (Number(process.env.SPELLGUARD_GATEWAY_READY_TIMEOUT_MS) || 8_000);
  try {
    await Promise.race([
      host.ready,
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`worker not ready within ${readyTimeoutMs}ms`)),
          readyTimeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'worker-not-ready',
        message: `SLIM worker not ready: ${(err as Error).message}`,
      },
    };
  }

  const url = new URL(request.url);
  const bodyBytes =
    request.method === 'GET' || request.method === 'HEAD'
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());

  const wireRequest = {
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers: headersToObject(request.headers),
    body: bytesToBase64(bodyBytes),
  };

  // Tier the reply budget by route. LLM-bearing message routes relay to
  // the destination agent's model and legitimately run ~65s; control-
  // plane routes (attestation / register / tools-check / discover) are
  // sub-second on a healthy verifier, so a long wait there means the
  // session is wedged, not busy. A tight control-plane budget turns that
  // into a fast 502 (well under the client's 60s attestation abort)
  // instead of pinning the worker thread for the full 120s.
  const isLlmRoute =
    url.pathname.includes('/messages/send') ||
    url.pathname.includes('/messages/unilateral');
  const replyTimeoutMs =
    opts?.replyTimeoutMsOverride ??
    (isLlmRoute
      ? (config.replyTimeoutMs ?? 120_000)
      : Number(process.env.SPELLGUARD_GATEWAY_CONTROL_REPLY_TIMEOUT_MS) ||
        25_000);

  const outcome = await host.send({
    destination: config.verifierName,
    payload: encodeRequest(wireRequest),
    payloadType: 'spellguard.http.req.v1',
    replyTimeoutMs,
  });
  if (!outcome.ok || !outcome.payload) {
    return {
      ok: false,
      error: outcome.error ?? { code: 'unknown', message: 'no payload' },
    };
  }
  try {
    const response = decodeResponse(outcome.payload);
    return { ok: true, response };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'decode-failed',
        message: `failed to decode reply: ${(err as Error).message}`,
      },
    };
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string): void {
  const prefix = `[gateway-forward] ${msg}`;
  if (level === 'error') console.error(prefix);
  else if (level === 'warn') console.warn(prefix);
  else console.log(prefix);
}

export function _resetForTesting(): void {
  // No-op: the worker host owns the singleton; tests reset it via
  // getWorkerHost's _resetForTesting.
}
