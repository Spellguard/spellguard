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
 * @param levels - Response levels from individual policy checks
 * @returns The highest-priority level, or `'allow'` if the array is empty
 */
export function resolveResponseLevel(levels: string[]): ResponseLevel {
  if (levels.length === 0) return 'allow';

  let bestIndex = RESPONSE_LEVEL_PRIORITY.length - 1; // start at 'allow'

  for (const level of levels) {
    const idx = RESPONSE_LEVEL_PRIORITY.indexOf(level as ResponseLevel);
    if (idx !== -1 && idx < bestIndex) {
      bestIndex = idx;
    }
  }

  return RESPONSE_LEVEL_PRIORITY[bestIndex];
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
 * True iff any check in `checks` carries `responseLevel === 'quarantine'`.
 *
 * Quarantine is an agent-state concern, orthogonal to the message-level
 * response-level resolution done by {@link resolveResponseLevel}. A
 * higher-priority block-effect baseline binding (e.g. exfiltration-baseline)
 * can win the message disposition while a narrower quarantine-effect
 * binding (e.g. pii-detection) fired on the same content; the agent must
 * still be quarantined in that case. Both the bilateral and unilateral
 * routers gate `handleQuarantine` on this predicate so the two enforcement
 * paths agree.
 */
export function shouldQuarantineFromChecks(
  checks: ReadonlyArray<{ responseLevel: string }>,
): boolean {
  return checks.some((c) => c.responseLevel === 'quarantine');
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
    const headers = await signRequest(bodyStr);

    const response = await fetch(
      `${baseUrl}/v1/internal/agents/${encodeURIComponent(agentId)}/quarantine`,
      {
        method: 'PATCH',
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(5000),
      },
    );

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
