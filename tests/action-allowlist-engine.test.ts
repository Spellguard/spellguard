// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BuiltinEngine } from '../packages/verifier/src/proxy/builtin-engine';
import type { PolicyEvalContext } from '../packages/verifier/src/proxy/policy-evaluator-types';

describe('BuiltinEngine - Action Allowlist', () => {
  const engine = new BuiltinEngine();

  function createContext(
    content: string,
    config: Record<string, unknown> = {},
  ): PolicyEvalContext {
    return {
      content,
      binding: {
        policyId: 'test-action-allowlist',
        policyType: 'action-allowlist',
        policySlug: 'test-action-allowlist',
        level: 'agent',
        effect: 'block',
        config,
      },
      direction: 'outbound',
    };
  }

  describe('Tool call detection', () => {
    it('should allow actions in the allowlist', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [{ function: { name: 'search', arguments: '{}' } }],
        }),
        { allowedActions: ['search', 'summarize'] },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should block actions not in the allowlist', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [{ function: { name: 'delete_file', arguments: '{}' } }],
        }),
        { allowedActions: ['search', 'summarize'] },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('disallowed-action');
      expect(detections[0].message).toContain('delete_file');
    });

    it('should handle OpenAI format', async () => {
      const ctx = createContext(
        `{"tool_calls": [{"function": {"name": "search", "arguments": "{\\"query\\": \\"test\\"}"}}]}`,
        { allowedActions: ['search'] },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle Anthropic format', async () => {
      const ctx = createContext(
        `{"tools": [{"name": "search", "input": {"query": "test"}}]}`,
        { allowedActions: ['search'] },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should detect multiple disallowed actions', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [
            { function: { name: 'delete', arguments: '{}' } },
            { function: { name: 'execute', arguments: '{}' } },
          ],
        }),
        { allowedActions: ['search'] },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThanOrEqual(2);
    });

    it('should allow text messages without tool calls', async () => {
      const ctx = createContext('This is a normal message without any tools', {
        allowedActions: ['search'],
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Parameter constraints', () => {
    it('should detect missing required parameters', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [
            {
              function: {
                name: 'search',
                arguments: JSON.stringify({}),
              },
            },
          ],
        }),
        {
          allowedActions: ['search'],
          actionConstraints: {
            search: { query: 'required' },
          },
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('missing-required-parameter');
    });

    it('should detect forbidden parameters', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [
            {
              function: {
                name: 'search',
                arguments: JSON.stringify({ query: 'test', admin: true }),
              },
            },
          ],
        }),
        {
          allowedActions: ['search'],
          actionConstraints: {
            search: { admin: 'forbidden' },
          },
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('forbidden-parameter');
    });

    it('should detect parameter type mismatches', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [
            {
              function: {
                name: 'search',
                arguments: JSON.stringify({ query: 123 }),
              },
            },
          ],
        }),
        {
          allowedActions: ['search'],
          actionConstraints: {
            search: { query: { type: 'string' } },
          },
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('parameter-type-mismatch');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty allowlist as permissive', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [{ function: { name: 'anything', arguments: '{}' } }],
        }),
        { allowedActions: [] },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle malformed JSON gracefully', async () => {
      const ctx = createContext(
        '{"tool_calls": [{"function": {"name": "search", "arguments": "invalid json',
        { allowedActions: ['search'] },
      );
      const detections = await engine.evaluate(ctx);
      // Should not crash, may or may not detect
      expect(Array.isArray(detections)).toBe(true);
    });

    it('should handle function call syntax', async () => {
      const ctx = createContext('search("test query")', {
        allowedActions: ['search'],
        strictMode: true,
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not detect programming keywords', async () => {
      const ctx = createContext('if (condition) { return value; }', {
        allowedActions: ['search'],
        strictMode: true,
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });
});
