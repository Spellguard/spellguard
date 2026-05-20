// SPDX-License-Identifier: Apache-2.0

import type { ContentItem, PlatformParser } from '../types';

const SLACK_TOOL_PATTERNS = new Set([
  'chat_postMessage',
  'chat_update',
  'conversations_history',
  'conversations_replies',
  'reactions_add',
  'files_upload',
  'conversations_search',
  'channels_list',
  'conversations_list',
  'conversations_info',
  'users_info',
  'users_list',
  'chat_delete',
  'pins_add',
  'pins_list',
  'bookmarks_add',
  'bookmarks_list',
]);

/** Official mcp.slack.com tool names */
const SLACK_OFFICIAL_TOOLS = new Set([
  'slack_send_message',
  'slack_send_message_draft',
  'slack_schedule_message',
  'slack_create_canvas',
  'slack_update_canvas',
  'slack_read_channel',
  'slack_read_thread',
  'slack_search_public',
  'slack_search_public_and_private',
  'slack_search_channels',
  'slack_search_users',
  'slack_read_user_profile',
  'slack_read_canvas',
]);

/** Community @modelcontextprotocol/server-slack tool names */
const SLACK_COMMUNITY_TOOLS = new Set([
  'slack_list_channels',
  'slack_post_message',
  'slack_reply_to_thread',
  'slack_add_reaction',
  'slack_get_channel_history',
  'slack_get_thread_replies',
  'slack_get_users',
  'slack_get_user_profile',
]);

/** Determine if a tool name matches any known Slack tool pattern */
function isSlackTool(name: string): boolean {
  return (
    SLACK_TOOL_PATTERNS.has(name) ||
    SLACK_OFFICIAL_TOOLS.has(name) ||
    SLACK_COMMUNITY_TOOLS.has(name)
  );
}

/** Extract text and URLs from a string into ContentItem array */
function extractContent(text: string): ContentItem[] {
  const items: ContentItem[] = [];
  const urlPattern = /https?:\/\/[^\s<>]+/g;
  let lastIndex = 0;

  for (const match of text.matchAll(urlPattern)) {
    if (match.index > lastIndex) {
      const textPart = text.slice(lastIndex, match.index).trim();
      if (textPart) items.push({ type: 'text', value: textPart });
    }
    items.push({ type: 'url', value: match[0] });
    lastIndex = match.index + match[0].length;
  }

  const remaining = text.slice(lastIndex).trim();
  if (remaining) items.push({ type: 'text', value: remaining });

  return items.length > 0 ? items : [{ type: 'text', value: text }];
}

/** Resolve a channel ID from standard tool args */
function resolveChannelId(args: Record<string, unknown>): string | null {
  if (typeof args.channel === 'string') return args.channel;
  if (typeof args.channel_id === 'string') return args.channel_id;
  return null;
}

/** Resolve the first channel ID from files_upload args */
function resolveFileUploadChannelId(
  args: Record<string, unknown>,
): string | null {
  if (typeof args.channels === 'string') {
    return args.channels.split(',')[0].trim() || null;
  }
  if (Array.isArray(args.channels) && args.channels.length > 0) {
    const first = args.channels[0];
    return typeof first === 'string' ? first : null;
  }
  if (typeof args.channel_id === 'string') return args.channel_id;
  return null;
}

type ParsedToolCall = {
  direction: 'inbound' | 'outbound';
  channelId: string | null;
  channelName: string | null;
  channelType: string | null;
  threadTs: string | null;
  content: ContentItem[];
};

function makeOutbound(
  channelId: string | null,
  channelName: string | null,
  content: ContentItem[],
  threadTs: string | null = null,
): ParsedToolCall {
  return {
    direction: 'outbound',
    channelId,
    channelName,
    channelType: null,
    threadTs,
    content,
  };
}

function makeInbound(
  channelId: string | null,
  channelName: string | null,
  threadTs: string | null = null,
): ParsedToolCall {
  return {
    direction: 'inbound',
    channelId,
    channelName,
    channelType: null,
    threadTs,
    content: [],
  };
}

function parseChatPost(
  args: Record<string, unknown>,
  channelId: string | null,
  channelName: string | null,
): ParsedToolCall {
  const text = typeof args.text === 'string' ? args.text : '';
  const threadTs = typeof args.thread_ts === 'string' ? args.thread_ts : null;
  return makeOutbound(
    channelId,
    channelName,
    text ? extractContent(text) : [],
    threadTs,
  );
}

