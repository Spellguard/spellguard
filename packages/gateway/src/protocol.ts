// SPDX-License-Identifier: Apache-2.0

/**
 * Wire types for the Spellguard SLIM gateway protocol v0.1.
 * See ../PROTOCOL.md for semantics.
 */

export interface AgentRef {
  agentId: string;
  slimName?: string;
}

export interface GatewaySecureMessage {
  id: string;
  sender: string;
  recipient: string;
  encryptedPayload: string;
  timestamp: number;
}

// ─── Client → gateway frames ─────────────────────────────────────────

export interface HelloFrame {
  type: 'hello';
  agentId: string;
  slimName: string;
  version: string;
}

export interface SendFrame {
  type: 'send';
  requestId: string;
  to: AgentRef;
  message: GatewaySecureMessage;
}

export interface InboundAckFrame {
  type: 'inbound-ack';
  requestId: string;
  message: GatewaySecureMessage;
}

export interface PingFrame {
  type: 'ping';
}

export interface CloseFrame {
  type: 'close';
}

export type ClientFrame =
  | HelloFrame
  | SendFrame
  | InboundAckFrame
  | PingFrame
  | CloseFrame;

// ─── Gateway → client frames ─────────────────────────────────────────

export interface WelcomeFrame {
  type: 'welcome';
  agentId: string;
  version: string;
  controlPlane: string;
}

export interface InboundFrame {
  type: 'inbound';
  requestId: string;
  from: AgentRef;
  message: GatewaySecureMessage;
}

export interface SendResultFrame {
  type: 'send-result';
  requestId: string;
  message: GatewaySecureMessage;
}

export interface PongFrame {
  type: 'pong';
  uptimeMs: number;
}

export type ErrorCode =
  | 'not-implemented'
  | 'agent-not-found'
  | 'version-mismatch'
  | 'invalid-frame'
  | 'internal'
  | 'bindings-unavailable'
  | 'control-plane-unreachable'
  | 'real-mode-partial';

export interface ErrorFrame {
  type: 'error';
  requestId?: string;
  code: ErrorCode;
  message: string;
}

export type GatewayFrame =
  | WelcomeFrame
  | InboundFrame
  | SendResultFrame
  | PongFrame
  | ErrorFrame;

// ─── Constructor helpers ─────────────────────────────────────────────

export const gatewayFrame = {
  welcome: (
    agentId: string,
    version: string,
    controlPlane: string,
  ): WelcomeFrame => ({
    type: 'welcome',
    agentId,
    version,
    controlPlane,
  }),
  inbound: (
    requestId: string,
    from: AgentRef,
    message: GatewaySecureMessage,
  ): InboundFrame => ({ type: 'inbound', requestId, from, message }),
  sendResult: (
    requestId: string,
    message: GatewaySecureMessage,
  ): SendResultFrame => ({ type: 'send-result', requestId, message }),
  pong: (uptimeMs: number): PongFrame => ({ type: 'pong', uptimeMs }),
  error: (
    requestId: string | undefined,
    code: ErrorFrame['code'],
    message: string,
  ): ErrorFrame => ({ type: 'error', requestId, code, message }),
};
