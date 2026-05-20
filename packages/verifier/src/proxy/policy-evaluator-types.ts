// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the policy evaluator, mirroring the management server's
 * ResolvedPolicyBinding shape for use within the Verifier package.
 */

import type { Obligation } from '@spellguard/amp';
import type { BufferedMessage } from './message-buffer';
import type { VisibilityData } from './visibility-checker';

export type { Obligation } from '@spellguard/amp';

export type PolicyLevel = 'system' | 'org' | 'group' | 'agent' | 'session';
export type PolicySeverity = 'critical' | 'high' | 'medium' | 'low';
export type PolicyEffect =
  | 'block'
  | 'flag'
  | 'rate_limit'
  | 'redact'
  | 'quarantine';
export const PolicyEffectValues = [
  'block',
  'flag',
  'rate_limit',
  'redact',
  'quarantine',
] as const;
export type PolicyType =
  | 'builtin'
  | 'regex'
  | 'dsl'
  | 'external'
  | 'keyword'
  | 'schema'
  | 'contains'
  | 'time-window'
  | 'code'
  | 'toxicity'
  | 'nsfw-blocker'
  | 'topic-boundary'
  | 'injection'
  | 'secrets'
  | 'url'
  | 'loop'
  | 'exfiltration'
  | 'financial-disclaimer'
  | 'phi-guardian'
  | 'action-allowlist'
  | 'privilege-escalation'
  | 'citation-enforcer'
  | 'self-harm-prevention'
  // ── Tool policies: Path / File System ────────────────────────────────────
  | 'path-traversal'
  | 'path-sandbox'
  // ── Tool policies: Shell / Code Execution ────────────────────────────────
  | 'command-allowlist'
  | 'argument-injection'
  | 'sandbox-escape'
  // ── Tool policies: Network ───────────────────────────────────────────────
  | 'ssrf'
  | 'scheme-allowlist'
  | 'flow-exfiltration'
  | 'network-injection-scan'
  // ── Tool policies: Database ──────────────────────────────────────────────
  | 'query-injection'
  | 'ddl-block'
  | 'write-block'
  // ── Tool policies: Communications ────────────────────────────────────────
  | 'recipient-allowlist'
  | 'output-risk-scan'
  | 'sequence-gate'
  // ── Tool policies: Storage / Memory ──────────────────────────────────────
  | 'scope-isolation'
  | 'payload-size-limit'
  | 'memory-injection-scan'
  // ── Tool policies: Cross-cutting ─────────────────────────────────────────
  | 'input-injection-scan'
  | 'invocation-rate-limit'
  | 'irreversible-gate'
  | 'output-size-limit'
  | 'data-flow-taint'
  // Identity
  | 'identity-claim';

export interface ResolvedPolicyBinding {
  policyId: string;
  level: PolicyLevel;
  effect: PolicyEffect;
  severity?: PolicySeverity;
  config?: Record<string, unknown>;
  failBehavior?: 'block' | 'allow' | 'warn';
  obligations?: Obligation[];
  priority?: number;
  policyType: PolicyType;
  policySlug: string;
  regoBundle?: string;
  dslSource?: string;
  externalEndpoint?: string;
  externalTimeout?: number;
  externalMtlsCert?: string;
  sourceLevel?: 'org' | 'group' | 'agent';
  sourceName?: string;
  scope?: 'all' | 'messages' | 'tools';
}

export type AttestationProvider =
  | 'aws'
  | 'azure'
  | 'azure-maa'
  | 'clerk'
  | 'gcp'
  | 'salesforce'
  | 'spiffe'
  | 'verifier'
  | 'nitro-verifier'
  | 'aws-agentcore'
  | 'better-auth'
  | 'jwk'
  | 'oidc'
  | 'vestauth'
  | 'x509';

export interface NormalizedIdentityClaims {
  subject: string;
  issuer: string;
  provider: AttestationProvider;
  verifiedAt: number;
  expiresAt?: number;
  email?: string;
  groups?: string[];
  raw: Record<string, unknown>;
}

export interface ResolvedPolicyConfig {
  inbound: ResolvedPolicyBinding[];
  outbound: ResolvedPolicyBinding[];
  version: string;
  signature: string;
  resolvedAt: number;
  expiresAt: number;
  organizationId?: string;
  visibility?: VisibilityData;
  agentStatus?: 'active' | 'flagged' | 'quarantined';
  identityContext?: NormalizedIdentityClaims[];
}

// ─── Pluggable Engine Types ────────────────────────────────────────

export interface DetectionSpan {
  start: number;
  end: number;
}

export interface PolicyDetection {
  type: string;
  confidence: number;
  message?: string;
  spans?: DetectionSpan[];
}

export function isPolicyDetectionWithSpans(d: PolicyDetection): boolean {
  return Array.isArray(d.spans) && d.spans.length > 0;
}

export interface PolicyEvalContext {
  content: string;
  binding: ResolvedPolicyBinding;
  agentId?: string;
  direction?: 'inbound' | 'outbound';
  recentMessages?: BufferedMessage[];
  /** Normalized identity claims from platform attestation */
  identity?: NormalizedIdentityClaims[];
  /** Sender's organization ID (for cross-org policy checks) */
  senderOrgId?: string;
  /** Recipient's organization ID (for cross-org policy checks) */
  recipientOrgId?: string;
}

export interface PolicyEngine {
  readonly name: string;
  evaluate(
    ctx: PolicyEvalContext,
  ): PolicyDetection[] | Promise<PolicyDetection[]>;
}
