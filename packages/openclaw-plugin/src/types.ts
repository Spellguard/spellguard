// SPDX-License-Identifier: Apache-2.0

import type { AgentCard } from '@spellguard/client';

/**
 * A tool definition registered by a plugin. The TypeBox parameter schema
 * lives alongside the definition (see `ToolBundle`); each tool's
 * `execute` performs its own input validation.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  execute: (input: unknown) => Promise<ToolResult<unknown>>;
}

// --- Shared result types ---

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | { [x: string]: JSONValue }
  | JSONValue[];

export type SpellguardErrorCode =
  | 'VERIFIER_UNAVAILABLE'
  | 'ATTESTATION_FAILED'
  | 'RECIPIENT_NOT_FOUND'
  | 'MESSAGE_REJECTED'
  | 'INVALID_INPUT'
  | 'CHANNEL_EXPIRED'
  | 'INTERNAL_ERROR';

export interface ToolSuccess<T> {
  success: true;
  data: T;
}

export interface ToolError {
  success: false;
  error: {
    code: SpellguardErrorCode;
    message: string;
  };
}

export type ToolResult<T> = ToolSuccess<T> | ToolError;

// --- Tool data interfaces ---

export interface RouteData {
  agentResponses: Array<{ agent: string; response: string }>;
  contextBlock: string | null;
}

export interface StatusData {
  configured: boolean;
  verifier: {
    status: 'healthy' | 'unhealthy' | 'unreachable';
    url: string;
  };
  self: {
    agentId: string;
    webhookUrl: string;
  };
  credential:
    | {
        source: 'socket';
        scopedTokenId: string;
        expiresAt: string;
        repos: string[];
        author: { name: string; email: string } | null;
      }
    | { source: 'none' };
}

export interface DiscoverData {
  agentCard: AgentCard;
}
