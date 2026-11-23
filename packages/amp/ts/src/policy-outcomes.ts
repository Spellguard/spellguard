// SPDX-License-Identifier: Apache-2.0

export const REFUSED_POLICY_OUTCOMES = [
  'block',
  'rate_limit',
  'quarantine',
] as const;

export const DETECTED_POLICY_OUTCOMES = ['flag', 'redact'] as const;

export type PolicyOutcome =
  | 'allow'
  | (typeof REFUSED_POLICY_OUTCOMES)[number]
  | (typeof DETECTED_POLICY_OUTCOMES)[number];

export function isRefusedPolicyOutcome(outcome: PolicyOutcome): boolean {
  return REFUSED_POLICY_OUTCOMES.some((value) => value === outcome);
}

export function isDetectedPolicyOutcome(outcome: PolicyOutcome): boolean {
  return DETECTED_POLICY_OUTCOMES.some((value) => value === outcome);
}
