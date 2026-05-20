// SPDX-License-Identifier: Apache-2.0

/**
 * Loop Detection Engine.
 *
 * Detects repetitive message patterns from runaway agents by calculating
 * Jaccard similarity on normalized word sets and comparing against recent
 * message history.
 *
 * Config shape (on binding.config):
 *   windowSize?: number           — messages to look back (default: 5)
 *   windowSeconds?: number        — time window in seconds (default: 300)
 *   similarityThreshold?: number  — 0-1, trigger threshold (default: 0.85)
 *   minRepetitions?: number       — how many similar needed (default: 3)
 *   label?: string                — detection label, default: 'loop-detected'
 *
 * Example binding config:
 *   {
 *     "windowSize": 5,
 *     "windowSeconds": 300,
 *     "similarityThreshold": 0.85,
 *     "minRepetitions": 3
 *   }
 */

import type { BufferedMessage } from './message-buffer';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

/**
 * Normalize text for comparison:
 * - Lowercase
 * - Strip punctuation
 * - Collapse whitespace
 * - Return word set
 */
function normalizeToWordSet(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();

  const words = normalized.split(' ').filter((w) => w.length > 0);
  return new Set(words);
}

/**
 * Calculate Jaccard similarity between two sets.
 * Similarity = |intersection| / |union|
 */
function jaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
  if (set1.size === 0 || set2.size === 0) return 0.0; // Empty = no content to compare

  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  return intersection.size / union.size;
}

export class LoopEngine implements PolicyEngine {
  readonly name = 'loop';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};

    const windowSize = (cfg.windowSize as number) || 5;
    const windowSeconds = (cfg.windowSeconds as number) || 300;
    const similarityThreshold = (cfg.similarityThreshold as number) || 0.85;
    const minRepetitions = (cfg.minRepetitions as number) || 3;
    const label = (cfg.label as string) || 'loop-detected';

    // Get recent messages from context (passed by router)
    const recentMessages = (ctx.agentId ? ctx.recentMessages : []) || [];

    if (recentMessages.length === 0) {
      return []; // No history to compare against
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    // Filter messages within time window and size limit
    const relevantMessages = recentMessages
      .filter((msg) => now - msg.timestamp <= windowMs)
      .slice(-windowSize);

    if (relevantMessages.length < minRepetitions - 1) {
      return []; // Not enough messages for pattern detection
    }

    // Normalize current message
    const currentWords = normalizeToWordSet(ctx.content);

    // Calculate similarity with each recent message
    const similarities: number[] = [];
    for (const msg of relevantMessages) {
      const msgWords = normalizeToWordSet(msg.content);
      const similarity = jaccardSimilarity(currentWords, msgWords);
      similarities.push(similarity);
    }

    // Count how many messages exceed the similarity threshold
    const highSimilarityCount = similarities.filter(
      (s) => s >= similarityThreshold,
    ).length;

    // Trigger if we have enough similar messages
    if (highSimilarityCount >= minRepetitions - 1) {
      // -1 because current message is not in history yet
      const avgSimilarity =
        similarities.reduce((a, b) => a + b, 0) / similarities.length;
      const maxSimilarity = Math.max(...similarities);

      // Use higher confidence for very high similarity
      const confidence = maxSimilarity > 0.95 ? 0.95 : 0.8;

      return [
        {
          type: label,
          confidence,
          message: `Repetitive pattern detected: ${highSimilarityCount + 1} similar messages (similarity: ${(maxSimilarity * 100).toFixed(1)}%, avg: ${(avgSimilarity * 100).toFixed(1)}%)`,
        },
      ];
    }

    return [];
  }
}
