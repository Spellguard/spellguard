// SPDX-License-Identifier: Apache-2.0

/**
 * Keyword Engine Unit Tests
 *
 * Tests the keyword policy engine that performs exact keyword matching
 * with optional word boundary enforcement.
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeKeywordBinding(
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'keyword-test',
    level: 'org',
    effect: 'block',
    policyType: 'keyword',
    policySlug: 'custom-keyword',
    config,
    ...overrides,
  };
}

describe('Keyword Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── Basic matching ─────────────────────────────────────────

  describe('basic matching', () => {
    it('should detect a keyword in content', async () => {
      const binding = makeKeywordBinding({
        keywords: ['password'],
      });

      const results = await evaluatePolicies(
        [binding],
        'The password is hunter2',
      );
      expect(results).toHaveLength(1);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('keyword-match');
      expect(results[0].detections[0].confidence).toBe(1.0);
      expect(results[0].detections[0].message).toContain('password');
    });

    it('should permit content with no matching keywords', async () => {
      const binding = makeKeywordBinding({
        keywords: ['secret', 'token'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Hello, this is clean content',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Whole word matching ───────────────────────────────────

  describe('whole word matching', () => {
    it('should NOT match inside other words by default (matchWholeWord defaults to true)', async () => {
      const binding = makeKeywordBinding({
        keywords: ['pass'],
      });

      const results = await evaluatePolicies(
        [binding],
        'The password is compromised',
      );
      expect(results[0].detections).toHaveLength(0);
    });

    it('should match the exact word with word boundaries', async () => {
      const binding = makeKeywordBinding({
        keywords: ['pass'],
      });

      const results = await evaluatePolicies([binding], 'Please pass the salt');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should match inside words when matchWholeWord is false', async () => {
      const binding = makeKeywordBinding({
        keywords: ['pass'],
        matchWholeWord: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'The password is compromised',
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Case sensitivity ──────────────────────────────────────

  describe('case sensitivity', () => {
    it('should be case-insensitive by default', async () => {
      const binding = makeKeywordBinding({
        keywords: ['password'],
      });

      const results = await evaluatePolicies(
        [binding],
        'The PASSWORD is leaked',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should respect caseSensitive: true', async () => {
      const binding = makeKeywordBinding({
        keywords: ['SECRET'],
        caseSensitive: true,
      });

      const noMatch = await evaluatePolicies([binding], 'The secret is here');
      expect(noMatch[0].detections).toHaveLength(0);

      const match = await evaluatePolicies([binding], 'The SECRET is here');
      expect(match[0].detections).toHaveLength(1);
    });
  });

  // ─── Multiple keywords ─────────────────────────────────────

  describe('multiple keywords', () => {
    it('should detect multiple matching keywords', async () => {
      const binding = makeKeywordBinding({
        keywords: ['password', 'secret', 'token'],
      });

      const results = await evaluatePolicies(
        [binding],
        'The password and secret are here',
      );
      expect(results[0].detections).toHaveLength(2);
    });

    it('should only return detections for keywords that match', async () => {
      const binding = makeKeywordBinding({
        keywords: ['foo', 'bar', 'baz'],
      });

      const results = await evaluatePolicies([binding], 'only foo is here');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('foo');
    });
  });

  // ─── Custom label ──────────────────────────────────────────

  describe('custom label', () => {
    it('should use custom label when provided', async () => {
      const binding = makeKeywordBinding({
        keywords: ['api_key'],
        label: 'sensitive-keyword',
      });

      const results = await evaluatePolicies(
        [binding],
        'The api_key is exposed',
      );
      expect(results[0].detections[0].type).toBe('sensitive-keyword');
    });

    it('should default to "keyword-match" when no label', async () => {
      const binding = makeKeywordBinding({
        keywords: ['secret'],
      });

      const results = await evaluatePolicies([binding], 'A secret here');
      expect(results[0].detections[0].type).toBe('keyword-match');
    });
  });

  // ─── Empty / missing config ────────────────────────────────

  describe('empty config', () => {
    it('should return no detections when keywords array is empty', async () => {
      const binding = makeKeywordBinding({ keywords: [] });

      const results = await evaluatePolicies([binding], 'any content');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should return no detections when config has no keywords key', async () => {
      const binding = makeKeywordBinding({});

      const results = await evaluatePolicies([binding], 'any content');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should skip empty string keywords', async () => {
      const binding = makeKeywordBinding({
        keywords: ['', 'match'],
      });

      const results = await evaluatePolicies([binding], 'has match here');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('match');
    });
  });

  // ─── Non-string items in array ─────────────────────────────

  describe('non-string items', () => {
    it('should skip non-string items in keywords array', async () => {
      const binding = makeKeywordBinding({
        keywords: [123, null, 'match', undefined, true],
      });

      const results = await evaluatePolicies([binding], 'has match here');
      // Only the string 'match' should produce a detection
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('match');
    });
  });

  // ─── Special characters ────────────────────────────────────

  describe('special characters', () => {
    it('should handle keywords with regex special characters (whole word off)', async () => {
      const binding = makeKeywordBinding({
        keywords: ['api.key', '$secret'],
        matchWholeWord: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'The $secret was found',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should match regex-special keywords at word boundaries', async () => {
      const binding = makeKeywordBinding({
        keywords: ['api_key'],
      });

      const results = await evaluatePolicies(
        [binding],
        'The api_key is leaked',
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Integration ───────────────────────────────────────────

  describe('decision logic integration', () => {
    it('should flag (not block) when effect is permit', async () => {
      const binding = makeKeywordBinding(
        { keywords: ['secret'] },
        { effect: 'flag' },
      );

      const results = await evaluatePolicies(
        [binding],
        'This is a secret message',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      expect(results[0].detections).toHaveLength(1);
    });
  });
});
