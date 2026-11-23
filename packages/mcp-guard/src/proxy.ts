// SPDX-License-Identifier: Apache-2.0

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AuthClient } from './auth/client';
import { buildChildEnv } from './child-env';
import { normalizeBaseUrl } from './config';
import { EvaluateClient, guardBlock } from './evaluate/client';
import { MAX_SCAN_BYTES, argumentsPayload, resultPayload } from './payload';
import { detectPlatform } from './platforms/detector';
import { GenericParser } from './platforms/generic';
import { TrafficReporter } from './report/reporter';
import type {
  ChannelContext,
  ContentItem,
  EvaluateResponse,
  McpGuardConfig,
  PlatformParser,
  TrafficEntry,
  Upstream,
} from './types';
import { LocalUpstream } from './upstream/local';
import { RemoteUpstream } from './upstream/remote';
import { VERSION } from './version';

type Direction = 'inbound' | 'outbound';

/** A verdict stops the call (or withholds the result). */
function stops(verdict: EvaluateResponse): boolean {
  // Redactions stop too, until span-level rewriting exists: forwarding the
  // unredacted content would ignore the policy.
  return verdict.result === 'block' || verdict.redactions.length > 0;
}

function reason(verdict: EvaluateResponse): string {
  const d = verdict.detections[0];
  if (!d) {
    return verdict.redactions.length > 0
      ? 'content requires redaction'
      : 'content policy violation';
  }
  return d.detail ? `${d.policy}: ${d.detail}` : d.policy;
}

function tooLarge(
  bytes: number,
  what: 'arguments' | 'result',
): EvaluateResponse {
  const subject =
    what === 'arguments'
      ? "this call's arguments are"
      : "this tool's result is";
  return guardBlock(
    'payload-too-large',
    `Blocked: ${subject} ${Math.ceil(bytes / 1024)} KiB, and the guard checks at most ${MAX_SCAN_BYTES / 1024} KiB. Content that can't be checked doesn't pass.`,
  );
}

export class McpGuardProxy {
  private server: Server;
  private upstream: Upstream;
  private authClient: AuthClient;
  private evaluateClient: EvaluateClient;
  private reporter: TrafficReporter;
  private platformParser: PlatformParser = new GenericParser();
  private closeNotified = false;

  /**
   * Called once when the guard has nothing left to do: the MCP client closed
   * its end, or the wrapped server exited. The owner (the CLI) stops the
   * guard and exits, so no guard or server outlives its client (#1501).
   */
  onClose?: (reason: string) => void;

  constructor(private config: McpGuardConfig) {
    const base = normalizeBaseUrl(config.managementUrl);
    const managementUrl = base.ok ? base.url : config.managementUrl;

    if (config.upstreamUrl) {
      this.upstream = new RemoteUpstream(
        config.upstreamUrl,
        config.upstreamToken,
      );
    } else if (config.wrapCommand) {
      const [command, ...inlineArgs] = config.wrapArgs
        ? [config.wrapCommand]
        : config.wrapCommand.trim().split(/\s+/);
      this.upstream = new LocalUpstream(
        command,
        config.wrapArgs ?? inlineArgs,
        buildChildEnv(process.env, config.passEnv ?? []),
      );
      this.upstream.onClose = () =>
        this.notifyClose('the wrapped MCP server exited');
    } else {
      throw new Error('Either --upstream or --wrap must be specified');
    }

    this.authClient = new AuthClient(
      managementUrl,
      config.agentId,
      config.agentSecret,
    );
    this.evaluateClient = new EvaluateClient(this.authClient, {
      failOpen: config.failOpen ?? false,
      timeout: config.verifierTimeout ?? 5000,
    });
    this.reporter = new TrafficReporter(this.authClient, managementUrl);

    this.server = new Server(
      { name: 'spellguard-mcp-guard', version: VERSION },
      { capabilities: { tools: {} } },
    );
    this.setupHandlers();
  }

