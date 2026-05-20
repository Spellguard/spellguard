// SPDX-License-Identifier: Apache-2.0

import type { ResolvedPolicyBinding } from '../../packages/verifier/src/proxy/policy-evaluator-types';

/**
 * Create a ResolvedPolicyBinding with sensible defaults.
 * The slug is used for both policyId and policySlug by default.
 * Pass overrides to customize any field.
 */
export function makeBinding(
  slug: string,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: slug,
    level: 'org',
    effect: 'block',
    policyType: 'builtin',
    policySlug: slug,
    ...overrides,
  };
}

/**
 * Create a ResolvedPolicyBinding for a specific policy engine type.
 * Used by policy engine unit tests where policyType and config are
 * always set together.
 */
export function makeEngineBinding(
  policyType: string,
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: `${policyType}-test`,
    level: 'org',
    effect: 'block',
    policyType: policyType as ResolvedPolicyBinding['policyType'],
    policySlug: policyType,
    config,
    ...overrides,
  };
}
