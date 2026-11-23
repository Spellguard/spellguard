// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  BuiltinEngine,
  checkParameterValueConstraints,
} from '../packages/verifier/src/proxy/builtin-engine';
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

  describe('Parameter value constraints (enum / min / max / maxLength / pattern)', () => {
    // A supply-chain mandate on the tool leg: create_order may only ship to
    // registered countries, at most 120 units, against a Q-#### quote.
    const MANDATE = {
      allowedActions: ['create_order'],
      actionConstraints: {
        create_order: {
          quote_id: { type: 'string', pattern: '^Q-\\d{4}$' },
          quantity: { type: 'number', min: 1, max: 120 },
          ship_to_country: { type: 'string', enum: ['US', 'CA'] },
          idempotency_key: 'required',
          note: { type: 'string', maxLength: 10 },
        },
      },
    };

    function toolLegContext(
      params: Record<string, unknown>,
      direction: 'outbound' | 'inbound' = 'outbound',
    ): PolicyEvalContext {
      return {
        ...createContext('', MANDATE),
        direction,
        toolName: 'create_order',
        toolParams: params,
      } as PolicyEvalContext;
    }

    const conforming = {
      quote_id: 'Q-5001',
      quantity: 40,
      ship_to_country: 'US',
      idempotency_key: 'PO-1',
    };

    it('allows a call that satisfies every rule', async () => {
      const detections = await engine.evaluate(toolLegContext(conforming));
      expect(detections).toHaveLength(0);
    });

    it('reports one violation per broken rule, naming the parameter', async () => {
      const detections = await engine.evaluate(
        toolLegContext({
          ...conforming,
          quantity: 400,
          ship_to_country: 'AE',
        }),
      );
      expect(detections.map((d) => d.type)).toEqual([
        'parameter-constraint-violation',
        'parameter-constraint-violation',
      ]);
      expect(detections[0].message).toContain(
        '"quantity" must be a number <= 120',
      );
      expect(detections[1].message).toContain(
        '"ship_to_country" must be one of "US", "CA"',
      );
    });

    it('checks pattern and maxLength on strings and min on numbers', async () => {
      const detections = await engine.evaluate(
        toolLegContext({
          ...conforming,
          quote_id: 'QUOTE-1',
          quantity: 0,
          note: 'this note is too long',
        }),
      );
      const messages = detections.map((d) => d.message);
      expect(
        messages.some((m) => m.includes('"quote_id" must match ^Q-\\d{4}$')),
      ).toBe(true);
      expect(
        messages.some((m) => m.includes('"quantity" must be a number >= 1')),
      ).toBe(true);
      expect(
        messages.some((m) =>
          m.includes('"note" must be a string of at most 10'),
        ),
      ).toBe(true);
    });

    it('reports a type mismatch once and skips the value rules for that parameter', async () => {
      const detections = await engine.evaluate(
        toolLegContext({ ...conforming, quantity: 'forty' }),
      );
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('parameter-type-mismatch');
    });

    it('does not apply value rules on the inbound (tool result) phase', async () => {
      const detections = await engine.evaluate(
        toolLegContext({ ...conforming, quantity: 400 }, 'inbound'),
      );
      expect(detections).toHaveLength(0);
    });

    it('applies the same rules to tool calls parsed from the message leg', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [
            {
              function: {
                name: 'create_order',
                arguments: JSON.stringify({
                  ...conforming,
                  ship_to_country: 'IR',
                }),
              },
            },
          ],
        }),
        MANDATE,
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].message).toContain(
        '"ship_to_country" must be one of',
      );
    });

    it('fails closed on a constraint pattern safeRegex refuses', () => {
      expect(
        checkParameterValueConstraints('x', { pattern: '(a+)+$' }),
      ).toEqual(['has an unusable constraint pattern']);
    });

    it('treats a missing rule as satisfied and a matching enum of mixed types strictly', () => {
      expect(checkParameterValueConstraints('anything', {})).toEqual([]);
      expect(checkParameterValueConstraints(1, { enum: ['1'] })).toEqual([
        'must be one of "1"',
      ]);
      expect(
        checkParameterValueConstraints('US', { enum: ['US'], maxLength: 2 }),
      ).toEqual([]);
    });
  });

  describe('Computed values ($computed): an order total and its limit', () => {
    // internal design notes: an unattended order may not
    // exceed 50,000 USD, computed from the call's own parameters.
    const CEILING = {
      allowedActions: ['create_order'],
      actionConstraints: {
        create_order: {
          $computed: { order_total: 'quantity * unit_price' },
          order_total: { max: 50000 },
          quantity: { type: 'number', min: 1, max: 300 },
        },
      },
    };

    function orderCall(params: Record<string, unknown>): PolicyEvalContext {
      return {
        ...createContext('', CEILING),
        direction: 'outbound',
        toolName: 'create_order',
        toolParams: params,
      } as PolicyEvalContext;
    }

    it('allows an order within the limit', async () => {
      expect(
        await engine.evaluate(orderCall({ quantity: 8, unit_price: 5916 })),
      ).toEqual([]);
    });

    it('blocks the over-threshold order, naming the computation', async () => {
      const detections = await engine.evaluate(
        orderCall({ quantity: 120, unit_price: 544 }),
      );
      expect(detections).toEqual([
        expect.objectContaining({
          type: 'parameter-constraint-violation',
          message:
            'Action "create_order" value "order_total" (quantity 120 × unit_price 544 = 65280) must be a number <= 50000',
        }),
      ]);
    });

    it("fails closed when the total can't be computed", async () => {
      const detections = await engine.evaluate(
        orderCall({ quantity: 120, unit_price: 'call me' }),
      );
      expect(detections).toEqual([
        expect.objectContaining({
          type: 'computed-value-unavailable',
          message:
            'Action "create_order" value "order_total" can\'t be computed: "unit_price" is not a number',
        }),
      ]);
    });

    it('refuses a call that carries a parameter named like the computed value', async () => {
      // Otherwise the agent could state its own order_total.
      const detections = await engine.evaluate(
        orderCall({ quantity: 120, unit_price: 544, order_total: 1 }),
      );
      expect(detections.map((d) => d.type)).toEqual([
        'computed-value-unavailable',
      ]);
      expect(detections[0].message).toContain(
        'is also a parameter of the call',
      );
    });

    it('does not treat $computed as a parameter, and applies on the message leg too', async () => {
      const ctx = createContext(
        JSON.stringify({
          tool_calls: [
            {
              function: {
                name: 'create_order',
                arguments: JSON.stringify({ quantity: 40, unit_price: 3570 }),
              },
            },
          ],
        }),
        CEILING,
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].message).toContain(
        '= 142800) must be a number <= 50000',
      );
    });

    it('does not apply on the inbound (tool result) phase', async () => {
      const ctx = {
        ...orderCall({ quantity: 120, unit_price: 544 }),
        direction: 'inbound',
      } as PolicyEvalContext;
      expect(await engine.evaluate(ctx)).toEqual([]);
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
