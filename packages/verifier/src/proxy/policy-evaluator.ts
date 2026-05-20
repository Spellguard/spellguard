// SPDX-License-Identifier: Apache-2.0

/**
 * Central policy evaluator for bilateral and unilateral message routing.
 *
 * Takes resolved policy bindings (from management server) and message content,
 * dispatches each binding to the appropriate engine via the engine registry,
 * and returns structured PolicyCheckResult[].
 */

import { effectToDecision } from './effect-handlers';
import type { ResponseLevel } from './effect-handlers';
import { getEngine, initDefaultEngines } from './engine-registry';
import type {
  NormalizedIdentityClaims,
  Obligation,
  PolicyDetection,
  ResolvedPolicyBinding,
} from './policy-evaluator-types';
import { isPolicyDetectionWithSpans } from './policy-evaluator-types';
import type { RedactionMetadata } from './redactor';

export type { PolicyDetection } from './policy-evaluator-types';
export type { ResponseLevel } from './effect-handlers';

/**
 * Filter bindings by scope context.
 * - 'messages' context: includes bindings with scope 'all', 'messages', or undefined
 * - 'tools' context: includes bindings with scope 'all', 'tools', or undefined
 */
export function filterByScope(
  bindings: ResolvedPolicyBinding[],
  context: 'messages' | 'tools',
): ResolvedPolicyBinding[] {
  return bindings.filter(
    (b) => !b.scope || b.scope === 'all' || b.scope === context,
  );
}

// Ensure builtin engine is registered
initDefaultEngines();

export interface PolicyCheckResult {
  policyId: string;
  policyName: string;
  policyLevel: string;
  policyType?: ResolvedPolicyBinding['policyType'];
  severity?: string;
  sourceName?: string;
  decision: 'permit' | 'deny';
  responseLevel: ResponseLevel;
  detections: PolicyDetection[];
  obligations: Obligation[];
  durationMs: number;
  retryAfter?: number;
  redactedContent?: string;
  redactionMetadata?: RedactionMetadata;
}

/**
 * Handle a binding whose policyType has no registered engine.
 *
 * Respects binding.failBehavior:
 * - 'allow' (default): silent permit — matches the original behavior
 * - 'block': return a synthetic 'engine-missing' detection
 * - 'warn': console.warn + silent permit
 */
function handleMissingEngine(
  binding: ResolvedPolicyBinding,
): PolicyDetection[] {
  const behavior = binding.failBehavior ?? 'allow';

  if (behavior === 'block') {
    return [
      {
        type: 'engine-missing',
        confidence: 1.0,
        message: `No engine registered for policyType "${binding.policyType}"`,
      },
    ];
  }

  if (behavior === 'warn') {
    console.warn(
      `[spellguard] No engine registered for policyType "${binding.policyType}" (policy ${binding.policyId})`,
    );
  }

  return [];
}

/**
 * Evaluate all bound policies against message content.
 *
 * Each binding is dispatched to the engine registered for its policyType.
 * Decision logic (via effectToDecision):
 * - Detections + block → deny / block
 * - Detections + quarantine → deny / quarantine
 * - Detections + rate_limit → deny / rate_limit
 * - Detections + redact → permit / redact
 * - Detections + flag → permit / flag
 * - No detections → permit / allow
 */
export async function evaluatePolicies(
  bindings: ResolvedPolicyBinding[],
  content: string,
  options?: {
    agentId?: string;
    direction?: 'inbound' | 'outbound';
    recentMessages?: Array<{ content: string; timestamp: number }>;
    identity?: NormalizedIdentityClaims[];
    agentStatus?: 'active' | 'flagged' | 'quarantined';
    senderOrgId?: string;
    recipientOrgId?: string;
  },
): Promise<PolicyCheckResult[]> {
  // Quarantine pre-check: if the agent is quarantined, short-circuit
  if (options?.agentStatus === 'quarantined') {
    return [
      {
        policyId: '__quarantine_precheck',
        policyName: 'quarantine-precheck',
        policyLevel: 'system',
        severity: 'critical',
        decision: 'deny',
        responseLevel: 'quarantine',
        detections: [
          {
            type: 'quarantined',
            confidence: 1.0,
            message: 'Agent is quarantined',
          },
        ],
        obligations: [],
        durationMs: 0,
      },
    ];
  }

  const results: PolicyCheckResult[] = [];

  for (const binding of bindings) {
    const start = performance.now();

    const engine = getEngine(binding.policyType);
    const detections = engine
      ? await engine.evaluate({
          content,
          binding,
          agentId: options?.agentId,
          direction: options?.direction,
          recentMessages: options?.recentMessages,
          identity: options?.identity,
          senderOrgId: options?.senderOrgId,
          recipientOrgId: options?.recipientOrgId,
        })
      : handleMissingEngine(binding);

    const durationMs = Math.round(performance.now() - start);

    // CR-006: If no engine and failBehavior is 'block', short-circuit to deny
    // regardless of binding effect — the fail-closed semantics must win.
    if (!engine && (binding.failBehavior ?? 'allow') === 'block') {
      results.push({
        policyId: binding.policyId,
        policyName: binding.policySlug ?? binding.policyId,
        policyLevel: binding.level,
        policyType: binding.policyType,
        severity: binding.severity,
        decision: 'deny',
        responseLevel: 'block',
        detections,
        obligations: binding.obligations ?? [],
        durationMs,
      });
      continue;
    }

    let { decision, responseLevel } = effectToDecision(
      binding.effect,
      detections.length > 0,
    );

    // NEG-005: If effect is 'redact' but no detections have spans,
    // the engine is offset-unaware and cannot redact. Downgrade to 'flag'.
    if (
      responseLevel === 'redact' &&
      detections.length > 0 &&
      !detections.some(isPolicyDetectionWithSpans)
    ) {
      console.warn(
        `[spellguard] Redact binding "${binding.policySlug}" produced detections without spans — downgrading to flag (NEG-005)`,
      );
      responseLevel = 'flag';
    }

    // CR-016: Only extract retryAfter when effect is actually rate_limit.
    // For non-rate-limit effects, a stale _retryAfter on a detection would be misleading.
    let retryAfter: number | undefined;
    if (binding.effect === 'rate_limit') {
      for (const d of detections) {
        const ra = (d as PolicyDetection & { _retryAfter?: number })
          ._retryAfter;
        if (ra !== undefined) {
          retryAfter = ra;
          break;
        }
      }
    }

    results.push({
      policyId: binding.policyId,
      policyName: binding.policySlug,
      policyLevel: binding.sourceLevel ?? binding.level,
      policyType: binding.policyType,
      severity: binding.severity,
      sourceName: binding.sourceName,
      decision,
      responseLevel,
      detections,
      obligations: binding.obligations || [],
      durationMs,
      retryAfter,
    });
  }

  return results;
}
