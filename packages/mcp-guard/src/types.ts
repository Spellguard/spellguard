// SPDX-License-Identifier: Apache-2.0

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpGuardConfig {
  agentId: string;
  agentSecret: string;
  managementUrl: string;
  upstreamUrl?: string;
  upstreamToken?: string;
  /** The wrapped server's executable. */
  wrapCommand?: string;
  /** Its arguments, passed as argv (no shell, no splitting). */
  wrapArgs?: string[];
  /** Environment variables the wrapped server may see beyond the baseline. */
  passEnv?: string[];
  workspace?: string;
  failOpen?: boolean;
  verifierTimeout?: number;
}

export interface ProxyConnectResponse {
  connectionId: string;
  /**
   * The agent ID the management token names, which the Verifier checks every
   * request against. Older servers omit it; the guard then uses the
   * configured ID.
   */
  agentId?: string;
  managementToken: string;
  verifierUrl: string;
  /**
   * The session keys of the Verifiers Spellguard attests. The guard acts on
   * a verdict only when one of them signed it. Servers older than #1915 omit
   * it, and the guard refuses to start against them.
   */
  verifierKeys?: unknown;
  tokenExpiresAt: string;
}

export interface EvaluateRequest {
  agentId: string;
  platform: string;
  direction: 'inbound' | 'outbound';
  tool: string;
  context: ChannelContext;
  content: ContentItem[];
}

export interface EvaluateBatchRequest {
  agentId: string;
  platform: string;
  direction: 'inbound' | 'outbound';
  batch: true;
  messages: Array<{
    messageId: string;
    content: ContentItem[];
    context: ChannelContext;
  }>;
}

export interface ContentItem {
  type: 'text' | 'url';
  value: string;
}

export interface ChannelContext {
  channel?: string;
  channelName?: string;
  threadTs?: string;
  isDirectMessage?: boolean;
  /** The tool under evaluation; names the Verifier's tool leg. */
  tool?: string;
  /** The guard's platform connection, so the Verifier's record lands on it. */
  connectionId?: string;
}

export interface EvaluateResponse {
  result: 'allow' | 'block' | 'flag' | 'unscanned';
  detections: Detection[];
  redactions: Redaction[];
  /**
   * Who decided. `verifier`: the Verifier evaluated and recorded it.
   * `guard`: the guard decided locally (Verifier unreachable or refused, a
   * malformed verdict, an oversized payload) and must record it itself.
   */
  source: 'verifier' | 'guard';
}

export interface EvaluateBatchResponse {
  results: Array<{
    messageId: string;
    result: 'allow' | 'block' | 'flag' | 'unscanned';
    detections: Detection[];
    redactions: Redaction[];
  }>;
  source: 'verifier' | 'guard';
}

export interface Detection {
  engine: string;
  policy: string;
  confidence: number;
  span?: { start: number; end: number };
  detail: string;
}

export interface Redaction {
  start: number;
  end: number;
  replacement: string;
}

export interface TrafficEntry {
  timestamp: string;
  direction: 'inbound' | 'outbound';
  tool: string;
  channel: { id: string; name: string | null; type: string | null };
  threadTs: string | null;
  result: string;
  detections: Detection[];
  contentPreview: string | null;
  contentSummary: {
    textLength: number;
    urlCount: number;
    hasAttachment: boolean;
  };
}

export interface Upstream {
  connect(): Promise<void>;
  toolsList(): Promise<Tool[]>;
  toolsCall(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  /** Called once if the upstream goes away on its own (the child exits). */
  onClose?: () => void;
}

export interface PlatformParser {
  platform: string;
  detect(tools: unknown[]): boolean;
  parseToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): {
    direction: 'inbound' | 'outbound';
    channelId: string | null;
    channelName: string | null;
    channelType: string | null;
    threadTs: string | null;
    content: ContentItem[];
  } | null;
  parseToolResult(
    toolName: string,
    result: unknown,
  ): {
    messages: Array<{
      messageId: string;
      content: ContentItem[];
    }>;
  } | null;
}
