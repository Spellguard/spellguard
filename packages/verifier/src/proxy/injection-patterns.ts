// SPDX-License-Identifier: Apache-2.0

/**
 * Shared prompt-injection detection patterns and evaluation logic.
 *
 * Used by policy-file-engine, policy-network-engine, and policy-memory-engine.
 * Each engine imports the common base patterns and extends them with
 * domain-specific extras before calling buildInjectionDetections().
 */

import type {
  PolicyDetection,
  PolicyEvalContext,
} from './policy-evaluator-types';

// ─── Common base patterns ─────────────────────────────────────────────────────

/** Core instruction-override signals shared by all injection-scan engines. */
export const INJECTION_HIGH_COMMON: ReadonlyArray<RegExp> = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(all\s+)?previous\s+instructions?/i,
  /forget\s+everything\s+(above|before)/i,
  /you\s+are\s+now\s+(a\s+)?(?:an?\s+)?\w/i,
  /new\s+instructions?:/i,
  /\[INST\]|\[\/INST\]/, // Llama-style injection markers
  /\u200b|\u200c|\u200d|\u00ad|\ufeff/, // zero-width / invisible chars
];

/** Role-override and jailbreak signals shared by all injection-scan engines. */
export const INJECTION_MEDIUM_COMMON: ReadonlyArray<RegExp> = [
  /act\s+as\s+(a\s+)?(?:an?\s+)?\w/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /jailbreak/i,
  /developer\s+mode/i,
  /<\s*script[^>]*>/i, // script tags in text context
];

/** Soft override signals shared by all injection-scan engines. */
export const INJECTION_LOW_COMMON: ReadonlyArray<RegExp> = [
  /override\s+(previous\s+)?instructions?/i,
  /assistant\s*:\s*(?:sure|ok|yes|i\s+will)/i,
];

// ─── Shared evaluation logic ──────────────────────────────────────────────────

/**
 * Core injection detection algorithm used by all three injection-scan engines.
 * Reads `sensitivity` and `label` from the binding config.
 *
 * @param ctx          - Policy evaluation context
 * @param defaultLabel - Detection label when config.label is not set
 * @param messagePrefix - Human-readable prefix for the detection message
 * @param high         - High-confidence patterns (confidence: 0.95)
 * @param medium       - Medium-confidence patterns (confidence: 0.75)
 * @param low          - Low-confidence patterns (confidence: 0.75)
 */
export function buildInjectionDetections(
  ctx: PolicyEvalContext,
  defaultLabel: string,
  messagePrefix: string,
  high: ReadonlyArray<RegExp>,
  medium: ReadonlyArray<RegExp>,
  low: ReadonlyArray<RegExp>,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || defaultLabel;
  const sensitivity = (cfg.sensitivity as string) || 'medium';

  const patterns: RegExp[] = [...high];
  if (sensitivity === 'medium' || sensitivity === 'high') {
    patterns.push(...medium);
  }
  if (sensitivity === 'high') {
    patterns.push(...low);
  }

  const detections: PolicyDetection[] = [];

  for (const pattern of patterns) {
    const match = pattern.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      const isHigh = (high as RegExp[]).includes(pattern);
      detections.push({
        type: label,
        confidence: isHigh ? 0.95 : 0.75,
        message: `${messagePrefix}: ${match[0].slice(0, 60)}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  return detections;
}
