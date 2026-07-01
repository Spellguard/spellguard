// SPDX-License-Identifier: Apache-2.0

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessageChunk, SystemMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import {
  buildAgentContextBlock,
  reportUsageEvent,
  resolveAndCollectAgentResponses,
} from '@spellguard/client';

// ─── Private helpers ──────────────────────────────────────────────

function getContentText(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

function extractPrompt(messages: BaseMessage[]): string {
  return messages
    .filter((m) => m._getType() === 'human')
    .map((m) => getContentText(m.content as string | unknown[]))
    .join('\n');
}

function augmentMessages(
  messages: BaseMessage[],
  agentResponses: Array<{ agent: string; response: string }>,
): BaseMessage[] {
  if (agentResponses.length === 0) return messages;

  const contextBlock = buildAgentContextBlock(agentResponses);
  const augmented = [...messages];
  const systemIdx = augmented.findIndex((m) => m._getType() === 'system');

  if (systemIdx >= 0) {
    const existing = augmented[systemIdx];
    const existingText = getContentText(existing.content as string | unknown[]);
    augmented[systemIdx] = new SystemMessage(
      `${existingText}\n\n${contextBlock}`,
    );
  } else {
    augmented.unshift(new SystemMessage(contextBlock));
  }

  return augmented;
}

// ─── SpellguardChatModel ──────────────────────────────────────────

class SpellguardChatModel extends BaseChatModel {
  // biome-ignore lint/suspicious/noExplicitAny: wrapped model generic type is unknown at construction time
  private readonly wrappedModel: BaseChatModel<any>;

  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: wrapped model generic type is unknown at construction time
    wrappedModel: BaseChatModel<any>,
  ) {
    super({});
    this.wrappedModel = wrappedModel;
  }

  _llmType(): string {
    // wrappedModel may be undefined during super() construction (BaseChatModel
    // calls _llmType() before class field assignments complete)
    return `spellguard-${this.wrappedModel?._llmType() ?? 'chat'}`;
  }

  /**
   * Detect agent references, collect Verifier responses, and augment messages.
   * Returns the original messages unchanged when no agents are detected.
   */
  private async prepareMessages(
    messages: BaseMessage[],
  ): Promise<BaseMessage[]> {
    const prompt = extractPrompt(messages);
    const agentResponses = await resolveAndCollectAgentResponses(prompt);
    return augmentMessages(messages, agentResponses);
  }

  /**
   * emit token usage from a wrapped-model
   * `ChatResult`. Usage shape varies by provider — read defensively across
   * `llmOutput.tokenUsage` (OpenAI-family camelCase), `llmOutput.usage`, and the
   * per-generation `usage_metadata` (snake_case input/output tokens).
   * Fire-and-forget + fail-open — never throws into the LLM call.
   */
  private emitUsage(result: ChatResult): void {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: provider llmOutput shapes vary
      const out = (result.llmOutput ?? {}) as any;
      const tu = out.tokenUsage ?? out.usage;
      // biome-ignore lint/suspicious/noExplicitAny: per-generation message shape varies
      const meta = (result.generations?.[0]?.message as any)?.usage_metadata;
      const promptTokens =
        tu?.promptTokens ?? tu?.prompt_tokens ?? meta?.input_tokens;
      const completionTokens =
        tu?.completionTokens ?? tu?.completion_tokens ?? meta?.output_tokens;
      const totalTokens =
        tu?.totalTokens ?? tu?.total_tokens ?? meta?.total_tokens;
      if (promptTokens == null && completionTokens == null) return;
      const model =
        out.model ??
        // biome-ignore lint/suspicious/noExplicitAny: wrapped model id is not on the shared type
        (this.wrappedModel as any).model ??
        this.wrappedModel._llmType();
      reportUsageEvent({
        model: typeof model === 'string' ? model : 'unknown',
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        totalTokens:
          totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
      });
    } catch {
      /* fail-open */
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const prepared = await this.prepareMessages(messages);
    const result = await this.wrappedModel._generate(
      prepared,
      // biome-ignore lint/suspicious/noExplicitAny: options type varies per wrapped model
      options as any,
      runManager,
    );
    this.emitUsage(result);
    return result;
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const prepared = await this.prepareMessages(messages);

    // Try to delegate to the wrapped model's streaming. The base LangChain
    // implementation throws "Not implemented." — catch that and fall back to
    // _generate so models without native streaming still work.
    // biome-ignore lint/suspicious/noExplicitAny: wrapped model streaming has no shared typed interface
    const wrappedIter = (this.wrappedModel as any)._streamResponseChunks(
      prepared,
      // biome-ignore lint/suspicious/noExplicitAny: options type varies per wrapped model
      options as any,
      runManager,
    ) as AsyncGenerator<ChatGenerationChunk>;

    let firstResult: IteratorResult<ChatGenerationChunk> | undefined;
    try {
      firstResult = await wrappedIter.next();
    } catch (err) {
      if (err instanceof Error && err.message === 'Not implemented.') {
        // Wrapped model doesn't support streaming — fall back to _generate
        const result = await this.wrappedModel._generate(
          prepared,
          // biome-ignore lint/suspicious/noExplicitAny: options type varies per wrapped model
          options as any,
          runManager,
        );
        // the non-streaming fallback carries final usage.
        this.emitUsage(result);
        for (const gen of result.generations) {
          yield new ChatGenerationChunk({
            text: gen.text,
            message: new AIMessageChunk({ content: gen.text }),
          });
        }
        return;
      }
      throw err;
    }

    if (!firstResult.done) {
      yield firstResult.value;
      yield* wrappedIter;
    }
  }
}

/**
 * Wrap any LangChain `BaseChatModel` with Spellguard Verifier policy enforcement.
 *
 * When a prompt contains references to other agents, the wrapper automatically
 * discovers them via A2A, collects their responses through the Spellguard Verifier,
 * augments the message list with the gathered context, and then delegates the
 * final LLM call to the wrapped model. Prompts with no agent references pass
 * through directly with zero overhead.
 *
 * **Prerequisite:** Spellguard must be initialised before the first call
 * (e.g. via `createSpellguard`). The wrapper does not perform
 * its own initialisation — it relies on the middleware, same as the
 * AI SDK's `generateText()` wrapper in `@spellguard/client/ai`.
 */
export function createSpellguardChatModel(
  // biome-ignore lint/suspicious/noExplicitAny: wrapped model generic type is provided by the caller
  model: BaseChatModel<any>,
  // biome-ignore lint/suspicious/noExplicitAny: returns the same BaseChatModel interface
): BaseChatModel<any> {
  return new SpellguardChatModel(model);
}
