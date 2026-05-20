// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for bilateral and unilateral routers.
 *
 * CR-024/CR-025: Extracted from router.ts and unilateral-router.ts
 * to eliminate duplication of applyRedaction, deriveResponseLevel,
 * and buildQuarantineReason.
 */

import { safeRegex } from './builtin-engine';
import { resolveResponseLevel } from './effect-handlers';
import type { ResponseLevel } from './effect-handlers';
import type { PolicyCheckResult } from './policy-evaluator';
import { redact } from './redactor';

/**
 * Compile an array of user-supplied regex strings, silently dropping any that
 * are invalid or unsafe (ReDoS). Used by engines that accept operator-configured patterns.
 */
export function compilePatterns(patterns: string[], flags = 'i'): RegExp[] {
  return patterns.flatMap((p) => {
    const re = safeRegex(p, flags);
    return re ? [re] : [];
  });
}

/**
 * Build a sanitized quarantine reason string from policy checks.
 * Uses only policy names and detection types (not user-influenced messages)
 * per CR-026.
 */
export function buildQuarantineReason(checks: PolicyCheckResult[]): string {
  return checks
    .filter((c) => c.responseLevel === 'quarantine')
    .map(
      (c) => `${c.policyName}: ${c.detections.map((d) => d.type).join(', ')}`,
    )
    .join('; ');
}

/**
 * Determine overall response level from accumulated policy checks
 * using the 6-value priority system from effect-handlers.
 */
export function deriveResponseLevel(
  checks: PolicyCheckResult[],
): ResponseLevel {
  return resolveResponseLevel(checks.map((c) => c.responseLevel));
}

/**
 * Collect redaction spans from checks that have responseLevel 'redact',
 * apply redaction, and store metadata back on the check results.
 * Returns the (possibly redacted) content.
 */
export function applyRedaction(
  content: string,
  checks: PolicyCheckResult[],
): string {
  const redactChecks = checks.filter((c) => c.responseLevel === 'redact');
  if (redactChecks.length === 0) return content;

  // Collect all spans from detections in redact-level checks
  const allSpans: Array<{ start: number; end: number }> = [];
  for (const check of redactChecks) {
    for (const detection of check.detections) {
      if (detection.spans) {
        allSpans.push(...detection.spans);
      }
    }
  }

  if (allSpans.length === 0) return content;

  const result = redact(content, allSpans);

  // CR-006: Populate detectionTypes from contributing detections
  const detectionTypes = [
    ...new Set(redactChecks.flatMap((c) => c.detections.map((d) => d.type))),
  ];
  result.metadata.detectionTypes = detectionTypes;

  // Store redaction metadata on each redact-level check
  for (const check of redactChecks) {
    check.redactedContent = result.content;
    check.redactionMetadata = result.metadata;
  }

  return result.content;
}
