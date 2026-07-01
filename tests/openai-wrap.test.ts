// SPDX-License-Identifier: Apache-2.0

import { wrapOpenAI } from '@spellguard/openai';
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
  ) =>
    responses
      .map(
        (r) =>
          `--- Response from ${r.agent} ---\n${r.response}\n--- End response from ${r.agent} ---`,
      )
      .join('\n\n'),
}));

// ─── Test doubles ─────────────────────────────────────────────────

const MOCK_RESPONSE = 'Mock OpenAI response';

function makeMockOpenAI() {
  const mockCreate = vi.fn().mockResolvedValue({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: MOCK_RESPONSE },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  return {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
    _mockCreate: mockCreate,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('wrapOpenAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAndCollect.mockResolvedValue([]);
  });

  describe('pass-through (no agent references)', () => {
    it('passes messages through unchanged when no agents respond', async () => {
      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      const messages = [{ role: 'user' as const, content: 'What is 2+2?' }];
      await client.chat.completions.create({ model: 'gpt-4o', messages });

      expect(mock._mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ messages }),
        undefined,
      );
    });

    it('returns the OpenAI response unchanged', async () => {
      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      const result = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.choices[0].message.content).toBe(MOCK_RESPONSE);
    });

    it('calls resolveAndCollectAgentResponses with extracted prompt', async () => {
      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello world' },
        ],
      });

      expect(mockResolveAndCollect).toHaveBeenCalledWith('Hello world');
    });

    it('concatenates multiple user messages for prompt extraction', async () => {
      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'Reply' },
          { role: 'user', content: 'Second message' },
        ],
      });

      expect(mockResolveAndCollect).toHaveBeenCalledWith(
        'First message\nSecond message',
      );
    });
  });

  describe('agent routing', () => {
    it('augments messages with agent responses as a system message', async () => {
      mockResolveAndCollect.mockResolvedValue([
        { agent: 'agent-b', response: 'Lab results: all normal' },
      ]);

      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Analyse data from Agent B' }],
      });

      const calledWith = mock._mockCreate.mock.calls[0][0];
      const systemMsg = calledWith.messages.find(
        (m: { role: string }) => m.role === 'system',
      );
      expect(systemMsg).toBeDefined();
      expect(systemMsg.content).toContain('agent-b');
      expect(systemMsg.content).toContain('Lab results: all normal');
    });

    it('prepends system message when none exists', async () => {
      mockResolveAndCollect.mockResolvedValue([
        { agent: 'agent-b', response: 'Some data' },
      ]);

      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Get data from Agent B' }],
      });

      const calledWith = mock._mockCreate.mock.calls[0][0];
      expect(calledWith.messages[0].role).toBe('system');
    });

    it('appends context to existing system message', async () => {
      mockResolveAndCollect.mockResolvedValue([
        { agent: 'agent-b', response: 'Some data' },
      ]);

      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Get data from Agent B' },
        ],
      });

      const calledWith = mock._mockCreate.mock.calls[0][0];
      const systemMsg = calledWith.messages.find(
        (m: { role: string }) => m.role === 'system',
      );
      expect(systemMsg.content).toContain('You are a helpful assistant.');
      expect(systemMsg.content).toContain('agent-b');
    });

    it('re-throws errors from resolveAndCollectAgentResponses', async () => {
      mockResolveAndCollect.mockRejectedValue(
        new Error('Blocked by policy: content violation'),
      );

      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      await expect(
        client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Get data from Agent B' }],
        }),
      ).rejects.toThrow('Blocked by policy');

      expect(mock._mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('proxy transparency', () => {
    it('preserves other client properties through the proxy', () => {
      const mock = {
        ...makeMockOpenAI(),
        apiKey: 'test-key',
        baseURL: 'https://api.openai.com/v1',
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      expect((client as any).apiKey).toBe('test-key');
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      expect((client as any).baseURL).toBe('https://api.openai.com/v1');
    });

    it('intercepts create() but passes through other completions methods', () => {
      const mockStream = vi.fn().mockReturnValue('stream-result');
      const mock = {
        ...makeMockOpenAI(),
        chat: {
          completions: {
            create: vi.fn(),
            stream: mockStream,
          },
        },
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      expect(typeof (client as any).chat.completions.stream).toBe('function');
    });
  });

  describe('model passthrough', () => {
    it('preserves model and other params when calling original create()', async () => {
      const mock = makeMockOpenAI();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const client = wrapOpenAI(mock as any);

      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 500,
      });

      expect(mock._mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-mini',
          temperature: 0.7,
          max_tokens: 500,
        }),
        undefined,
      );
    });
  });
});
