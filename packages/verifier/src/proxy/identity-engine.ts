// SPDX-License-Identifier: Apache-2.0

/**
 * Identity Claim Policy Engine
 *
 * Evaluates identity requirements against the verified NormalizedIdentityClaims
 * attached to the evaluation context. Returns a detection when no verified
 * identity satisfies the configured constraints — causing the bound effect
 * (block/flag/etc.) to fire.
 *
 * Policy type: 'identity-claim'
 *
 * Config shape:
 * {
 *   requireProvider?: string | string[];   // provider must be in this set
 *   allowedSubjects?: string[];            // subject must be in this list
 *   subjectPattern?: string;               // subject must match this regex
 *   allowedIssuers?: string[];             // issuer must be in this list
 *   allowedEmails?: string[];              // email must be in this list
 *   minVerifiedProviders?: number;         // minimum number of verified identities
 * }
 *
 * Semantics: the engine finds at least one identity in ctx.identity[] that
 * satisfies ALL attribute constraints simultaneously. If none qualifies, one
 * detection is emitted. The minVerifiedProviders check is independent and
 * emits its own detection when the count is too low.
 */

import type {
  NormalizedIdentityClaims,
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

interface IdentityClaimConfig {
  requireProvider?: string | string[];
  allowedSubjects?: string[];
  subjectPattern?: string;
  allowedIssuers?: string[];
  allowedEmails?: string[];
  minVerifiedProviders?: number;
}

function matchesConstraints(
  id: NormalizedIdentityClaims,
  config: IdentityClaimConfig,
): boolean {
  if (config.requireProvider !== undefined) {
    const providers = Array.isArray(config.requireProvider)
      ? config.requireProvider
      : [config.requireProvider];
    if (!providers.includes(id.provider)) return false;
  }
  if (config.allowedSubjects !== undefined) {
    if (!config.allowedSubjects.includes(id.subject)) return false;
  }
  if (config.subjectPattern !== undefined) {
    try {
      if (!new RegExp(config.subjectPattern).test(id.subject)) return false;
    } catch {
      // Treat malformed regex as no-match
      return false;
    }
  }
  if (config.allowedIssuers !== undefined) {
    if (!config.allowedIssuers.includes(id.issuer)) return false;
  }
  if (config.allowedEmails !== undefined) {
    if (!id.email || !config.allowedEmails.includes(id.email)) return false;
  }
  return true;
}

function buildViolationMessage(config: IdentityClaimConfig): string {
  const parts: string[] = [];
  if (config.requireProvider !== undefined) {
    const providers = Array.isArray(config.requireProvider)
      ? config.requireProvider.join(' or ')
      : config.requireProvider;
    parts.push(`provider=${providers}`);
  }
  if (config.allowedSubjects !== undefined)
    parts.push(`subject in [${config.allowedSubjects.join(', ')}]`);
  if (config.subjectPattern !== undefined)
    parts.push(`subject~/${config.subjectPattern}/`);
  if (config.allowedIssuers !== undefined)
    parts.push(`issuer in [${config.allowedIssuers.join(', ')}]`);
  if (config.allowedEmails !== undefined)
    parts.push(`email in [${config.allowedEmails.join(', ')}]`);
  return `No verified identity satisfies: ${parts.join(', ')}`;
}

export class IdentityEngine implements PolicyEngine {
  readonly name = 'identity-claim';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const config = (ctx.binding.config ?? {}) as IdentityClaimConfig;
    const identity = ctx.identity ?? [];
    const detections: PolicyDetection[] = [];

    // Check minimum provider count independently
    const min = config.minVerifiedProviders ?? 0;
    if (min > 0 && identity.length < min) {
      detections.push({
        type: 'identity-claim',
        confidence: 1.0,
        message: `Requires at least ${min} verified provider(s), found ${identity.length}`,
      });
    }

    // Check attribute constraints: at least one identity must satisfy all of them
    const hasAttributeConstraints =
      config.requireProvider !== undefined ||
      config.allowedSubjects !== undefined ||
      config.subjectPattern !== undefined ||
      config.allowedIssuers !== undefined ||
      config.allowedEmails !== undefined;

    if (hasAttributeConstraints) {
      const hasMatch = identity.some((id) => matchesConstraints(id, config));
      if (!hasMatch) {
        detections.push({
          type: 'identity-claim',
          confidence: 1.0,
          message: buildViolationMessage(config),
        });
      }
    }

    return detections;
  }
}
