// SPDX-License-Identifier: Apache-2.0

/**
 * Central policy evaluator for bilateral and unilateral message routing.
 *
 * Takes resolved policy bindings (from management server) and message content,
 * dispatches each binding to the appropriate engine via the engine registry,
 * and returns structured PolicyCheckResult[].
 */

import type { AgentOutput } from '../session/agent-output';
import type { DecisionModelClient } from '../session/decision-model';
import type { SessionHandle } from '../session/session-store';
import {
  QUARANTINE_PRECHECK_POLICY_ID,
  effectToDecision,
} from './effect-handlers';
import type { ResponseLevel } from './effect-handlers';
import { getEngine, initDefaultEngines } from './engine-registry';
import { isTrustedBidiDetection } from './injection-patterns';
import { getRecentToolCalls, recordToolCall } from './message-buffer';
import type {
  NormalizedIdentityClaims,
  Obligation,
  PolicyCheckUsage,
  PolicyDetection,
  PolicyEvalContext,
  ResolvedPolicyBinding,
} from './policy-evaluator-types';
import { isPolicyDetectionWithSpans } from './policy-evaluator-types';
import type { RedactionMetadata } from './redactor';

export type { PolicyDetection } from './policy-evaluator-types';
export type { ResponseLevel } from './effect-handlers';

const BIDI_OBSERVATION_TYPES = new Set<ResolvedPolicyBinding['policyType']>([
  'injection',
  'input-injection-scan',
  'network-injection-scan',
  'memory-injection-scan',
]);

/**
 * Filter bindings by scope context. ONE uniform rule for every leg: a binding
 * governs a leg when it is scoped to that leg, or scoped `'all'`, or unscoped
 * (unscoped ≡ `'all'`, the documented historical default).
 *
 * `'all'` INCLUDES the model-inference leg. The LLM leg was originally
 * strictly-opt-in (only an explicit `'llm'` binding counted) so that shipping the
 * gateway couldn't silently mass-enforce every org's existing bindings on
 * inference. That made `'all'` mean "all EXCEPT llm", which contradicts the word
 * and surprised operators — an org-wide `'all'` binding looked active on model
 * calls but silently governed nothing. It also made a per-agent `'llm'` binding
 * impossible to add for a policy already bound org-wide as `'all'` (the resolver
 * keeps one binding per policy, the `'all'` one wins, and the llm leg then
 * dropped it). `'all'` now means all three legs.
 *
 * Consequence to keep in mind when adding a leg: every `'all'`/unscoped binding
 * applies to it immediately.
 *
 * The one exception is `explicitOnly`, which keeps only the bindings that
 * name the leg. `/v1/content/evaluate` (the OpenShell middleware, #1438) uses
 * it: the default catalog's unscoped policies are built for chat and block
 * almost all of a coding agent's model traffic, so that route applies only
 * bindings scoped exactly `'llm'`. On one Verifier, then, an `'all'` binding
 * governs the LLM gateway's model calls but not the content route's.
 */
export function filterByScope(
  bindings: ResolvedPolicyBinding[],
  context: 'messages' | 'tools' | 'llm',
  options: { explicitOnly?: boolean } = {},
): ResolvedPolicyBinding[] {
  if (options.explicitOnly) {
    return bindings.filter((b) => b.scope === context);
  }
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
  /**
   * Structured detail an engine reports for the audit row (the session
   * policies: sources, candidates, the questions and every answer). Never
   * the content itself beyond what the policy compared.
   */
  evidence?: Record<string, unknown>;
  /**
   * What the check's model call used (the decision model's id and token
   * counts), for cost tracking. Outside `evidence`, so the evidence cap never
   * drops it; absent when no model was called.
   */
  usage?: PolicyCheckUsage;
}

/**
 * The synthetic check that refuses a message because its agent is already
 * quarantined. Every precheck is built here, so `shouldQuarantineFromChecks`
 * can tell it from a policy that calls for a NEW quarantine (#1265).
 */
export function quarantinePrecheckResult(message: string): PolicyCheckResult {
  return {
    policyId: QUARANTINE_PRECHECK_POLICY_ID,
    policyName: 'quarantine-precheck',
    policyLevel: 'system',
    severity: 'critical',
    decision: 'deny',
    responseLevel: 'quarantine',
    detections: [{ type: 'quarantined', confidence: 1.0, message }],
    obligations: [],
    durationMs: 0,
  };
}

/**
 * Handle a binding whose policyType has no registered engine.
 *
 * Respects binding.failBehavior:
 * - 'block' (default): return a synthetic 'engine-missing' detection
 * - 'allow': explicit opt-in to silent permit
 * - 'warn': console.warn + silent permit
 */
