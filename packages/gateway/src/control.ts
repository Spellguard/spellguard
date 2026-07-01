// SPDX-License-Identifier: Apache-2.0

/**
 * Gateway control-channel protocol.
 *
 * The Verifier publishes JSON-encoded control messages to the gateway's
 * `spellguard/gateway/control` SLIM name to update the gateway's local
 * agent registry. Today this lets the Verifier announce a newly-attested
 * agent — the gateway records the {agentId, slimName, callbackUrl} and
 * subscribes the slim name so inbound SLIM dispatch (Task 27) can route
 * messages addressed to that agent.
 *
 * Why a separate channel? In slim mode the agent's /v1/register HTTP
 * call already flows through the catchall route to the Verifier; the
 * Verifier is the source of truth for which agents exist and where
 * their callbacks live. The gateway used to keep its own local copy
 * (filled by the HTTP /v1/register handler); now the Verifier pushes
 * the same data to the gateway so the gateway never has to ask.
 *
 * Versioned `v: 1` envelope mirrors wire.ts so future additions
 * (delete, replace, capability bits) can land additively.
 */

export interface GatewayControlRegister {
  type: 'register';
  agentId: string;
  slimName: string;
  callbackUrl: string;
}

export interface GatewayControlUnregister {
  type: 'unregister';
  agentId: string;
}

export type GatewayControlMessage =
  | GatewayControlRegister
  | GatewayControlUnregister;

export interface GatewayControlAck {
  ok: boolean;
  type: GatewayControlMessage['type'];
  agentId: string;
  error?: string;
}

const CONTROL_VERSION = 1 as const;

interface ControlEnvelope<T> {
  v: typeof CONTROL_VERSION;
  payload: T;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8');

export function encodeControlMessage(msg: GatewayControlMessage): Uint8Array {
  const envelope: ControlEnvelope<GatewayControlMessage> = {
    v: CONTROL_VERSION,
    payload: msg,
  };
  return TEXT_ENCODER.encode(JSON.stringify(envelope));
}

export function decodeControlMessage(bytes: Uint8Array): GatewayControlMessage {
  const envelope = JSON.parse(
    TEXT_DECODER.decode(bytes),
  ) as ControlEnvelope<GatewayControlMessage>;
  if (envelope.v !== CONTROL_VERSION) {
    throw new Error(
      `gateway control envelope version mismatch: got ${envelope.v}, expected ${CONTROL_VERSION}`,
    );
  }
  return envelope.payload;
}

export function encodeControlAck(ack: GatewayControlAck): Uint8Array {
  const envelope: ControlEnvelope<GatewayControlAck> = {
    v: CONTROL_VERSION,
    payload: ack,
  };
  return TEXT_ENCODER.encode(JSON.stringify(envelope));
}

export function decodeControlAck(bytes: Uint8Array): GatewayControlAck {
  const envelope = JSON.parse(
    TEXT_DECODER.decode(bytes),
  ) as ControlEnvelope<GatewayControlAck>;
  if (envelope.v !== CONTROL_VERSION) {
    throw new Error(
      `gateway control ack version mismatch: got ${envelope.v}, expected ${CONTROL_VERSION}`,
    );
  }
  return envelope.payload;
}

/** The SLIM name segments the gateway's control channel listens on. */
export const GATEWAY_CONTROL_NAME = {
  org: 'spellguard',
  namespace: 'gateway',
  agent: 'control',
} as const;
