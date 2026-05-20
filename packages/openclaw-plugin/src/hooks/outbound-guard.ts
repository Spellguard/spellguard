// SPDX-License-Identifier: Apache-2.0

import { evaluateContent } from './evaluate';
import type { HookConfig } from './types';

export function createOutboundGuard(config: HookConfig) {
  return async (event: {
    to?: string;
    content?: string;
    metadata?: { channel?: string };
  }) => {
    const content = event.content;
    if (!content) return {};

    const result = await evaluateContent(config, content, 'outbound', {
      channel: event.metadata?.channel,
    });

    if (result.result === 'block') {
      return { cancel: true };
    }
    return {};
  };
}
