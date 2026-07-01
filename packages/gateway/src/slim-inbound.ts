// SPDX-License-Identifier: Apache-2.0

/**
 * Gateway inbound SLIM dispatcher (Task 27 + Task 28 control channel).
 *
 * Thin shim over the singleton worker host (./slim-worker-host.ts).
 * The worker subscribes to:
 *   • each agent slimName registered via /v1/register
 *   • the control name `spellguard/gateway/control` for Verifier-pushed
 *     registry updates
 *
 * On every inbound SLIM message the worker emits to the parent, this
 * file routes by destination name:
 *   • control name → register/unregister in the agent registry
 *   • anything else → POST the wire-encoded HTTP envelope to the
 *     destination agent's callbackUrl and return the response.
 */

import {
  lookupBySlimName,
  registerAgent as registerAgentInRegistry,
  unregisterAgent as unregisterAgentFromRegistry,
} from './agent-registry';
import {
  GATEWAY_CONTROL_NAME,
  decodeControlMessage,
  encodeControlAck,
} from './control';
import {
  type InboundEnvelope,
  type WorkerHost,
  getWorkerHost,
} from './slim-worker-host';
import {
  decodeRequest,
  encodeResponse,
  responseToWire,
  wireToRequest,
} from './wire';

/**
 * Default budget for the gateway → agent callbackUrl fetch on a delivered
 * inbound turn. The timeout chain on the SLIM-delivery leg must stay
 * ordered:
 *
 *   callback fetch 110s
 *     < worker inbound parent-reply timer (callback + 5s headroom)
 *     < verifier slim-delivery budget 120s
 *     < ALB idle timeout 150s (infra/lib/gateway-stack.ts)
 *
 * Raised from 30s: a delivered agent turn that legitimately ran >30s (LLM
 * call) failed deterministically while every surrounding budget allowed
 * 120s. The 5s headroom keeps the parent-reply timer (which starts BEFORE
 * the fetch does) from winning the race against the fetch abort, so a
 * too-slow agent surfaces as a clean 502 envelope back over SLIM instead
 * of a worker-side reply timeout.
 */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 110_000;
export const INBOUND_PARENT_REPLY_HEADROOM_MS = 5_000;

export interface GatewayInboundConfig {
  controlPlaneUrl: string;
  gatewayName: { org: string; namespace: string; agent: string };
  /** Verifier destination, used only to pre-warm the shared outbound
   *  session at worker boot (the inbound path creates the singleton
   *  worker first, so the pre-warm hint must travel through here too).
   *  Optional — when omitted, no pre-warm happens (e.g. in tests). */
  verifierName?: { org: string; namespace: string; agent: string };
  sharedSecret: string;
  callbackTimeoutMs?: number;
}

export function inboundConfigFromEnv(): GatewayInboundConfig {
  return {
    controlPlaneUrl:
      process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357',
    gatewayName: {
      org: process.env.SPELLGUARD_SLIM_GATEWAY_ORG ?? 'spellguard',
      namespace: process.env.SPELLGUARD_SLIM_GATEWAY_NS ?? 'gateway',
      agent: process.env.SPELLGUARD_SLIM_GATEWAY_AGENT ?? 'edge',
    },
    verifierName: {
      org: process.env.SPELLGUARD_SLIM_VERIFIER_ORG ?? 'spellguard',
      namespace: process.env.SPELLGUARD_SLIM_VERIFIER_NS ?? 'verifier',
      agent: process.env.SPELLGUARD_SLIM_VERIFIER_AGENT ?? 'server',
    },
    sharedSecret:
      process.env.SLIM_SHARED_SECRET ??
      'spellguard-dev-shared-secret-needs-at-least-32-bytes',
    callbackTimeoutMs:
      Number(process.env.SPELLGUARD_GATEWAY_CALLBACK_TIMEOUT_MS) ||
      DEFAULT_CALLBACK_TIMEOUT_MS,
  };
}

export interface GatewayListenerHandle {
  ready: Promise<void>;
  subscribeAgent: (slimName: string) => Promise<void>;
  done: Promise<void>;
  shutdown: () => void;
}

const CONTROL_NAME_STRING = `${GATEWAY_CONTROL_NAME.org}/${GATEWAY_CONTROL_NAME.namespace}/${GATEWAY_CONTROL_NAME.agent}`;

let activeHost: WorkerHost | null = null;

