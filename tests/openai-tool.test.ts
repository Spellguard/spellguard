// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the @spellguard/openai spellguardTool wrapper.
 *
 * Mocks checkToolPolicy to verify the wrapper produces correct
 * OpenAI tool definitions and handles all effect paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCheckToolPolicy } = vi.hoisted(() => ({
  mockCheckToolPolicy: vi.fn().mockResolvedValue({ effect: 'allow' }),
}));

vi.mock('@spellguard/client', () => ({
  checkToolPolicy: mockCheckToolPolicy,
}));

import { spellguardTool } from '../packages/openai/src/tool';

describe('OpenAI spellguardTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckToolPolicy.mockResolvedValue({ effect: 'allow' });
  });

  it('produces correct OpenAI tool definition', () => {
    const tool = spellguardTool({
      name: 'getWeather',
      description: 'Get weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      execute: async () => ({ temp: 72 }),
    });

    expect(tool.definition).toEqual({
      type: 'function',
      function: {
        name: 'getWeather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    });
    expect(typeof tool.execute).toBe('function');
  });

  it('passes through when both phases allow', async () => {
    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      parameters: {},
      execute: async (args: { key: string }) => ({ result: args.key }),
    });

    const result = await tool.execute({ key: 'val' });
    expect(result).toEqual({ result: 'val' });
    expect(mockCheckToolPolicy).toHaveBeenCalledTimes(2);
    expect(mockCheckToolPolicy).toHaveBeenCalledWith('input', 'testTool', {
      key: 'val',
    });
    expect(mockCheckToolPolicy).toHaveBeenCalledWith(
      'output',
      'testTool',
      { key: 'val' },
      { result: 'val' },
    );
  });

  it('blocks on input phase', async () => {
    mockCheckToolPolicy.mockResolvedValueOnce({
      effect: 'block',
      message: 'Secrets in input',
    });

    const executeSpy = vi.fn().mockResolvedValue('should-not-run');
    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      parameters: {},
      execute: executeSpy,
    });

    const result = await tool.execute({ secret: 'key' });
    expect(result).toBe('Secrets in input');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('treats input redact as block', async () => {
    mockCheckToolPolicy.mockResolvedValueOnce({ effect: 'redact' });

    const executeSpy = vi.fn().mockResolvedValue('should-not-run');
    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      parameters: {},
      execute: executeSpy,
    });

    const result = await tool.execute({});
    expect(result).toBe('[BLOCKED]');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('blocks on output phase', async () => {
    mockCheckToolPolicy
      .mockResolvedValueOnce({ effect: 'allow' })
      .mockResolvedValueOnce({ effect: 'block', message: 'PHI detected' });

    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      parameters: {},
      execute: async () => ({ ssn: '123-45-6789' }),
    });

    const result = await tool.execute({});
    expect(result).toBe('PHI detected');
  });

  it('redacts on output phase', async () => {
    mockCheckToolPolicy
      .mockResolvedValueOnce({ effect: 'allow' })
      .mockResolvedValueOnce({ effect: 'redact', data: null });

    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      parameters: {},
      execute: async () => 'sensitive',
    });

    const result = await tool.execute({});
    expect(result).toBeNull();
  });

  it('passes through on flag effect', async () => {
    mockCheckToolPolicy
      .mockResolvedValueOnce({ effect: 'flag' })
      .mockResolvedValueOnce({ effect: 'flag' });

    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      parameters: {},
      execute: async () => 'flagged-result',
    });

    const result = await tool.execute({});
    expect(result).toBe('flagged-result');
  });
});