/** Extract content from a `content` string arg */
function extractArgContent(args: Record<string, unknown>): ContentItem[] {
  return typeof args.content === 'string' && args.content
    ? extractContent(args.content)
    : [];
}

/** Extract content from a `message` string arg (official Slack MCP) */
function extractArgMessage(args: Record<string, unknown>): ContentItem[] {
  const message = typeof args.message === 'string' ? args.message : '';
  return message ? extractContent(message) : [];
}

/** Extract content from a `query` string arg */
function extractArgQuery(args: Record<string, unknown>): ContentItem[] {
  return typeof args.query === 'string' && args.query
    ? extractContent(args.query)
    : [];
}

/**
 * Parse official mcp.slack.com tool calls.
 * Returns null if toolName is not an official tool.
 */
function parseOfficialToolCall(
  toolName: string,
  args: Record<string, unknown>,
  channelId: string | null,
  channelName: string | null,
): ParsedToolCall | null {
  switch (toolName) {
    case 'slack_send_message':
    case 'slack_send_message_draft':
    case 'slack_schedule_message':
      return makeOutbound(channelId, channelName, extractArgMessage(args));

    case 'slack_create_canvas':
      return makeOutbound(channelId, channelName, extractArgContent(args));

    case 'slack_update_canvas':
      return makeOutbound(null, null, extractArgContent(args));

    case 'slack_read_canvas':
    case 'slack_read_user_profile':
      return makeInbound(null, null);

    case 'slack_read_channel':
      return makeInbound(channelId, channelName);

    case 'slack_read_thread': {
      const threadTs =
        typeof args.thread_ts === 'string' ? args.thread_ts : null;
      return makeInbound(channelId, channelName, threadTs);
    }

    case 'slack_search_public':
    case 'slack_search_public_and_private':
    case 'slack_search_channels':
    case 'slack_search_users':
      return {
        direction: 'inbound',
        channelId: null,
        channelName: null,
        channelType: null,
        threadTs: null,
        content: extractArgQuery(args),
      };

    default:
      return null;
  }
}

/**
 * Parse community @modelcontextprotocol/server-slack tool calls.
 * Tool names: slack_post_message, slack_get_channel_history, etc.
 */
function parseCommunityToolCall(
  toolName: string,
  args: Record<string, unknown>,
  channelId: string | null,
  channelName: string | null,
): ParsedToolCall | null {
  switch (toolName) {
    case 'slack_post_message':
      return parseChatPost(args, channelId, channelName);

    case 'slack_reply_to_thread':
      return parseChatPost(args, channelId, channelName);

    case 'slack_add_reaction':
      return makeOutbound(channelId, channelName, []);

    case 'slack_get_channel_history':
      return makeInbound(channelId, channelName);

    case 'slack_get_thread_replies':
      return makeInbound(channelId, channelName);

    case 'slack_list_channels':
      return makeInbound(null, null);

    case 'slack_get_users':
      return makeInbound(null, null);

    case 'slack_get_user_profile':
      return makeInbound(null, null);

    default:
      return null;
  }
}

function parseFilesUpload(
  args: Record<string, unknown>,
  channelCache: Map<string, string>,
): ParsedToolCall {
  const fileChannelId = resolveFileUploadChannelId(args);
  const fileChannelName =
    fileChannelId !== null ? (channelCache.get(fileChannelId) ?? null) : null;
  const content: ContentItem[] =
    typeof args.content === 'string' && args.content
      ? extractContent(args.content)
      : [];
  return makeOutbound(fileChannelId, fileChannelName, content);
}

/**
 * Unwrap an MCP CallToolResult into parsed JSON data.
 * MCP SDK returns: { content: [{ type: 'text', text: '{"messages":[...]}' }] }
 * This extracts and parses the JSON from the first text content block.
 * Falls back to returning the input if it's already plain data.
 */
function unwrapMcpResult(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        try {
          return JSON.parse((block as Record<string, unknown>).text as string);
        } catch {
          // Not JSON, skip
        }
      }
    }
  }
  return result;
}

