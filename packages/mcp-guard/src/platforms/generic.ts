// SPDX-License-Identifier: Apache-2.0

import type { ContentItem, PlatformParser } from '../types';

export class GenericParser implements PlatformParser {
  platform = 'generic';

  detect(_tools: unknown[]): boolean {
    return true; // Always matches as fallback
  }

  parseToolCall(
    _toolName: string,
    args: Record<string, unknown>,
  ): {
    direction: 'inbound' | 'outbound';
    channelId: string | null;
    channelName: string | null;
    channelType: string | null;
    threadTs: string | null;
    content: ContentItem[];
  } | null {
    // Extract all string values from args as text content
    const textValues = Object.values(args)
      .filter((v): v is string => typeof v === 'string')
      .filter((v) => v.length > 0 && v.length < 10000);

    if (textValues.length === 0) return null;

    return {
      direction: 'outbound' as const,
      channelId: null,
      channelName: null,
      channelType: null,
      threadTs: null,
      content: textValues.map((v) => ({ type: 'text' as const, value: v })),
    };
  }

  parseToolResult(
    _toolName: string,
    result: unknown,
  ): {
    messages: Array<{
      messageId: string;
      content: ContentItem[];
    }>;
  } | null {
    // Extract string values from result for inbound scanning
    if (typeof result === 'string') {
      return {
        messages: [
          {
            messageId: crypto.randomUUID(),
            content: [{ type: 'text' as const, value: result }],
          },
        ],
      };
    }
    return null;
  }
}
