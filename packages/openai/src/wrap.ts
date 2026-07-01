// SPDX-License-Identifier: Apache-2.0

import {
  buildAgentContextBlock,
  reportUsageEvent,
  resolveAndCollectAgentResponses,
} from '@spellguard/client';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// ─── Private helpers ──────────────────────────────────────────────

function extractPrompt(messages: ChatCompletionMessageParam[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    )
    .join('\n');
}

function augmentMessages(
  messages: ChatCompletionMessageParam[],
  agentResponses: Array<{ agent: string; response: string }>,
): ChatCompletionMessageParam[] {
  if (agentResponses.length === 0) return messages;

  const contextBlock = buildAgentContextBlock(agentResponses);
  const augmented = [...messages];

  // Prefer 'developer' message (used by newer OpenAI models), fall back to 'system'
  const developerIdx = augmented.findIndex((m) => m.role === 'developer');
  const systemIdx = augmented.findIndex((m) => m.role === 'system');
  const targetIdx = developerIdx >= 0 ? developerIdx : systemIdx;

  if (targetIdx >= 0) {
    const existing = augmented[targetIdx];
    const existingContent =
      typeof existing.content === 'string'
        ? existing.content
        : JSON.stringify(existing.content);
    augmented[targetIdx] = {
      ...existing,
      content: `${existingContent}\n\n${contextBlock}`,
    };
  } else {
    augmented.unshift({ role: 'system', content: contextBlock });
  }

  return augmented;
}

// ─── wrapOpenAI ───────────────────────────────────────────────────

/**
 * Wrap an OpenAI client instance with Spellguard agent routing.
 *
 * Intercepts `client.chat.completions.create()`. When the prompt contains
 * references to other agents, the wrapper discovers them via A2A, collects
 * their responses through the Spellguard Verifier, augments the message list
 * with the gathered context, and then delegates the call to the real
 * OpenAI API. Prompts with no agent references pass through directly
 * with zero overhead.
 *
 * **Prerequisite:** Spellguard must be initialised before the first call
 * (e.g. via `createSpellguard`). The wrapper does not perform
 * its own initialisation — it relies on the middleware, same as the
 * AI SDK's `generateText()` wrapper in `@spellguard/client/ai`.
 *
 * Usage:
 * ```typescript
 * import OpenAI from 'openai';
 * import { wrapOpenAI } from '@spellguard/openai';
 *
 * const openai = new OpenAI();
 * const client = wrapOpenAI(openai);
 *
 * // Use exactly like a normal OpenAI client
 * const result = await client.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages: [{ role: 'user', content: 'Analyse data from Agent B' }],
 * });
 * ```
 */
export function wrapOpenAI(client: OpenAI): OpenAI {
  const originalCreate = client.chat.completions.create.bind(
    client.chat.completions,
  ) as (...args: any[]) => any;

  const interceptedCreate = async (
    params: any,
    reqOptions?: any,
  ): Promise<any> => {
    const messages: ChatCompletionMessageParam[] = params.messages ?? [];
    const prompt = extractPrompt(messages);
    const agentResponses = await resolveAndCollectAgentResponses(prompt);
    const prepared = augmentMessages(messages, agentResponses);
    const response = await originalCreate(
      { ...params, messages: prepared },
      reqOptions,
    );
    // await-and-rewrap usage emit. Skip the
    // streaming branch — when `stream: true` the return is an async iterable
    // with no `.usage` (usage lands on the terminal chunk only if
    // `stream_options.include_usage` is set); instrumenting it is deferred to
    // avoid wrapping the iterator. Fire-and-forget + fail-open.
    if (!params?.stream && response?.usage) {
      const u = response.usage;
      reportUsageEvent({
        model: response.model ?? params?.model ?? 'unknown',
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        totalTokens:
          u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
      });
    }
    return response;
  };

  const completionsProxy = new Proxy(client.chat.completions, {
    get(target, prop, receiver) {
      if (prop === 'create') return interceptedCreate;
      const val = Reflect.get(target, prop, receiver);
      // biome-ignore lint/complexity/noBannedTypes: OpenAI proxy needs generic Function cast
      return typeof val === 'function' ? (val as Function).bind(target) : val;
    },
  });

  const chatProxy = new Proxy(client.chat, {
    get(target, prop, receiver) {
      if (prop === 'completions') return completionsProxy;
      const val = Reflect.get(target, prop, receiver);
      // biome-ignore lint/complexity/noBannedTypes: OpenAI proxy needs generic Function cast
      return typeof val === 'function' ? (val as Function).bind(target) : val;
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chatProxy;
      const val = Reflect.get(target, prop, receiver);
      // biome-ignore lint/complexity/noBannedTypes: OpenAI proxy needs generic Function cast
      return typeof val === 'function' ? (val as Function).bind(target) : val;
    },
  }) as OpenAI;
}