export async function startGatewayInbound(
  config: GatewayInboundConfig = inboundConfigFromEnv(),
  log: (level: 'info' | 'warn' | 'error', msg: string) => void = defaultLog,
): Promise<GatewayListenerHandle> {
  const host = await getWorkerHost(
    {
      controlPlaneUrl: config.controlPlaneUrl,
      identity: config.gatewayName,
      sharedSecret: config.sharedSecret,
      listenNames: [CONTROL_NAME_STRING],
      // The worker's inbound parent-reply timer. Must be >= the callback
      // budget (plus headroom — the timer starts before the fetch does) and
      // < the verifier's 120s slim-delivery budget; see the chain comment on
      // DEFAULT_CALLBACK_TIMEOUT_MS.
      replyTimeoutMs:
        (config.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS) +
        INBOUND_PARENT_REPLY_HEADROOM_MS,
      // The inbound path usually wins the race to create the singleton
      // worker, so it carries the pre-warm hint for the outbound session.
      prewarmDestination: config.verifierName,
    },
    log,
  );

  if (!host) {
    return {
      ready: Promise.resolve(),
      subscribeAgent: async () => undefined,
      done: Promise.resolve(),
      shutdown: () => undefined,
    };
  }
  activeHost = host;

  host.onInbound(async (envelope) => handleInbound(envelope, config, log));

  return {
    ready: host.ready,
    async subscribeAgent(slimName) {
      host.subscribe(slimName);
    },
    done: new Promise(() => undefined),
    shutdown() {
      host.shutdown();
    },
  };
}

async function handleInbound(
  envelope: InboundEnvelope,
  config: GatewayInboundConfig,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<Uint8Array> {
  if (!envelope.destination) {
    return encodeError(502, 'inbound message missing destinationName');
  }
  if (envelope.destination === CONTROL_NAME_STRING) {
    return handleControlMessage(envelope.payload, log);
  }
  return handleAgentDispatch(
    envelope.destination,
    envelope.payload,
    config,
    log,
  );
}

async function handleAgentDispatch(
  destinationName: string,
  payload: Uint8Array,
  config: GatewayInboundConfig,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<Uint8Array> {
  const reg = lookupBySlimName(destinationName);
  if (!reg) {
    log(
      'warn',
      `inbound dispatch: no registered agent for slimName=${destinationName}`,
    );
    return encodeError(
      404,
      `gateway has no registered agent for slimName=${destinationName}`,
    );
  }
  const wireRequest = decodeRequest(payload);
  const targetUrl = `${reg.callbackUrl.replace(/\/$/, '')}${wireRequest.path}`;
  try {
    const fetchRequest = wireToRequest({ ...wireRequest, path: '' }, targetUrl);
    const response = await fetch(fetchRequest, {
      signal: AbortSignal.timeout(
        config.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
      ),
    });
    const wireResponse = await responseToWire(response);
    return encodeResponse(wireResponse);
  } catch (err) {
    log(
      'error',
      `inbound POST to ${reg.callbackUrl} (agent=${reg.agentId}) failed: ${(err as Error).message}`,
    );
    return encodeError(
      502,
      `gateway → agent fetch failed: ${(err as Error).message}`,
    );
  }
}

function handleControlMessage(
  payload: Uint8Array,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Uint8Array {
  let msg: ReturnType<typeof decodeControlMessage>;
  try {
    msg = decodeControlMessage(payload);
  } catch (err) {
    log('error', `control decode failed: ${(err as Error).message}`);
    return encodeControlAck({
      ok: false,
      type: 'register',
      agentId: 'unknown',
      error: `decode failed: ${(err as Error).message}`,
    });
  }
  if (msg.type === 'register') {
    const reg = registerAgentInRegistry({
      agentId: msg.agentId,
      slimName: msg.slimName,
      callbackUrl: msg.callbackUrl,
    });
    activeHost?.subscribe(msg.slimName);
    log(
      'info',
      `control: registered agentId=${msg.agentId} slimName=${msg.slimName} (lastSeen=${reg.lastSeen})`,
    );
    return encodeControlAck({
      ok: true,
      type: 'register',
      agentId: msg.agentId,
    });
  }
  const removed = unregisterAgentFromRegistry(msg.agentId);
  log(
    'info',
    `control: unregister agentId=${msg.agentId} → ${removed ? 'removed' : 'not-found'}`,
  );
  return encodeControlAck({
    ok: removed,
    type: 'unregister',
    agentId: msg.agentId,
    error: removed ? undefined : 'agent not found in registry',
  });
}

function encodeError(status: number, message: string): Uint8Array {
  return encodeResponse({
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ error: message })).toString('base64'),
  });
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string): void {
  const prefix = `[gateway-inbound] ${msg}`;
  if (level === 'error') console.error(prefix);
  else if (level === 'warn') console.warn(prefix);
  else console.log(prefix);
}

export function _resetForTesting(): void {
  activeHost = null;
}
