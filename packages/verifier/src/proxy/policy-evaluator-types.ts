// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the policy evaluator, mirroring the management server's
 * ResolvedPolicyBinding shape for use within the Verifier package.
 */

import type { PolicyType as AmpPolicyType, Obligation } from '@spellguard/amp';
import type { AgentOutput } from '../session/agent-output';
import type { DecisionModelClient } from '../session/decision-model';
import type { SessionHandle } from '../session/session-store';
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
export type PolicyType = AmpPolicyType;

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
  scope?: 'all' | 'messages' | 'tools' | 'llm';
}

/**
 * One typed piece of the content an evaluate-only route checks
 * (`/v1/mcp/evaluate`, `/v1/content/evaluate`).
 */
export interface ContentPart {
  type: string;
  value: string;
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
  /** Canonical slug paired with the signed binding; never authoritative alone. */
  agentSlug?: string;
  /** Management signature binding row+slug to the authenticated Verifier. */
  agentBindingToken?: string;
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
  /**
   * LLM-gateway streaming posture (design §5.3). `'live'` opts this agent into
   * streaming the model response as it is generated, policed behind a bounded
   * buffer. Anything else — including absent — means zero-leak: buffer the whole
   * completion, run policy, then emit.
   */
  streamingPosture?: string;
  /**
   * The agent's organization's document limits, defaults applied
   * (internal design notes). Absent from an older
   * management: the Verifier uses DOCUMENT_LIMIT_DEFAULTS.
   */
  documentLimits?: { maxBytes: number; maxPages: number };
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
  /**
   * An observation the engine reports at flag level only. When every
   * detection of a check is advisory, the check resolves to `flag` whatever
   * the binding's effect; one non-advisory detection restores the effect.
   * It can lower a consequence, never raise one.
   */
  advisory?: boolean;
}

/**
 * What a check's model call used, for provider cost tracking:
 * the model's registry id (`DECISION_MODELS`) and its token counts. It sits
 * outside `evidence`, which the evidence cap may cut, so it always reaches
 * the audit row; management prices Clef calls from it and never from the
 * evidence.
 */
export interface PolicyCheckUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** What `evaluateWithEvidence` returns. */
export interface PolicyEngineResult {
  detections: PolicyDetection[];
  /** Structured detail for the audit row (the check's `evidence`). */
  evidence?: Record<string, unknown>;
  /** Set when the engine called a model (the decision model). */
  usage?: PolicyCheckUsage;
  /**
   * `flag` lowers the check to flag whatever the binding's effect, as an
   * all-advisory check does; absent keeps the binding's effect. It never
   * raises one. `agent-conduct` sets it for an output whose owner chose
   * flag (internal design notes).
   */
  effect?: 'flag';
}

export function isPolicyDetectionWithSpans(d: PolicyDetection): boolean {
  return Array.isArray(d.spans) && d.spans.length > 0;
}

export interface PolicyEvalContext {
  content: string;
  binding: ResolvedPolicyBinding;
  agentId?: string;
  direction?: 'inbound' | 'outbound';
  /** Structured tool identifier when this evaluation came from a tool call. */
  toolName?: string;
  /**
   * The tool call's arguments, when the leg received them as an object. A
   * policy that constrains parameters reads them here, never out of `content`.
   */
  toolParams?: Record<string, unknown>;
  recentMessages?: BufferedMessage[];
  /** Normalized identity claims from platform attestation */
  identity?: NormalizedIdentityClaims[];
  /** Sender's organization ID (for cross-org policy checks) */
  senderOrgId?: string;
  /** Recipient's organization ID (for cross-org policy checks) */
  recipientOrgId?: string;
  /**
   * The conversation this leg belongs to, when the caller supplied one (the
   * message leg always has one; the tool leg has one when the SDK sent it).
   */
  correlationId?: string;
  /**
   * The agent's session ledger for `correlationId`. Set only when the runtime
   * has a session store, the leg has a correlation id, and the agent has a
   * session policy bound. Only the session engines read it.
   */
  session?: SessionHandle;
  /** The runtime's decision model for session checks. */
  decisionModel?: DecisionModelClient;
  /**
   * What the agent sends on this leg, normalized: set by the legs that
   * observe an agent's output (a tool call's input phase, an A2A send, a
   * reply, an external A2A send) when an `agent-conduct` binding is on the
   * leg. Only that engine reads it.
   */
  output?: AgentOutput;
}

export interface PolicyEngine {
  readonly name: string;
  evaluate(
    ctx: PolicyEvalContext,
  ): PolicyDetection[] | Promise<PolicyDetection[]>;
  /**
   * Optional: the detections plus evidence for the audit row. The evaluator
   * calls this instead of `evaluate` when an engine has it.
   */
  evaluateWithEvidence?(ctx: PolicyEvalContext): Promise<PolicyEngineResult>;
}
