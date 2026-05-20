// SPDX-License-Identifier: Apache-2.0

import { evaluateContent } from './evaluate';
import { getPlatformForSession } from './inbound-observer';
import type { HookConfig } from './types';

export function createToolGuard(config: HookConfig) {
  return async (
    event: {
      toolName?: string;
      name?: string;
      params?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
    },
    ctx?: {
      accountId?: string;
      conversationId?: string;
    },
  ) => {
    const toolName = event.toolName ?? event.name ?? '';
    const params = event.params ?? event.arguments ?? {};
    const paramsStr = JSON.stringify(params);

    if (!paramsStr || paramsStr === '{}') return {};

    // Resolve platform from stash (stashed by before_dispatch guard)
    let channel: string | undefined;
    if (ctx?.accountId && ctx?.conversationId) {
      channel = getPlatformForSession(`${ctx.accountId}:${ctx.conversationId}`);
    }

    const result = await evaluateContent(config, paramsStr, 'outbound', {
      tool: toolName,
      channel,
    });

    if (result.result === 'block') {
      return {
        block: true,
        blockReason:
          result.detections[0]?.detail ?? 'Blocked by Spellguard policy',
      };
    }
    return {};
  };
}