function parseHistoryResult(result: unknown): {
  messages: Array<{ messageId: string; content: ContentItem[] }>;
} | null {
  const data = unwrapMcpResult(result);
  if (
    data === null ||
    typeof data !== 'object' ||
    !('messages' in data) ||
    !Array.isArray((data as { messages: unknown }).messages)
  ) {
    return null;
  }

  const rawMessages = (data as { messages: unknown[] }).messages;
  const messages: Array<{ messageId: string; content: ContentItem[] }> = [];

  for (const msg of rawMessages) {
    if (msg === null || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    const ts = typeof m.ts === 'string' ? m.ts : null;
    if (ts === null) continue;
    const text = typeof m.text === 'string' ? m.text : '';
    messages.push({ messageId: ts, content: text ? extractContent(text) : [] });
  }

  return messages.length > 0 ? { messages } : null;
}

function populateChannelCache(
  result: unknown,
  cache: Map<string, string>,
): void {
  const data = unwrapMcpResult(result);
  if (
    data === null ||
    typeof data !== 'object' ||
    !('channels' in data) ||
    !Array.isArray((data as { channels: unknown }).channels)
  ) {
    return;
  }
  for (const ch of (data as { channels: unknown[] }).channels) {
    if (ch === null || typeof ch !== 'object') continue;
    const c = ch as Record<string, unknown>;
    if (typeof c.id === 'string' && typeof c.name === 'string') {
      cache.set(c.id, c.name);
    }
  }
}

export class SlackParser implements PlatformParser {
  platform = 'slack';

  /** Channel ID → name cache, session-scoped */
  private channelNameCache = new Map<string, string>();

  detect(tools: unknown[]): boolean {
    return tools.some(
      (tool) =>
        tool !== null &&
        typeof tool === 'object' &&
        'name' in tool &&
        typeof (tool as { name: unknown }).name === 'string' &&
        isSlackTool((tool as { name: string }).name),
    );
  }

  parseToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): ParsedToolCall | null {
    if (!isSlackTool(toolName)) return null;

    const channelId = resolveChannelId(args);
    const channelName =
      channelId !== null
        ? (this.channelNameCache.get(channelId) ?? null)
        : null;
    const threadTs = typeof args.ts === 'string' ? args.ts : null;

    switch (toolName) {
      case 'chat_postMessage':
      case 'chat_update':
        return parseChatPost(args, channelId, channelName);

      case 'conversations_history':
        return makeInbound(channelId, channelName);

      case 'conversations_replies':
        return makeInbound(channelId, channelName, threadTs);

      case 'reactions_add':
        return makeOutbound(channelId, channelName, []);

      case 'files_upload':
        return parseFilesUpload(args, this.channelNameCache);

      case 'conversations_search': {
        const query =
          typeof args.query === 'string' ? extractContent(args.query) : [];
        return {
          direction: 'inbound',
          channelId: null,
          channelName: null,
          channelType: null,
          threadTs: null,
          content: query,
        };
      }

      default: {
        // Delegate official mcp.slack.com tools to a dedicated parser
        if (SLACK_OFFICIAL_TOOLS.has(toolName)) {
          return parseOfficialToolCall(toolName, args, channelId, channelName);
        }
        // Delegate community @modelcontextprotocol/server-slack tools
        if (SLACK_COMMUNITY_TOOLS.has(toolName)) {
          return parseCommunityToolCall(toolName, args, channelId, channelName);
        }
        const direction: 'inbound' | 'outbound' = toolName.startsWith(
          'conversations_',
        )
          ? 'inbound'
          : 'outbound';
        const content: ContentItem[] =
          typeof args.text === 'string' && args.text
            ? extractContent(args.text)
            : [];
        return {
          direction,
          channelId,
          channelName,
          channelType: null,
          threadTs,
          content,
        };
      }
    }
  }

  parseToolResult(
    toolName: string,
    result: unknown,
  ): {
    messages: Array<{
      messageId: string;
      content: ContentItem[];
    }>;
  } | null {
    if (
      toolName === 'conversations_history' ||
      toolName === 'conversations_replies' ||
      toolName === 'slack_read_channel' ||
      toolName === 'slack_read_thread' ||
      toolName === 'slack_get_channel_history' ||
      toolName === 'slack_get_thread_replies'
    ) {
      return parseHistoryResult(result);
    }

    if (
      toolName === 'channels_list' ||
      toolName === 'conversations_list' ||
      toolName === 'slack_list_channels'
    ) {
      populateChannelCache(result, this.channelNameCache);
      return null;
    }

    return null;
  }
}
