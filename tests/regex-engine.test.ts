// SPDX-License-Identifier: Apache-2.0

/**
 * Regex Engine Unit Tests
 *
 * Tests the regex policy engine that allows operators to define
 * custom regex patterns via policy config.
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeRegexBinding(
  patterns: Array<{ pattern: string; flags?: string; label?: string }>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'regex-test',
    level: 'org',
    effect: 'block',
    policyType: 'regex',
    policySlug: 'custom-regex',
    config: { patterns },
    ...overrides,
  };
}

describe('Regex Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── Basic pattern matching ───────────────────────────────────

  describe('basic pattern matching', () => {
    it('should detect a simple pattern match', async () => {
      const binding = makeRegexBinding([{ pattern: 'password\\s*=' }]);

      const results = await evaluatePolicies(
        [binding],
        'The password = hunter2',
      );
      expect(results).toHaveLength(1);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('regex-match');
      expect(results[0].detections[0].confidence).toBe(1.0);
      expect(results[0].detections[0].message).toContain('password\\s*=');
    });

    it('should permit content that does not match', async () => {
      const binding = makeRegexBinding([{ pattern: 'secret_key_[a-z]+' }]);

      const results = await evaluatePolicies(
        [binding],
        'Hello, this is clean content',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('allow');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should flag (not block) when effect is permit', async () => {
      const binding = makeRegexBinding([{ pattern: 'secret' }], {
        effect: 'flag',
      });

      const results = await evaluatePolicies(
        [binding],
        'This is a secret message',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Multiple patterns ────────────────────────────────────────

  describe('multiple patterns', () => {
    it('should detect multiple matching patterns', async () => {
      const binding = makeRegexBinding([
        { pattern: 'password', label: 'password-leak' },
        { pattern: 'api_key', label: 'api-key-leak' },
        { pattern: 'credit_card', label: 'cc-leak' },
      ]);

      const results = await evaluatePolicies(
        [binding],
        'My password is foo and api_key is bar',
      );
      expect(results[0].detections).toHaveLength(2);
      expect(results[0].detections[0].type).toBe('password-leak');
      expect(results[0].detections[1].type).toBe('api-key-leak');
    });

    it('should only return detections for patterns that match', async () => {
      const binding = makeRegexBinding([
        { pattern: 'foo', label: 'found-foo' },
        { pattern: 'bar', label: 'found-bar' },
        { pattern: 'baz', label: 'found-baz' },
      ]);

      const results = await evaluatePolicies([binding], 'only foo is here');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('found-foo');
    });
  });

  // ─── Custom labels ────────────────────────────────────────────

  describe('custom labels', () => {
    it('should use custom label when provided', async () => {
      const binding = makeRegexBinding([
        { pattern: 'sk_live_[a-zA-Z0-9]+', label: 'stripe-key' },
      ]);

      const results = await evaluatePolicies(
        [binding],
        'Key: sk_live_abc123XYZ',
      );
      expect(results[0].detections[0].type).toBe('stripe-key');
    });

    it('should default to "regex-match" when no label', async () => {
      const binding = makeRegexBinding([{ pattern: 'secret' }]);

      const results = await evaluatePolicies([binding], 'A secret here');
      expect(results[0].detections[0].type).toBe('regex-match');
    });
  });

  // ─── Flags ────────────────────────────────────────────────────

  describe('flags', () => {
    it('should default to case-insensitive matching', async () => {
      const binding = makeRegexBinding([{ pattern: 'password' }]);

      const results = await evaluatePolicies([binding], 'PASSWORD is leaked');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should respect explicit flags', async () => {
      // Case-sensitive flag — 'PASSWORD' should not match 'password'
      const binding = makeRegexBinding([{ pattern: 'password', flags: '' }]);

      const noMatch = await evaluatePolicies([binding], 'PASSWORD is here');
      expect(noMatch[0].detections).toHaveLength(0);

      const match = await evaluatePolicies([binding], 'password is here');
      expect(match[0].detections).toHaveLength(1);
    });

    it('should support global and multiline flags', async () => {
      const binding = makeRegexBinding([{ pattern: '^SECRET', flags: 'im' }]);

      const results = await evaluatePolicies(
        [binding],
        'first line\nSECRET on second line',
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Invalid regex handling ───────────────────────────────────

  describe('invalid regex', () => {
    it('should skip invalid regex patterns silently', async () => {
      const binding = makeRegexBinding([
        { pattern: '[invalid(', label: 'bad-regex' },
        { pattern: 'valid-word', label: 'good-regex' },
      ]);

      const results = await evaluatePolicies([binding], 'has valid-word in it');
      // Invalid regex skipped, valid one still works
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('good-regex');
    });

    it('should skip entries with missing pattern field', async () => {
      const binding = makeRegexBinding([
        { pattern: '' },
        { pattern: 'real-match', label: 'found' },
      ] as Array<{ pattern: string; label?: string }>);

      const results = await evaluatePolicies([binding], 'has real-match');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('found');
    });
  });

  // ─── Empty / missing config ───────────────────────────────────

  describe('empty config', () => {
    it('should return no detections when patterns array is empty', async () => {
      const binding = makeRegexBinding([]);

      const results = await evaluatePolicies([binding], 'any content');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should return no detections when config has no patterns key', async () => {
      const binding: ResolvedPolicyBinding = {
        policyId: 'regex-empty',
        level: 'org',
        effect: 'block',
        policyType: 'regex',
        policySlug: 'no-patterns',
        config: {},
      };

      const results = await evaluatePolicies([binding], 'any content');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should return no detections when config is undefined', async () => {
      const binding: ResolvedPolicyBinding = {
        policyId: 'regex-noconfig',
        level: 'org',
        effect: 'block',
        policyType: 'regex',
        policySlug: 'no-config',
      };

      const results = await evaluatePolicies([binding], 'any content');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Integration with evaluatePolicies decision logic ─────────

  describe('decision logic integration', () => {
    it('should work alongside builtin policies in same evaluatePolicies call', async () => {
      const bindings: ResolvedPolicyBinding[] = [
        {
          policyId: 'builtin-pii',
          level: 'org',
          effect: 'flag',
          policyType: 'builtin',
          policySlug: 'pii-detection',
        },
        makeRegexBinding(
          [{ pattern: 'api_key\\s*=', label: 'api-key-exposure' }],
          { policyId: 'regex-api-key' },
        ),
      ];

      const results = await evaluatePolicies(
        bindings,
        'Contact user@example.com, api_key = sk_123',
      );
      expect(results).toHaveLength(2);
      // Builtin PII detects email → flag (effect=permit)
      expect(results[0].policyId).toBe('builtin-pii');
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      // Regex engine detects api_key → deny (effect=block)
      expect(results[1].policyId).toBe('regex-api-key');
      expect(results[1].decision).toBe('deny');
      expect(results[1].responseLevel).toBe('block');
    });
  });
});
