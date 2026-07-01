// SPDX-License-Identifier: Apache-2.0

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { createSpellguardChatModel } from '@spellguard/langchain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────

const mockResolveAndCollect = vi.fn().mockResolvedValue([]);

vi.mock('@spellguard/client', () => ({
  resolveAndCollectAgentResponses: (...args: unknown[]) =>
    mockResolveAndCollect(...args),
  // emit — no-op in unit tests (fail-open transport, tested separately).
  reportUsageEvent: () => undefined,
  buildAgentContextBlock: (
    responses: Array<{ agent: string; response: string }>,
  ) => {
    const agentContext = responses
      .map(
        (r) =>
          `--- Response from ${r.agent} ---\n${r.response}\n--- End response from ${r.agent} ---`,
      )
      .join('\n\n');
    const instruction =
      "You have received responses from other agents. Use this information along with your own data to provide a comprehensive answer to the user's query.";
    return `${instruction}\n\n${agentContext}`;
  },
}));

// ─── Test doubles ─────────────────────────────────────────────────

const MOCK_RESPONSE = 'Mock LLM response';

class MockChatModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType() {
    return 'mock';
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    return {
      generations: [
        {
          text: MOCK_RESPONSE,
          message: new AIMessage(MOCK_RESPONSE),
          generationInfo: {},
        },
      ],
    };
  }
}

class MockStreamingChatModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType() {
    return 'mock-streaming';
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    return {
      generations: [
        { text: MOCK_RESPONSE, message: new AIMessage(MOCK_RESPONSE) },
      ],
    };
  }
  async *_streamResponseChunks(
    _messages: BaseMessage[],
  ): AsyncGenerator<ChatGenerationChunk> {
    yield new ChatGenerationChunk({
      text: 'chunk1',
      message: new AIMessageChunk({ content: 'chunk1' }),
    });
    yield new ChatGenerationChunk({
      text: 'chunk2',
      message: new AIMessageChunk({ content: 'chunk2' }),
    });
  }
}

// ─── Tests ────────────────────────────────────────────────────────

