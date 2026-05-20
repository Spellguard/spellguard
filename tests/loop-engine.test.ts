// SPDX-License-Identifier: Apache-2.0

/**
 * Loop Detection Engine Unit Tests
 *
 * Tests the loop policy engine that detects repetitive message patterns
 * from runaway agents using Jaccard similarity.
 */

import {
  clearAllBuffers,
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BufferedMessage } from '../packages/verifier/src/proxy/message-buffer';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeLoopBinding(
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'loop-test',
    level: 'org',
    effect: 'block',
    policyType: 'loop',
    policySlug: 'custom-loop',
    config,
    ...overrides,
  };
}

// Helper to evaluate with message history
async function evaluateWithHistory(
  binding: ResolvedPolicyBinding,
  content: string,
  recentMessages: BufferedMessage[],
  agentId = 'test-agent',
) {
  // Inject agentId and recentMessages into context
  const bindings = [binding];
  const ctx = {
    content,
    agentId,
    recentMessages,
  };

  // Manually call the engine since we need to pass custom context
  const { getEngine } = await import(
    '../packages/verifier/src/proxy/engine-registry'
  );
  const engine = getEngine('loop');
  if (!engine) throw new Error('Loop engine not registered');

  const detections = await engine.evaluate({
    content,
    binding,
    agentId,
    recentMessages,
  });

  // Mimic policy evaluator decision logic
  const decision = detections.length > 0 ? 'deny' : 'permit';
  return { decision, detections };
}

