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
    // #1417: every call is evaluated, a no-argument one as `{}`. Policies that
    // decide from the tool's name (allowlists, irreversible gates, rate and
    // sequence policies) must see it.
    const params = event.params ?? event.arguments ?? {};
    const paramsStr = JSON.stringify(params);

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
