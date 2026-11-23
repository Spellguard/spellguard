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
import type { PolicyType } from './policy-evaluator-types';
import { redact } from './redactor';

/**
 * Policy types whose verdict depends on earlier traffic, not on the text
 * alone. Re-running one on another piece of the same leg (a content part, an
 * attachment's text) would count the re-run as more traffic (rate and loop
 * limits), or judge the piece without the history that decided it (the
 * sequence policies).
 */
export const STATEFUL_POLICY_TYPES: ReadonlySet<PolicyType> =
  new Set<PolicyType>([
    'loop',
    'invocation-rate-limit',
    'sequence-gate',
    'data-flow-taint',
    'flow-exfiltration',
  ]);

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

/**
 * Disposition of a reply (response) leg — whether the response must be WITHHELD
 * from the requester. The symmetric counterpart to the request-leg block.
 */
export interface ResponseDisposition {
  /** true → the response content must NOT be handed back to the requester. */
  blocked: boolean;
  /** Level resolved across BOTH response-leg check sets; drives the HTTP status. */
  responseLevel: ResponseLevel;
  /** Which side's binding denied — only set when blocked. */
  blockedBy?: 'inbound' | 'recipient-outbound';
  /** Name of the denying policy — only set when blocked. */
  policyName?: string;
}

/**
 * Decide whether a bilateral response must be withheld from the requester.
 *
 * A response is blocked when ANY check — on either the recipient's outbound
 * bindings (applied to the reply it sends) or the requester's inbound bindings
 * (applied to the reply it receives) — resolved to a deny-family decision
 * (`block` / `quarantine` / `rate_limit`, all of which map to `decision: 'deny'`
 * in effect-handlers). `redact`, `flag` and `allow` never withhold: redact-level
 * spans are stripped in place upstream and the (redacted) reply still flows.
 *
 * The requester's own inbound binding takes precedence in the surfaced reason —
 * it is the most actionable for the caller — falling back to the recipient's
 * outbound binding.
 */
export function evaluateResponseDisposition(
  recipientOutboundChecks: PolicyCheckResult[],
  senderInboundChecks: PolicyCheckResult[],
): ResponseDisposition {
  const responseLevel = deriveResponseLevel([
    ...recipientOutboundChecks,
    ...senderInboundChecks,
  ]);
  const inboundDeny = senderInboundChecks.find((c) => c.decision === 'deny');
  const recipientDeny = recipientOutboundChecks.find(
    (c) => c.decision === 'deny',
  );
  const deny = inboundDeny ?? recipientDeny;
  if (!deny) {
    return { blocked: false, responseLevel };
  }
  return {
    blocked: true,
    responseLevel,
    blockedBy: inboundDeny ? 'inbound' : 'recipient-outbound',
    policyName: deny.policyName,
  };
}
