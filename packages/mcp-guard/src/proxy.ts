// SPDX-License-Identifier: Apache-2.0

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AuthClient } from './auth/client';
import { EvaluateClient } from './evaluate/client';
import { detectPlatform } from './platforms/detector';
import { TrafficReporter } from './report/reporter';
import type {
  ContentItem,
  McpGuardConfig,
  PlatformParser,
  TrafficEntry,
  Upstream,
} from './types';
import { LocalUpstream } from './upstream/local';
import { RemoteUpstream } from './upstream/remote';

export class McpGuardProxy {
  private server: Server;
  private upstream: Upstream;
  private authClient: AuthClient;
  private evaluateClient: EvaluateClient;
  private reporter: TrafficReporter;
  private platformParser: PlatformParser | null = null;

  constructor(private config: McpGuardConfig) {
    // Create upstream
    if (config.upstreamUrl) {
      this.upstream = new RemoteUpstream(
        config.upstreamUrl,
        config.upstreamToken,
      );
    } else if (config.wrapCommand) {
      this.upstream = new LocalUpstream(config.wrapCommand);
    } else {
      throw new Error('Either --upstream or --wrap must be specified');
    }

    // Create auth client
    this.authClient = new AuthClient(
      config.managementUrl,
      config.agentId,
      config.agentSecret,
    );

    // Create evaluate client
    this.evaluateClient = new EvaluateClient(this.authClient, {
      failOpen: config.failOpen ?? false,
      timeout: config.verifierTimeout ?? 5000,
    });

    // Create reporter
    this.reporter = new TrafficReporter(this.authClient, config.managementUrl);

    // Create MCP server
    this.server = new Server(
      { name: 'spellguard-mcp-guard', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();
  }

  async start(): Promise<void> {
    // 1. Connect upstream
    await this.upstream.connect();

    // 2. Detect platform from upstream tools
    const tools = await this.upstream.toolsList();
    this.platformParser = detectPlatform(tools as unknown[]);
    console.error(
      `[mcp-guard] Detected platform: ${this.platformParser.platform}`,
    );

    // 3. Authenticate with management server
    const platform = this.platformParser.platform;
    const upstreamDesc =
      this.config.upstreamUrl || this.config.wrapCommand || 'unknown';
    await this.authClient.connect(
      platform,
      this.config.upstreamUrl ? 'remote' : 'local',
      upstreamDesc,
      this.config.workspace,
    );
    console.error('[mcp-guard] Connected to management server');

    // 4. Start reporter
    this.reporter.start();

    // 5. Start MCP server on stdio (the agent connects here)
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`[mcp-guard] MCP proxy ready (platform: ${platform})`);
  }

  async stop(): Promise<void> {
    await this.reporter.close();
    await this.authClient.close();
    await this.upstream.close();
    await this.server.close();
  }

  private setupHandlers(): void {
    // Handle tools/list -- forward from upstream
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.upstream.toolsList();
      return { tools };
    });

    // Handle tools/call -- intercept, evaluate, forward or block
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const toolName = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<
          string,
          unknown
        >;

        if (!this.platformParser) {
          // No platform detected, forward directly
          return (await this.upstream.toolsCall(
            toolName,
            args,
          )) as CallToolResult;
        }

        const parsed = this.platformParser.parseToolCall(toolName, args);

        if (!parsed) {
          // Unknown tool, forward directly
          return (await this.upstream.toolsCall(
            toolName,
            args,
          )) as CallToolResult;
        }