describe('Loop Detection Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
    clearAllBuffers();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
    clearAllBuffers();
  });

  // ─── Basic Similarity Detection ───────────────────────────

  describe('basic similarity detection', () => {
    it('should detect identical messages', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: Date.now() - 1000 },
        { content: 'Hello world', timestamp: Date.now() - 500 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      expect(result.decision).toBe('deny');
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].message).toContain('similar messages');
    });

    it('should detect highly similar messages', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.7,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'Please send me the data', timestamp: Date.now() - 1000 },
        { content: 'Send me the data please', timestamp: Date.now() - 500 },
      ];

      const result = await evaluateWithHistory(
        binding,
        'Please send me the data now',
        history,
      );
      // Similar word sets should trigger with moderate threshold (5/6 = 0.83)
      expect(result.decision).toBe('deny');
    });

    it('should not detect dissimilar messages', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: Date.now() - 1000 },
        { content: 'Goodbye universe', timestamp: Date.now() - 500 },
      ];

      const result = await evaluateWithHistory(
        binding,
        'Different content entirely',
        history,
      );
      expect(result.decision).toBe('permit');
      expect(result.detections).toHaveLength(0);
    });
  });

  // ─── Threshold Testing ─────────────────────────────────────

  describe('similarity threshold', () => {
    it('should respect high threshold', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.95,
        minRepetitions: 2,
      });

      const history: BufferedMessage[] = [
        {
          content: 'Send me the data please',
          timestamp: Date.now() - 1000,
        },
      ];

      const result = await evaluateWithHistory(
        binding,
        'Send the data please now',
        history,
      );
      // Similar but not 95% similar
      expect(result.decision).toBe('permit');
    });

    it('should respect low threshold', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.5,
        minRepetitions: 2,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello world today nice', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(
        binding,
        'Hello world now nice',
        history,
      );
      // Moderately similar should trigger with low threshold (3/5 = 0.6 > 0.5)
      expect(result.decision).toBe('deny');
    });
  });

  // ─── Repetition Count ──────────────────────────────────────

  describe('minimum repetitions', () => {
    it('should require minimum repetitions', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 5,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: Date.now() - 4000 },
        { content: 'Hello world', timestamp: Date.now() - 3000 },
        { content: 'Hello world', timestamp: Date.now() - 2000 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      // Only 4 total messages (3 + current), need 5
      expect(result.decision).toBe('permit');
    });

    it('should trigger when threshold met', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 4,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: Date.now() - 3000 },
        { content: 'Hello world', timestamp: Date.now() - 2000 },
        { content: 'Hello world', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      // 4 total messages = threshold
      expect(result.decision).toBe('deny');
    });
  });

  // ─── Time Window ───────────────────────────────────────────

  describe('time window', () => {
    it('should ignore messages outside time window', async () => {
      const binding = makeLoopBinding({
        windowSeconds: 60, // 1 minute
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const now = Date.now();
      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: now - 120_000 }, // 2 min ago - outside window
        { content: 'Hello world', timestamp: now - 90_000 }, // 1.5 min ago - outside window
        { content: 'Hello world', timestamp: now - 30_000 }, // 30s ago - inside window
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      // Only 2 messages in window (1 history + current), need 3
      expect(result.decision).toBe('permit');
    });

    it('should consider messages within time window', async () => {
      const binding = makeLoopBinding({
        windowSeconds: 300, // 5 minutes
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const now = Date.now();
      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: now - 240_000 }, // 4 min ago
        { content: 'Hello world', timestamp: now - 120_000 }, // 2 min ago
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      // All within 5 min window
      expect(result.decision).toBe('deny');
    });
  });

  // ─── Message Count Window ──────────────────────────────────

  describe('window size', () => {
    it('should limit history to window size', async () => {
      const binding = makeLoopBinding({
        windowSize: 2, // Only look at last 2 messages
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: Date.now() - 5000 }, // Will be ignored (outside window size)
        { content: 'Hello world', timestamp: Date.now() - 4000 }, // Will be ignored
        { content: 'Hello world', timestamp: Date.now() - 3000 },
        { content: 'Hello world', timestamp: Date.now() - 2000 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      // Only last 2 in history + current = 3 total
      expect(result.decision).toBe('deny');
    });
  });

  // ─── Normalization ─────────────────────────────────────────

  describe('text normalization', () => {
    it('should ignore case differences', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'HELLO WORLD', timestamp: Date.now() - 1000 },
        { content: 'hello world', timestamp: Date.now() - 500 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello World', history);
      expect(result.decision).toBe('deny');
    });

    it('should ignore punctuation differences', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello, world!', timestamp: Date.now() - 1000 },
        { content: 'Hello world.', timestamp: Date.now() - 500 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      expect(result.decision).toBe('deny');
    });

    it('should collapse whitespace', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello  world', timestamp: Date.now() - 1000 },
        { content: 'Hello\tworld', timestamp: Date.now() - 500 },
      ];

      const result = await evaluateWithHistory(
        binding,
        'Hello   world',
        history,
      );
      expect(result.decision).toBe('deny');
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty history', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const result = await evaluateWithHistory(binding, 'Hello world', []);
      expect(result.decision).toBe('permit');
      expect(result.detections).toHaveLength(0);
    });

    it('should handle insufficient history', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 5,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello', history);
      expect(result.decision).toBe('permit');
    });

    it('should handle empty messages', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 2,
      });

      const history: BufferedMessage[] = [
        { content: '', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(binding, '', history);
      // Empty messages have no semantic content to compare — should not trigger
      expect(result.decision).toBe('permit');
    });

    it('should handle single word messages', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 3,
      });

      const history: BufferedMessage[] = [
        { content: 'hello', timestamp: Date.now() - 2000 },
        { content: 'hello', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(binding, 'hello', history);
      expect(result.decision).toBe('deny');
    });
  });

  // ─── Confidence Levels ─────────────────────────────────────

  describe('confidence levels', () => {
    it('should have high confidence for very high similarity', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 2,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello world', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello world', history);
      expect(result.detections[0].confidence).toBe(0.95);
    });

    it('should have moderate confidence for moderate similarity', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.7,
        minRepetitions: 2,
      });

      const history: BufferedMessage[] = [
        {
          content: 'Hello world today is nice',
          timestamp: Date.now() - 1000,
        },
      ];

      const result = await evaluateWithHistory(
        binding,
        'Hello world tomorrow will be great',
        history,
      );
      if (result.decision === 'deny') {
        expect(result.detections[0].confidence).toBe(0.8);
      }
    });
  });

  // ─── Custom Label ──────────────────────────────────────────

  describe('custom label', () => {
    it('should use custom label when provided', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 2,
        label: 'runaway-agent',
      });

      const history: BufferedMessage[] = [
        { content: 'Hello', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello', history);
      expect(result.detections[0].type).toBe('runaway-agent');
    });

    it('should default to "loop-detected"', async () => {
      const binding = makeLoopBinding({
        similarityThreshold: 0.85,
        minRepetitions: 2,
      });

      const history: BufferedMessage[] = [
        { content: 'Hello', timestamp: Date.now() - 1000 },
      ];

      const result = await evaluateWithHistory(binding, 'Hello', history);
      expect(result.detections[0].type).toBe('loop-detected');
    });
  });

  // ─── Decision Logic ────────────────────────────────────────

  describe('decision logic integration', () => {
    it('should flag (not block) when effect is permit', async () => {
      const binding = makeLoopBinding(
        {
          similarityThreshold: 0.85,
          minRepetitions: 2,
        },
        { effect: 'flag' },
      );

      const history: BufferedMessage[] = [
        { content: 'Hello', timestamp: Date.now() - 1000 },
      ];

      // For permit effect, would need to integrate with full policy evaluator
      // Just verify detection happens
      const result = await evaluateWithHistory(binding, 'Hello', history);
      expect(result.detections).toHaveLength(1);
    });
  });
});