describe('createSpellguardChatModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAndCollect.mockResolvedValue([]);
  });

  describe('pass-through (no agent references)', () => {
    it('delegates directly to wrapped model when no agent responses', async () => {
      const inner = new MockChatModel();
      const generateSpy = vi.spyOn(inner, '_generate');

      const model = createSpellguardChatModel(inner);
      const result = await model.invoke([new HumanMessage('What is 2+2?')]);

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toBe(MOCK_RESPONSE);
    });

    it('calls resolveAndCollectAgentResponses with extracted prompt', async () => {
      const model = createSpellguardChatModel(new MockChatModel());
      await model.invoke([new HumanMessage('Hello')]);

      expect(mockResolveAndCollect).toHaveBeenCalledTimes(1);
      expect(mockResolveAndCollect).toHaveBeenCalledWith('Hello');
    });

    it('concatenates multiple human messages for prompt extraction', async () => {
      const model = createSpellguardChatModel(new MockChatModel());
      await model.invoke([
        new HumanMessage('First message'),
        new SystemMessage('System'),
        new HumanMessage('Second message'),
      ]);

      expect(mockResolveAndCollect).toHaveBeenCalledWith(
        'First message\nSecond message',
      );
    });
  });

  describe('agent routing and message augmentation', () => {
    it('augments messages with agent context when agents respond', async () => {
      mockResolveAndCollect.mockResolvedValue([
        { agent: 'agent-b', response: 'Agent B response' },
      ]);

      const inner = new MockChatModel();
      const generateSpy = vi.spyOn(inner, '_generate');

      const model = createSpellguardChatModel(inner);
      await model.invoke([new HumanMessage('Ask agent-b for data')]);

      expect(generateSpy).toHaveBeenCalledTimes(1);
      const augmentedMessages = generateSpy.mock.calls[0][0];
      const systemMsg = augmentedMessages.find(
        (m: BaseMessage) => m._getType() === 'system',
      );
      expect(systemMsg?.content).toContain('agent-b');
      expect(systemMsg?.content).toContain('Agent B response');
    });

    it('augments existing system message instead of prepending a new one', async () => {
      mockResolveAndCollect.mockResolvedValue([
        { agent: 'agent-b', response: 'Agent B data' },
      ]);

      const inner = new MockChatModel();
      const generateSpy = vi.spyOn(inner, '_generate');

      const model = createSpellguardChatModel(inner);
      await model.invoke([
        new SystemMessage('You are a helpful assistant.'),
        new HumanMessage('Ask agent-b'),
      ]);

      const augmented = generateSpy.mock.calls[0][0];
      const systemMsgs = augmented.filter(
        (m: BaseMessage) => m._getType() === 'system',
      );
      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].content).toContain('You are a helpful assistant.');
      expect(systemMsgs[0].content).toContain('agent-b');
    });

    it('handles multiple agent responses', async () => {
      mockResolveAndCollect.mockResolvedValue([
        { agent: 'agent-b', response: 'B data' },
        { agent: 'agent-c', response: 'C data' },
      ]);

      const inner = new MockChatModel();
      const generateSpy = vi.spyOn(inner, '_generate');

      const model = createSpellguardChatModel(inner);
      await model.invoke([new HumanMessage('Ask agent-b and agent-c')]);

      const augmented = generateSpy.mock.calls[0][0];
      const systemMsg = augmented.find(
        (m: BaseMessage) => m._getType() === 'system',
      );
      expect(systemMsg?.content).toContain('agent-b');
      expect(systemMsg?.content).toContain('agent-c');
    });
  });

  describe('error handling', () => {
    it('propagates policy block errors without calling wrapped model', async () => {
      mockResolveAndCollect.mockRejectedValue(new Error('Blocked by policy'));

      const inner = new MockChatModel();
      const generateSpy = vi.spyOn(inner, '_generate');
      const model = createSpellguardChatModel(inner);

      await expect(
        model.invoke([new HumanMessage('Ask agent-b')]),
      ).rejects.toThrow('Blocked by policy');
      expect(generateSpy).not.toHaveBeenCalled();
    });

    it('propagates rate limit errors without calling wrapped model', async () => {
      mockResolveAndCollect.mockRejectedValue(new Error('RATE_LIMITED'));

      const inner = new MockChatModel();
      const generateSpy = vi.spyOn(inner, '_generate');
      const model = createSpellguardChatModel(inner);

      await expect(
        model.invoke([new HumanMessage('Ask agent-b')]),
      ).rejects.toThrow('RATE_LIMITED');
      expect(generateSpy).not.toHaveBeenCalled();
    });

    it('delegates to wrapped model with original messages when collect returns empty', async () => {
      mockResolveAndCollect.mockResolvedValue([]);

      const inner = new MockChatModel();
      const generateSpy = vi.spyOn(inner, '_generate');
      const model = createSpellguardChatModel(inner);

      const result = await model.invoke([new HumanMessage('Ask agent-b')]);
      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toBe(MOCK_RESPONSE);

      // No system message augmentation when responses are empty
      const messages = generateSpy.mock.calls[0][0];
      const systemMsgs = messages.filter(
        (m: BaseMessage) => m._getType() === 'system',
      );
      expect(systemMsgs).toHaveLength(0);
    });
  });

  describe('_llmType', () => {
    it('prefixes the wrapped model type with spellguard-', () => {
      const model = createSpellguardChatModel(new MockChatModel());
      expect(model._llmType()).toBe('spellguard-mock');
    });
  });

  describe('streaming', () => {
    it('delegates to wrapped model _stream when available', async () => {
      mockResolveAndCollect.mockResolvedValue([]);
      const inner = new MockStreamingChatModel();

      const model = createSpellguardChatModel(inner);
      const chunks: string[] = [];
      for await (const chunk of await model.stream([
        new HumanMessage('Hello'),
      ])) {
        chunks.push(chunk.content as string);
      }

      expect(chunks).toEqual(['chunk1', 'chunk2']);
    });

    it('falls back to _generate chunks when wrapped model has no _stream', async () => {
      mockResolveAndCollect.mockResolvedValue([]);
      const inner = new MockChatModel(); // no _stream

      const model = createSpellguardChatModel(inner);
      const chunks: string[] = [];
      for await (const chunk of await model.stream([
        new HumanMessage('Hello'),
      ])) {
        chunks.push(chunk.content as string);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(MOCK_RESPONSE);
    });

    it('augments messages before streaming when agents respond', async () => {
      mockResolveAndCollect.mockResolvedValue([
        { agent: 'agent-b', response: 'Agent B stream response' },
      ]);

      const inner = new MockStreamingChatModel();
      const streamSpy = vi.spyOn(inner, '_streamResponseChunks');

      const model = createSpellguardChatModel(inner);
      const chunks: string[] = [];
      for await (const chunk of await model.stream([
        new HumanMessage('Ask agent-b'),
      ])) {
        chunks.push(chunk.content as string);
      }

      expect(mockResolveAndCollect).toHaveBeenCalled();
      const streamMessages = streamSpy.mock.calls[0][0];
      const systemMsg = streamMessages.find(
        (m: BaseMessage) => m._getType() === 'system',
      );
      expect(systemMsg?.content).toContain('agent-b');
    });
  });
});
