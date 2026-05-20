// SPDX-License-Identifier: Apache-2.0

export interface McpGuardConfig {
  agentId: string;
  agentSecret: string;
  managementUrl: string;
  upstreamUrl?: string;
  upstreamToken?: string;
  wrapCommand?: string;
  workspace?: string;
  failOpen?: boolean;
  verifierTimeout?: number;
}

export interface ProxyConnectResponse {
  connectionId: string;
  managementToken: string;
  verifierUrl: string;
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
}

export interface EvaluateResponse {
  result: 'allow' | 'block' | 'flag' | 'unscanned';
  detections: Detection[];
  redactions: Redaction[];
}

export interface EvaluateBatchResponse {
  results: Array<{
    messageId: string;
    result: 'allow' | 'block' | 'flag' | 'unscanned';
    detections: Detection[];
    redactions: Redaction[];
  }>;
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
  toolsList(): Promise<unknown>;
  toolsCall(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
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
