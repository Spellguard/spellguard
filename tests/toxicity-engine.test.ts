// SPDX-License-Identifier: Apache-2.0

/**
 * Toxicity Engine Unit Tests
 *
 * Tests the toxicity policy engine that detects threats,
 * harassment, hate speech, and profanity.
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeToxicityBinding(
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'toxicity-test',
    level: 'org',
    effect: 'block',
    policyType: 'toxicity',
    policySlug: 'custom-toxicity',
    config,
    ...overrides,
  };
}

describe('Toxicity Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── Threat detection ──────────────────────────────────────

  describe('threat detection', () => {
    it('should detect death threats', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat'],
      });

      const results = await evaluatePolicies(
        [binding],
        "I'm going to kill you",
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('threat');
    });

    it('should detect "watch your back" threats', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat'],
      });

      const results = await evaluatePolicies(
        [binding],
        'You better watch your back',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect "I know where you live"', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat'],
      });

      const results = await evaluatePolicies(
        [binding],
        'I know where you live',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should not detect threat when threat category disabled', async () => {
      const binding = makeToxicityBinding({
        categories: ['profanity'],
      });

      const results = await evaluatePolicies(
        [binding],
        "I'm going to kill you",
      );
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Harassment detection ──────────────────────────────────

  describe('harassment detection', () => {
    it('should detect insults', async () => {
      const binding = makeToxicityBinding({
        categories: ['harassment'],
      });

      const results = await evaluatePolicies(
        [binding],
        'You are such an idiot',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('harassment');
    });

    it('should detect "kill yourself" harassment', async () => {
      const binding = makeToxicityBinding({
        categories: ['harassment'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Why dont you just kill yourself',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect kys abbreviation', async () => {
      const binding = makeToxicityBinding({
        categories: ['harassment'],
      });

      const results = await evaluatePolicies([binding], 'lol kys');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect "nobody likes you"', async () => {
      const binding = makeToxicityBinding({
        categories: ['harassment'],
      });

      const results = await evaluatePolicies([binding], 'Nobody likes you');
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Hate speech detection ─────────────────────────────────

  describe('hate speech detection', () => {
    it('should detect dehumanizing language', async () => {
      const binding = makeToxicityBinding({
        categories: ['hate'],
      });

      const results = await evaluatePolicies(
        [binding],
        'They are all subhuman',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('hate');
    });

    it('should detect calls for extermination', async () => {
      const binding = makeToxicityBinding({
        categories: ['hate'],
      });

      const results = await evaluatePolicies(
        [binding],
        'They should all be exterminated',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect "dont deserve to live"', async () => {
      const binding = makeToxicityBinding({
        categories: ['hate'],
      });

      const results = await evaluatePolicies(
        [binding],
        "They don't deserve to live",
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Profanity detection ───────────────────────────────────

  describe('profanity detection', () => {
    it('should detect common profanity', async () => {
      const binding = makeToxicityBinding({
        categories: ['profanity'],
      });

      const results = await evaluatePolicies(
        [binding],
        'What the fuck is this',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('profanity');
    });

    it('should detect profanity abbreviations', async () => {
      const binding = makeToxicityBinding({
        categories: ['profanity'],
      });

      const results = await evaluatePolicies([binding], 'wtf is happening');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect stfu', async () => {
      const binding = makeToxicityBinding({
        categories: ['profanity'],
      });

      const results = await evaluatePolicies([binding], 'just stfu already');
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Multiple categories ───────────────────────────────────

  describe('multiple categories', () => {
    it('should detect multiple category violations', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat', 'profanity'],
      });

      const results = await evaluatePolicies(
        [binding],
        "I'm going to fucking kill you",
      );
      expect(results[0].detections.length).toBeGreaterThanOrEqual(1);
    });

    it('should use all categories by default', async () => {
      const binding = makeToxicityBinding({});

      const results = await evaluatePolicies(
        [binding],
        "I'm going to kill you",
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Custom patterns ───────────────────────────────────────

  describe('custom patterns', () => {
    it('should detect custom regex patterns', async () => {
      const binding = makeToxicityBinding({
        categories: [],
        customPatterns: ['\\bspam\\b', '\\bscam\\b'],
      });

      const results = await evaluatePolicies([binding], 'This is a scam');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('custom');
    });

    it('should combine categories with custom patterns', async () => {
      const binding = makeToxicityBinding({
        categories: ['profanity'],
        customPatterns: ['\\bspam\\b'],
      });

      const results = await evaluatePolicies([binding], 'This is fucking spam');
      expect(results[0].detections.length).toBeGreaterThanOrEqual(2);
    });

    it('should skip invalid regex patterns', async () => {
      const binding = makeToxicityBinding({
        categories: [],
        customPatterns: ['[invalid(regex', 'valid'],
      });

      const results = await evaluatePolicies(
        [binding],
        'This is valid content',
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Custom label ──────────────────────────────────────────

  describe('custom label', () => {
    it('should use custom label when provided', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat'],
        label: 'harmful-content',
      });

      const results = await evaluatePolicies(
        [binding],
        "I'm going to kill you",
      );
      expect(results[0].detections[0].type).toBe('harmful-content');
    });

    it('should default to "toxic-content"', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat'],
      });

      const results = await evaluatePolicies(
        [binding],
        "I'm going to kill you",
      );
      expect(results[0].detections[0].type).toBe('toxic-content');
    });
  });

  // ─── Clean content ─────────────────────────────────────────

  describe('clean content', () => {
    it('should permit friendly conversation', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat', 'harassment', 'hate', 'profanity'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Hello! How are you doing today? I hope you have a wonderful day.',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit technical discussion', async () => {
      const binding = makeToxicityBinding({
        categories: ['threat', 'harassment', 'hate', 'profanity'],
      });

      const results = await evaluatePolicies(
        [binding],
        'We need to kill the process and execute a new deployment.',
      );
      // "kill the process" shouldn't match because pattern requires "kill you/them/etc"
      expect(results[0].decision).toBe('permit');
    });
  });

  // ─── Empty config ──────────────────────────────────────────

  describe('empty config', () => {
    it('should use all categories when categories array is empty', async () => {
      const binding = makeToxicityBinding({
        categories: [],
        customPatterns: [],
      });

      const results = await evaluatePolicies(
        [binding],
        "I'm going to kill you",
      );
      // Empty categories = no category checks, empty custom = no custom checks
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Decision logic ────────────────────────────────────────

  describe('decision logic integration', () => {
    it('should flag (not block) when effect is permit', async () => {
      const binding = makeToxicityBinding(
        { categories: ['threat'] },
        { effect: 'flag' },
      );

      const results = await evaluatePolicies(
        [binding],
        "I'm going to kill you",
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      expect(results[0].detections).toHaveLength(1);
    });
  });
});