        if (parsed.direction === 'outbound') {
          return this.handleOutbound(
            toolName,
            args,
            parsed,
            this.platformParser,
          );
        }
        return this.handleInbound(toolName, args, parsed, this.platformParser);
      },
    );
  }

  private async handleOutbound(
    toolName: string,
    args: Record<string, unknown>,
    parsed: ParsedCall,
    parser: PlatformParser,
  ): Promise<CallToolResult> {
    // 1. Evaluate content via Verifier
    const evalResult = await this.evaluateClient.evaluate({
      agentId: this.config.agentId,
      platform: parser.platform,
      direction: 'outbound',
      tool: toolName,
      context: {
        channel: parsed.channelId ?? undefined,
        channelName: parsed.channelName ?? undefined,
        threadTs: parsed.threadTs ?? undefined,
      },
      content: parsed.content,
    });

    // 2. Report traffic
    this.reporter.report(
      this.buildTrafficEntry(
        toolName,
        'outbound',
        parsed,
        evalResult.result,
        evalResult.detections,
      ),
    );

    // 3. If blocked, return error
    if (evalResult.result === 'block') {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[Spellguard] Message blocked by policy: ${evalResult.detections[0]?.detail || 'content policy violation'}`,
          },
        ],
        isError: true,
      };
    }

    // 4. If redactions present, block until span-level rewriting is implemented
    if (evalResult.redactions.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: '[Spellguard] Outbound content requires redaction — blocked.',
          },
        ],
        isError: true,
      };
    }

    // 5. If allowed/flagged/unscanned, forward to upstream
    const result = (await this.upstream.toolsCall(
      toolName,
      args,
    )) as CallToolResult;

    // 6. Parse result to populate caches (e.g. channel name cache)
    parser.parseToolResult(toolName, result);

    return result;
  }

  private async handleInbound(
    toolName: string,
    args: Record<string, unknown>,
    parsed: ParsedCall,
    parser: PlatformParser,
  ): Promise<CallToolResult> {
    // 1. Forward to upstream first (read operations)
    const result = (await this.upstream.toolsCall(
      toolName,
      args,
    )) as CallToolResult;

    // 2. Parse the result for inbound messages
    const inboundMessages = parser.parseToolResult(toolName, result);

    if (!inboundMessages || inboundMessages.messages.length === 0) {
      // No parseable messages, report and return as-is
      this.reporter.report(
        this.buildTrafficEntry(toolName, 'inbound', parsed, 'allow', []),
      );
      return result;
    }

    // 3. Batch evaluate inbound messages via Verifier
    const batchResult = await this.evaluateClient.evaluateBatch({
      agentId: this.config.agentId,
      platform: parser.platform,
      direction: 'inbound',
      batch: true,
      messages: inboundMessages.messages.map((msg) => ({
        messageId: msg.messageId,
        content: msg.content,
        context: {
          channel: parsed.channelId ?? undefined,
          channelName: parsed.channelName ?? undefined,
        },
      })),
    });

    // 4. Report traffic for each message (include message content as preview)
    const msgContentMap = new Map(
      inboundMessages.messages.map((m) => [
        m.messageId,
        m.content.map((c) => c.value).join(' '),
      ]),
    );
    for (const msgResult of batchResult.results) {
      const msgText = msgContentMap.get(msgResult.messageId) ?? '';
      const parsedWithContent = {
        ...parsed,
        content: msgText
          ? [{ type: 'text' as const, value: msgText }]
          : parsed.content,
      };
      this.reporter.report(
        this.buildTrafficEntry(
          toolName,
          'inbound',
          parsedWithContent,
          msgResult.result,
          msgResult.detections,
        ),
      );
    }

    // 5. If any messages were blocked or need redaction, filter them from the result
    const blockedIds = new Set(
      batchResult.results
        .filter((r) => r.result === 'block' || r.redactions.length > 0)
        .map((r) => r.messageId),
    );

    if (blockedIds.size > 0) {
      return this.redactBlockedMessages(result, blockedIds);
    }

    return result;
  }

  private redactBlockedMessages(
    result: CallToolResult,
    blockedIds: Set<string>,
  ): CallToolResult {
    // Handle MCP SDK response format:
    // { content: [{ type: "text", text: JSON.stringify({ messages: [...] }) }] }
    // CallToolResult.content is an array of content blocks.
    const redacted = {
      ...result,
      content: result.content.map((block) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          try {
            const data = JSON.parse(block.text);
            if (data.messages && Array.isArray(data.messages)) {
              data.messages = data.messages.filter(
                (msg: Record<string, unknown>) =>
                  !blockedIds.has(msg.ts as string),
              );
              return { ...block, text: JSON.stringify(data) };
            }
          } catch {
            // Not JSON, return as-is
          }
        }
        return block;
      }),
    };
    return redacted;
  }

  private buildTrafficEntry(
    toolName: string,
    direction: 'inbound' | 'outbound',
    parsed: ParsedCall,
    result: string,
    detections: {
      engine: string;
      policy: string;
      confidence: number;
      detail: string;
    }[],
  ): TrafficEntry {
    const textLength = parsed.content.reduce(
      (sum, c) => sum + c.value.length,
      0,
    );
    const urlCount = parsed.content.filter((c) => c.type === 'url').length;

    const fullText = parsed.content.map((c) => c.value).join(' ');
    const contentPreview =
      fullText.length > 0
        ? fullText.length > 300
          ? `${fullText.slice(0, 300)}…`
          : fullText
        : null;

    return {
      timestamp: new Date().toISOString(),
      direction,
      tool: toolName,
      channel: {
        id: parsed.channelId || 'unknown',
        name: parsed.channelName,
        type: parsed.channelType,
      },
      threadTs: parsed.threadTs,
      result,
      detections,
      contentPreview,
      contentSummary: { textLength, urlCount, hasAttachment: false },
    };
  }
}

/** Convenience type for the parsed tool-call shape returned by PlatformParser */
type ParsedCall = {
  direction: 'inbound' | 'outbound';
  channelId: string | null;
  channelName: string | null;
  channelType: string | null;
  threadTs: string | null;
  content: ContentItem[];
};
