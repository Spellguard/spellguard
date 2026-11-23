// SPDX-License-Identifier: Apache-2.0

/**
 * Effect handler module for policy consequence resolution.
 *
 * Provides priority-based resolution when multiple policies produce
 * different response levels for the same message.
 */

import { invalidateAgentPolicies } from '../management/policy-cache';
import { signRequest } from '../management/request-signer';
import type { PolicyEffect } from './policy-evaluator-types';

/**
 * Response levels ordered from highest to lowest priority.
 * When multiple policies fire, the highest-priority level wins.
 */
export const RESPONSE_LEVEL_PRIORITY = [
  'block',
  'quarantine',
  'rate_limit',
  'redact',
  'flag',
  'allow',
] as const;

export type ResponseLevel = (typeof RESPONSE_LEVEL_PRIORITY)[number];

/**
 * Resolve an array of response levels to the single highest-priority level.
 *
 * A level this list doesn't know (a verdict added elsewhere, or a malformed
 * check) resolves to `'block'`, the highest: an unknown verdict never allows
 * (#1455).
 *
 * @param levels - Response levels from individual policy checks
 * @returns The highest-priority level, or `'allow'` if the array is empty
 */
export function resolveResponseLevel(levels: string[]): ResponseLevel {
  if (levels.length === 0) return 'allow';

  let bestIndex = RESPONSE_LEVEL_PRIORITY.length - 1; // start at 'allow'

  for (const level of levels) {
    const idx = RESPONSE_LEVEL_PRIORITY.indexOf(level as ResponseLevel);
    if (idx === -1) {
      console.warn(`[Verifier] Unknown response level "${level}" — blocking`);
      return 'block';
    }
    if (idx < bestIndex) {
      bestIndex = idx;
    }
  }

  return RESPONSE_LEVEL_PRIORITY[bestIndex];
}

/**
 * Map the six response levels to the three results an evaluate-only caller
 * acts on (`/v1/mcp/evaluate`, `/v1/content/evaluate`):
 * block/quarantine/rate_limit -> 'block', flag/redact -> 'flag',
 * allow -> 'allow'.
 */
export function mapResponseLevel(
  level: ResponseLevel,
): 'allow' | 'block' | 'flag' {
  switch (level) {
    case 'block':
    case 'quarantine':
    case 'rate_limit':
      return 'block';
    case 'flag':
    case 'redact':
      return 'flag';
    case 'allow':
      return 'allow';
    default: {
      // Exhaustive, as on /v1/tools/check: a level added without a case above
      // fails to compile here, and at runtime blocks rather than allows (#1455).
      const _exhaustive: never = level;
      console.warn(
        `[Verifier] Unknown evaluate response level "${_exhaustive as string}" — blocking`,
      );
      return 'block';
    }
  }
}

/**
 * Map a policy effect + detection state to a decision and response level.
 */
export function effectToDecision(
  effect: PolicyEffect,
  hasDetections: boolean,
): { decision: 'permit' | 'deny'; responseLevel: ResponseLevel } {
  if (!hasDetections) {
    return { decision: 'permit', responseLevel: 'allow' };
  }

  switch (effect) {
    case 'block':
      return { decision: 'deny', responseLevel: 'block' };
    case 'quarantine':
      return { decision: 'deny', responseLevel: 'quarantine' };
    case 'rate_limit':
      return { decision: 'deny', responseLevel: 'rate_limit' };
    case 'redact':
      return { decision: 'permit', responseLevel: 'redact' };
    case 'flag':
      return { decision: 'permit', responseLevel: 'flag' };
    default: {
      // CR-015: Exhaustive check — if a new PolicyEffect is added without a
      // case above, TypeScript will error here. At runtime, fall back to deny
      // so unknown effects fail closed rather than silently allowing.
      const _exhaustive: never = effect;
      console.warn(
        `[effectToDecision] Unknown policy effect: "${_exhaustive as string}" — denying`,
      );
      return { decision: 'deny', responseLevel: 'block' };
    }
  }
}

/**
 * `policyId` of the synthetic check that refuses a message because its agent
 * is ALREADY quarantined (built by `quarantinePrecheckResult`). It carries
 * `responseLevel: 'quarantine'` so the message resolves as a quarantine
 * refusal, but it records the existing quarantine, not a new violation.
 */
export const QUARANTINE_PRECHECK_POLICY_ID = '__quarantine_precheck';

/**
 * True iff a policy that actually ran calls for quarantine: any check with
 * `responseLevel === 'quarantine'` other than the quarantine precheck.
 *
 * Quarantine is an agent-state concern, orthogonal to the message-level
 * response-level resolution done by {@link resolveResponseLevel}. A
 * higher-priority block-effect baseline binding (e.g. exfiltration-baseline)
 * can win the message disposition while a narrower quarantine-effect
 * binding (e.g. pii-detection) fired on the same content; the agent must
 * still be quarantined in that case. Both the bilateral and unilateral
 * routers gate `handleQuarantine` on this predicate so the two enforcement
 * paths agree.
 *
 * The precheck is excluded (#1265): refusing an already-quarantined agent is
 * not a new reason to quarantine it, and reporting it as one overwrote the
 * reason and time of the policy that did.
 */
export function shouldQuarantineFromChecks(
  checks: ReadonlyArray<{ responseLevel: string; policyId?: string }>,
): boolean {
  return checks.some(
    (c) =>
      c.responseLevel === 'quarantine' &&
      c.policyId !== QUARANTINE_PRECHECK_POLICY_ID,
  );
}

/**
 * Handle a quarantine effect: call the management API to quarantine the agent,
 * evict the agent's policy cache, and return a deny result.
 *
 * @param agentId - The agent to quarantine
 * @param reason - The reason for quarantining
 * @returns true if the management API call succeeded, false otherwise
 */
export async function handleQuarantine(
  agentId: string,
  reason: string,
): Promise<boolean> {
  const baseUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!baseUrl) {
    console.warn(
      '[handleQuarantine] MANAGEMENT_URL not set, cannot quarantine agent',
    );
    return false;
  }

  try {
    const bodyStr = JSON.stringify({
      status: 'quarantined',
      quarantine_reason: reason,
      quarantined_at: new Date().toISOString(),
    });
    const url = `${baseUrl}/v1/internal/agents/${encodeURIComponent(agentId)}/quarantine`;
    const headers = await signRequest('PATCH', url, bodyStr);

    const response = await fetch(url, {
      method: 'PATCH',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.error(
        `[handleQuarantine] Failed to quarantine agent ${agentId}: ${response.status}`,
      );
      return false;
    }

    // Evict the policy cache so the next check picks up the quarantined status
    invalidateAgentPolicies(agentId);

    console.log(`[handleQuarantine] Agent ${agentId} quarantined: ${reason}`);
    return true;
  } catch (error) {
    console.error(
      `[handleQuarantine] Error quarantining agent ${agentId}: ${error}`,
    );
    return false;
  }
}
