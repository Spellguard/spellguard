// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the @spellguard/langchain spellguardTool wrapper.
 *
 * Mocks checkToolPolicy and @langchain/core/tools to verify
 * the wrapper handles all effect paths correctly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCheckToolPolicy } = vi.hoisted(() => ({
  mockCheckToolPolicy: vi.fn().mockResolvedValue({ effect: 'allow' }),
}));

vi.mock('@spellguard/client', () => ({
  checkToolPolicy: mockCheckToolPolicy,
}));

// Mock DynamicStructuredTool to capture the func that gets passed in
vi.mock('@langchain/core/tools', () => ({
  DynamicStructuredTool: class MockDynamicStructuredTool {
    name: string;
    description: string;
    func: (...args: unknown[]) => Promise<string>;
    constructor(opts: {
      name: string;
      description: string;
      func: (...args: unknown[]) => Promise<string>;
    }) {
      this.name = opts.name;
      this.description = opts.description;
      this.func = opts.func;
    }
  },
}));

import { spellguardTool } from '../packages/langchain/ts/src/tool';

describe('LangChain spellguardTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckToolPolicy.mockResolvedValue({ effect: 'allow' });
  });

  it('passes through when both phases allow', async () => {
    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      schema: {} as never,
      func: async () => 'real-result',
    });

    // The mock DynamicStructuredTool stores func directly
    const result = await (
      tool as unknown as { func: (input: unknown) => Promise<string> }
    ).func({ key: 'val' });
    expect(result).toBe('real-result');
    expect(mockCheckToolPolicy).toHaveBeenCalledTimes(2);
    expect(mockCheckToolPolicy).toHaveBeenCalledWith('input', 'testTool', {
      key: 'val',
    });
    expect(mockCheckToolPolicy).toHaveBeenCalledWith(
      'output',
      'testTool',
      { key: 'val' },
      'real-result',
    );
  });

  it('blocks on input phase', async () => {
    mockCheckToolPolicy.mockResolvedValueOnce({
      effect: 'block',
      message: 'Blocked',
    });

    const executeSpy = vi.fn().mockResolvedValue('should-not-run');
    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      schema: {} as never,
      func: executeSpy,
    });

    const result = await (
      tool as unknown as { func: (input: unknown) => Promise<string> }
    ).func({});
    expect(result).toBe('Blocked');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('treats input redact as block', async () => {
    mockCheckToolPolicy.mockResolvedValueOnce({ effect: 'redact' });

    const executeSpy = vi.fn().mockResolvedValue('should-not-run');
    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      schema: {} as never,
      func: executeSpy,
    });

    const result = await (
      tool as unknown as { func: (input: unknown) => Promise<string> }
    ).func({});
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
      schema: {} as never,
      func: async () => 'sensitive-data',
    });

    const result = await (
      tool as unknown as { func: (input: unknown) => Promise<string> }
    ).func({});
    expect(result).toBe('PHI detected');
  });

  it('redacts on output phase', async () => {
    mockCheckToolPolicy
      .mockResolvedValueOnce({ effect: 'allow' })
      .mockResolvedValueOnce({ effect: 'redact', data: null });

    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      schema: {} as never,
      func: async () => 'sensitive-data',
    });

    const result = await (
      tool as unknown as { func: (input: unknown) => Promise<string> }
    ).func({});
    expect(result).toBe('');
  });

  it('passes through on flag effect', async () => {
    mockCheckToolPolicy
      .mockResolvedValueOnce({ effect: 'flag' })
      .mockResolvedValueOnce({ effect: 'flag' });

    const tool = spellguardTool({
      name: 'testTool',
      description: 'test',
      schema: {} as never,
      func: async () => 'flagged-result',
    });

    const result = await (
      tool as unknown as { func: (input: unknown) => Promise<string> }
    ).func({});
    expect(result).toBe('flagged-result');
  });
});