function handleMissingEngine(
  binding: ResolvedPolicyBinding,
): PolicyDetection[] {
  const behavior = binding.failBehavior ?? 'block';

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

function engineErrorCheck(
  binding: ResolvedPolicyBinding,
  durationMs: number,
): PolicyCheckResult {
  const behavior = binding.failBehavior ?? 'block';
  const responseLevel =
    behavior === 'block' ? 'block' : behavior === 'warn' ? 'flag' : 'allow';
  return {
    policyId: binding.policyId,
    policyName: binding.policySlug ?? binding.policyId,
    policyLevel: binding.sourceLevel ?? binding.level,
    policyType: binding.policyType,
    severity: binding.severity,
    sourceName: binding.sourceName,
    decision: behavior === 'block' ? 'deny' : 'permit',
    responseLevel,
    // Engine errors may contain policy configuration or message content.
    // Keep the event attributable without copying those details into it.
    detections: [
      {
        type: 'engine-error',
        confidence: 1,
        message: 'Policy evaluation failed',
      },
    ],
    obligations: binding.obligations ?? [],
    durationMs,
  };
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
    toolName?: string;
    toolParams?: Record<string, unknown>;
    recentMessages?: Array<{ content: string; timestamp: number }>;
    identity?: NormalizedIdentityClaims[];
    agentStatus?: 'active' | 'flagged' | 'quarantined';
    senderOrgId?: string;
    recipientOrgId?: string;
    correlationId?: string;
    session?: SessionHandle;
    decisionModel?: DecisionModelClient;
    output?: AgentOutput;
  },
): Promise<PolicyCheckResult[]> {
  // Quarantine pre-check: if the agent is quarantined, short-circuit
  if (options?.agentStatus === 'quarantined') {
    return [quarantinePrecheckResult('Agent is quarantined')];
  }

  const results: PolicyCheckResult[] = [];

  for (const binding of bindings) {
    const start = performance.now();

    const engine = getEngine(binding.policyType);
    let detections: PolicyDetection[];
    let evidence: Record<string, unknown> | undefined;
    let usage: PolicyCheckUsage | undefined;
    let lowerToFlag = false;
    try {
      if (!engine) {
        detections = handleMissingEngine(binding);
      } else {
        const ctx: PolicyEvalContext = {
          content,
          binding,
          agentId: options?.agentId,
          direction: options?.direction,
          toolName: options?.toolName,
          toolParams: options?.toolParams,
          recentMessages: options?.recentMessages,
          identity: options?.identity,
          senderOrgId: options?.senderOrgId,
          recipientOrgId: options?.recipientOrgId,
          correlationId: options?.correlationId,
          session: options?.session,
          decisionModel: options?.decisionModel,
          output: options?.output,
        };
        if (engine.evaluateWithEvidence) {
          const result = await engine.evaluateWithEvidence(ctx);
          ({ detections, evidence, usage } = result);
          lowerToFlag = result.effect === 'flag';
        } else {
          detections = await engine.evaluate(ctx);
        }
      }
    } catch {
      results.push(
        engineErrorCheck(binding, Math.round(performance.now() - start)),
      );
      continue;
    }

    const durationMs = Math.round(performance.now() - start);

    // CR-006: If no engine and failBehavior is 'block', short-circuit to deny
    // regardless of binding effect — the fail-closed semantics must win.
    if (!engine && (binding.failBehavior ?? 'block') === 'block') {
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

    // Ordinary RTL controls are observations from the built-in injection path.
    // A public label or mixed attack result cannot downgrade a binding's effect.
    const bidiObservationOnly =
      BIDI_OBSERVATION_TYPES.has(binding.policyType) &&
      detections.length > 0 &&
      detections.every(isTrustedBidiDetection);
    // A check whose every detection is advisory resolves to flag; one
    // enforcing detection keeps the binding's effect. An engine may also
    // lower its check to flag (`PolicyEngineResult.effect`).
    const advisoryOnly =
      detections.length > 0 && detections.every((d) => d.advisory === true);
    let { decision, responseLevel } = effectToDecision(
      bidiObservationOnly || advisoryOnly || lowerToFlag
        ? 'flag'
        : binding.effect,
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
      ...(evidence ? { evidence } : {}),
      ...(usage ? { usage } : {}),
    });
  }

  return results;
}

/**
 * Evaluate tool-scoped bindings against one tool call, on any tool leg.
 *
 * The sequence policies (sequence-gate, data-flow-taint, flow-exfiltration)
 * decide from the agent's earlier tool calls, so this passes them that history
 * and then adds the call to it. Every tool leg calls this rather than
 * `evaluatePolicies`, so no leg can evaluate a tool call without its history
 * (#1413). A call the Verifier denied is not recorded: it did not happen.
 */
export async function evaluateToolCallPolicies(
  bindings: ResolvedPolicyBinding[],
  content: string,
  options: Omit<
    NonNullable<Parameters<typeof evaluatePolicies>[2]>,
    'recentMessages' | 'agentId'
  > & { agentId: string },
): Promise<PolicyCheckResult[]> {
  const checks = await evaluatePolicies(bindings, content, {
    ...options,
    recentMessages: getRecentToolCalls(options.agentId),
  });
  if (!checks.some((check) => check.decision === 'deny')) {
    recordToolCall(options.agentId, options.toolName, content);
  }
  return checks;
}
