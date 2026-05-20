// SPDX-License-Identifier: Apache-2.0

/**
 * Schema Engine Unit Tests
 *
 * Tests the schema policy engine that validates message content
 * against a JSON Schema.
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeSchemaBinding(
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'schema-test',
    level: 'org',
    effect: 'block',
    policyType: 'schema',
    policySlug: 'custom-schema',
    config,
    ...overrides,
  };
}

const actionSchema = {
  type: 'object',
  required: ['action', 'target'],
  properties: {
    action: { type: 'string', enum: ['read', 'write', 'delete'] },
    target: { type: 'string' },
    params: { type: 'object' },
  },
  additionalProperties: false,
};

describe('Schema Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── Full mode — valid JSON ─────────────────────────────────

  describe('full mode - valid JSON, valid schema', () => {
    it('should produce no detections for valid content', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'full',
      });

      const content = JSON.stringify({
        action: 'read',
        target: '/data/users',
      });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should detect validation failure for invalid content', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'full',
      });

      const content = JSON.stringify({
        action: 'execute', // not in enum
        target: '/data/users',
      });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('schema-violation');
      expect(results[0].detections[0].confidence).toBe(1.0);
      expect(results[0].detections[0].message).toContain('validation failed');
    });

    it('should detect missing required properties', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
      });

      const content = JSON.stringify({
        action: 'read',
        // missing 'target'
      });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('target');
    });

    it('should detect additional properties when not allowed', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
      });

      const content = JSON.stringify({
        action: 'read',
        target: '/data',
        extraField: true,
      });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain(
        'additional properties',
      );
    });
  });

  // ─── Full mode — invalid JSON ──────────────────────────────

  describe('full mode - invalid JSON', () => {
    it('should detect non-JSON content', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
      });

      const results = await evaluatePolicies(
        [binding],
        'This is not JSON at all',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('schema-violation');
      expect(results[0].detections[0].message).toContain('Invalid JSON');
    });

    it('should detect malformed JSON', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
      });

      const results = await evaluatePolicies(
        [binding],
        '{ "action": "read", }',
      );
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('Invalid JSON');
    });
  });

  // ─── Partial mode ──────────────────────────────────────────

  describe('partial mode', () => {
    it('should extract and validate JSON from mixed content', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'partial',
      });

      const content =
        'Here is the command: {"action": "read", "target": "/data"} please execute it.';

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should detect invalid JSON blocks in mixed content', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'partial',
      });

      const content =
        'Execute this: {"action": "execute", "target": "/data"} now.';

      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('validation failed');
    });

    it('should return no detections when no JSON blocks found', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'partial',
      });

      const results = await evaluatePolicies(
        [binding],
        'Plain text with no JSON',
      );
      expect(results[0].detections).toHaveLength(0);
    });

    it('should validate multiple JSON blocks', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'partial',
      });

      const content =
        'First: {"action": "read", "target": "/a"} and second: {"action": "execute", "target": "/b"} done.';

      const results = await evaluatePolicies([binding], content);
      // First block valid, second invalid
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Custom label ──────────────────────────────────────────

  describe('custom label', () => {
    it('should use custom label when provided', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        label: 'protocol-violation',
      });

      const content = JSON.stringify({ action: 'execute', target: '/data' });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections[0].type).toBe('protocol-violation');
    });

    it('should default to "schema-violation" when no label', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
      });

      const content = JSON.stringify({ action: 'execute', target: '/data' });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections[0].type).toBe('schema-violation');
    });
  });

  // ─── Schema caching ────────────────────────────────────────

  describe('schema caching', () => {
    it('should handle the same schema used across multiple evaluations', async () => {
      const binding = makeSchemaBinding({ schema: actionSchema });

      const valid = JSON.stringify({ action: 'read', target: '/data' });
      const invalid = JSON.stringify({ action: 'execute', target: '/data' });

      const results1 = await evaluatePolicies([binding], valid);
      expect(results1[0].detections).toHaveLength(0);

      const results2 = await evaluatePolicies([binding], invalid);
      expect(results2[0].detections).toHaveLength(1);

      // Run valid again to ensure cache didn't get corrupted
      const results3 = await evaluatePolicies([binding], valid);
      expect(results3[0].detections).toHaveLength(0);
    });
  });

  // ─── Empty / missing config ────────────────────────────────

  describe('empty config', () => {
    it('should return no detections when schema is missing', async () => {
      const binding = makeSchemaBinding({});

      const results = await evaluatePolicies([binding], '{"any": "content"}');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should return no detections when config is undefined', async () => {
      const binding: ResolvedPolicyBinding = {
        policyId: 'schema-noconfig',
        level: 'org',
        effect: 'block',
        policyType: 'schema',
        policySlug: 'no-config',
      };

      const results = await evaluatePolicies([binding], '{"any": "content"}');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── extractPattern config ────────────────────────────────

  describe('extractPattern config', () => {
    it('should extract JSON using custom extractPattern regex', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'partial',
        extractPattern: '"json":\\s*(\\{[^}]+\\})',
      });

      const content =
        'response "json": {"action": "read", "target": "/data"} end';

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should fall back to bracket extraction on invalid extractPattern regex', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'partial',
        extractPattern: '[invalid(',
      });

      // Should fall back and find the balanced JSON block
      const content = 'here is {"action": "read", "target": "/data"} the end';

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Partial mode edge cases ─────────────────────────────

  describe('partial mode edge cases', () => {
    it('should detect unparseable balanced blocks as invalid JSON', async () => {
      const binding = makeSchemaBinding({
        schema: actionSchema,
        mode: 'partial',
      });

      const content = 'text {not: valid: json} more';

      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('Invalid JSON block');
    });

    it('should extract and validate array blocks in partial mode', async () => {
      const arraySchema = {
        type: 'array',
        items: { type: 'number' },
      };
      const binding = makeSchemaBinding({
        schema: arraySchema,
        mode: 'partial',
      });

      const content = 'list: [1, 2, 3] done';

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Long AJV path truncation ─────────────────────────────

  describe('long AJV path truncation', () => {
    it('should truncate deeply nested path exceeding 60 characters', async () => {
      const schema = {
        type: 'object',
        required: ['level1'],
        properties: {
          level1: {
            type: 'object',
            required: ['level2'],
            properties: {
              level2: {
                type: 'object',
                required: ['level3'],
                properties: {
                  level3: {
                    type: 'object',
                    required: ['deeplyNestedFieldName'],
                    properties: {
                      deeplyNestedFieldName: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      };
      const binding = makeSchemaBinding({ schema, mode: 'full' });
      const content = JSON.stringify({
        level1: { level2: { level3: {} } },
      });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections).toHaveLength(1);
      // Path "level1.level2.level3.deeplyNestedFieldName" is within 60 chars
      // but the message should still use dot notation, not slash notation
      expect(results[0].detections[0].message).not.toMatch(/\/level1\/level2/);
      expect(results[0].detections[0].message).toMatch(
        /level1\.level2\.level3/,
      );
    });
  });

  // ─── Integration ───────────────────────────────────────────

  describe('decision logic integration', () => {
    it('should flag (not block) when effect is permit', async () => {
      const binding = makeSchemaBinding(
        { schema: actionSchema },
        { effect: 'flag' },
      );

      const content = JSON.stringify({ action: 'execute', target: '/data' });

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      expect(results[0].detections).toHaveLength(1);
    });
  });
});