  async start(): Promise<void> {
    // 1. Start or reach the server being guarded.
    await this.upstream.connect();

    // 2. Recognize the platform from its tools (Slack, or generic).
    const tools = await this.upstream.toolsList();
    this.platformParser = detectPlatform(tools as unknown[]);
    const platform = this.platformParser.platform;
    console.error(`[mcp-guard] Detected platform: ${platform}`);

    // 3. Authenticate with Spellguard.
    await this.authClient.connect(
      platform,
      this.config.upstreamUrl ? 'remote' : 'local',
      this.config.upstreamUrl ||
        [this.config.wrapCommand, ...(this.config.wrapArgs ?? [])].join(' '),
      this.config.workspace,
    );
    console.error('[mcp-guard] Connected to Spellguard');

    // 4. Heartbeats and the guard's own traffic records.
    this.reporter.start();

    // 5. Serve the MCP client on stdio, and stop when it goes away. The SDK's
    //    stdio transport doesn't notice stdin ending, so watch for it here.
    const transport = new StdioServerTransport();
    transport.onclose = () => this.notifyClose('the MCP client disconnected');
    await this.server.connect(transport);
    process.stdin.once('end', () =>
      this.notifyClose('the MCP client closed stdin'),
    );
    process.stdin.once('close', () =>
      this.notifyClose('the MCP client closed stdin'),
    );
    console.error(
      `[mcp-guard] MCP Guard ${VERSION} ready (platform: ${platform})`,
    );
  }

  async stop(): Promise<void> {
    // Settle every step, so one failure can't leave the wrapped server running.
    await Promise.allSettled([this.reporter.close()]);
    await Promise.allSettled([this.upstream.close(), this.authClient.close()]);
    await Promise.allSettled([this.server.close()]);
  }

