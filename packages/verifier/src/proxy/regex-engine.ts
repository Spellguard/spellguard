// SPDX-License-Identifier: Apache-2.0

/**
 * Regex policy engine.
 *
 * Allows operators to define custom regex patterns via policy config.
 * Each pattern is tested against message content; matches produce detections.
 *
 * Config shape (on binding.config):
 *   patterns: Array<{ pattern: string; flags?: string; label?: string }>
 *
 * Example binding config:
 *   {
 *     "patterns": [
 *       { "pattern": "\\bpassword\\s*=", "label": "password-leak" },
 *       { "pattern": "sk_live_[a-zA-Z0-9]+", "flags": "i", "label": "stripe-key" }
 *     ]
 *   }
 */

import { safeRegex } from './builtin-engine';
import type {
  DetectionSpan,
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

interface RegexPatternConfig {
  pattern: string;
  flags?: string;
  label?: string;
}

/** Collect all match spans for a regex pattern in content. */
function collectSpans(
  content: string,
  pattern: string,
  flags: string,
): DetectionSpan[] | null {
  const gFlags = flags.includes('g') ? flags : `${flags}g`;
  const regex = safeRegex(pattern, gFlags);
  if (!regex) return null;
  const spans: DetectionSpan[] = [];
  for (const match of content.matchAll(regex)) {
    const idx = match.index ?? 0;
    spans.push({ start: idx, end: idx + match[0].length });
  }
  return spans.length > 0 ? spans : null;
}

export class RegexEngine implements PolicyEngine {
  readonly name = 'regex';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const rawPatterns = ctx.binding.config?.patterns;
    if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
      return [];
    }

    const detections: PolicyDetection[] = [];

    for (const entry of rawPatterns as RegexPatternConfig[]) {
      if (!entry.pattern || typeof entry.pattern !== 'string') {
        continue;
      }

      try {
        const spans = collectSpans(
          ctx.content,
          entry.pattern,
          entry.flags ?? 'i',
        );
        if (spans) {
          detections.push({
            type: entry.label || 'regex-match',
            confidence: 1.0,
            message: `Regex pattern matched: ${entry.pattern}`,
            spans,
          });
        }
      } catch {
        // Skip invalid regex patterns silently
      }
    }

    return detections;
  }
}