  private notifyClose(why: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onClose?.(why);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.upstream.toolsList();
      const allowed = await this.evaluateClient.allowedTools(
        tools.map((t) => t.name),
      );
      if (!allowed) return { tools };
      const hidden = tools.filter((t) => !allowed.has(t.name));
      if (hidden.length > 0) {
        console.error(
          `[mcp-guard] Hiding ${hidden.length} tool(s) your approved-tools policy doesn't allow: ${hidden
            .map((t) => t.name)
            .join(', ')}`,
        );
      }
      return { tools: tools.filter((t) => allowed.has(t.name)) };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.handleCall(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      ),
    );
  }

  /**
   * Every call is checked twice: its arguments before it reaches the server,
   * and its result before it reaches the agent. Whatever the tool, platform
   * or argument shape (#1501).
   */
  private async handleCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parser = this.platformParser;
    const parsed = parser.parseToolCall(toolName, args);
    const context: ChannelContext = {
      tool: toolName,
      connectionId: this.safeConnectionId(),
      channel: parsed?.channelId ?? undefined,
      channelName: parsed?.channelName ?? undefined,
      threadTs: parsed?.threadTs ?? undefined,
    };

    // 1. The call.
    const argsPayload = argumentsPayload(args);
    const outbound = argsPayload.ok
      ? await this.evaluateClient.evaluate({
          agentId: this.authClient.getAgentId(),
          platform: parser.platform,
          direction: 'outbound',
          tool: toolName,
          context,
          content: argsPayload.content,
        })
      : tooLarge(argsPayload.bytes, 'arguments');
    this.recordGuardDecision(
      toolName,
      'outbound',
      context,
      parsed?.channelType ?? null,
      outbound,
      argsPayload.ok ? argsPayload.content : [],
    );
    if (stops(outbound)) {
      return {
        content: [
          {
            type: 'text',
            text: `[Spellguard] Tool call blocked by policy (${reason(outbound)})`,
          },
        ],
        isError: true,
      };
    }

    // 2. Forward it.
    const result = (await this.upstream.toolsCall(
      toolName,
      args,
    )) as CallToolResult;

    // 3. The result. Channel reads a platform parser understands are checked
    //    message by message, as channel messages, and only blocked messages
    //    are removed. Everything else is checked whole, on the tool leg.
    const messages = parser.parseToolResult(toolName, result);
    if (
      parsed?.direction === 'inbound' &&
      messages &&
      messages.messages.length > 0
    ) {
      return this.filterMessages(
        toolName,
        context,
        parsed.channelType,
        result,
        messages.messages,
      );
    }

    const resultContent = resultPayload(result);
    if (resultContent === null) return result; // no text to check
    const inbound = resultContent.ok
      ? await this.evaluateClient.evaluate({
          agentId: this.authClient.getAgentId(),
          platform: parser.platform,
          direction: 'inbound',
          tool: toolName,
          context,
          content: resultContent.content,
        })
      : tooLarge(resultContent.bytes, 'result');
    this.recordGuardDecision(
      toolName,
      'inbound',
      context,
      parsed?.channelType ?? null,
      inbound,
      resultContent.ok ? resultContent.content : [],
    );
    if (stops(inbound)) {
      return {
        content: [
          {
            type: 'text',
            text: `[Spellguard] The result of ${toolName} was withheld by policy (${reason(inbound)})`,
          },
        ],
        isError: true,
      };
    }
    return result;
  }

  private async filterMessages(
    toolName: string,
    context: ChannelContext,
    channelType: string | null,
    result: CallToolResult,
    messages: Array<{ messageId: string; content: ContentItem[] }>,
  ): Promise<CallToolResult> {
    const batch = await this.evaluateClient.evaluateBatch({
      agentId: this.authClient.getAgentId(),
      platform: this.platformParser.platform,
      direction: 'inbound',
      batch: true,
      messages: messages.map((msg) => ({
        messageId: msg.messageId,
        content: msg.content,
        // No `tool` here: these are channel messages, and the Verifier checks
        // them on the message leg.
        context: {
          channel: context.channel,
          channelName: context.channelName,
          connectionId: context.connectionId,
        },
      })),
    });

    if (batch.source === 'guard') {
      const byId = new Map(messages.map((m) => [m.messageId, m.content]));
      for (const r of batch.results) {
        this.recordGuardDecision(
          toolName,
          'inbound',
          context,
          channelType,
          { ...r, source: 'guard' },
          byId.get(r.messageId) ?? [],
        );
      }
    }

    const blockedIds = new Set(
      batch.results
        .filter((r) => r.result === 'block' || r.redactions.length > 0)
        .map((r) => r.messageId),
    );
    return blockedIds.size > 0
      ? this.redactBlockedMessages(result, blockedIds)
      : result;
  }

  private redactBlockedMessages(
    result: CallToolResult,
    blockedIds: Set<string>,
  ): CallToolResult {
    // Slack read results carry { messages: [...] } as JSON in a text block.
    return {
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
            // Not JSON; leave it.
          }
        }
        return block;
      }),
    };
  }

  private safeConnectionId(): string | undefined {
    try {
      return this.authClient.getConnectionId();
    } catch {
      return undefined;
    }
  }

  /**
   * The Verifier records every check it makes. The guard records only the
   * decisions the Verifier never saw (a local block, or fail-open
   * "unscanned"), so each event is recorded once (#1501).
   */
  private recordGuardDecision(
    toolName: string,
    direction: Direction,
    context: ChannelContext,
    channelType: string | null,
    verdict: EvaluateResponse,
    content: ContentItem[],
  ): void {
    if (verdict.source !== 'guard') return;
    const text = content.map((c) => c.value).join(' ');
    const entry: TrafficEntry = {
      timestamp: new Date().toISOString(),
      direction,
      tool: toolName,
      channel: {
        id: context.channel || 'unknown',
        name: context.channelName ?? null,
        type: channelType,
      },
      threadTs: context.threadTs ?? null,
      result: verdict.result,
      detections: verdict.detections,
      // Never the content itself: these are calls the Verifier didn't scan,
      // so their arguments may hold anything, credentials included (REM-092).
      // The feed shows why instead.
      contentPreview:
        verdict.detections[0]?.detail ??
        (verdict.result === 'unscanned'
          ? 'Not checked: the Verifier was unreachable and this guard runs fail-open.'
          : null),
      contentSummary: {
        textLength: text.length,
        urlCount: content.filter((c) => c.type === 'url').length,
        hasAttachment: false,
      },
    };
    this.reporter.report(entry);
  }
}
