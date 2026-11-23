// SPDX-License-Identifier: Apache-2.0

// ═══════════════════════════════════════════════════════════════════
// Re-exports from @spellguard/ctls (Confidential TLS)
// ═══════════════════════════════════════════════════════════════════

export type {
  AgentCard,
  VerifierAttestationDocument,
  AttestationResult,
  Evidence,
} from '@spellguard/ctls/types';

export {
  verifyVerifierAttestation,
  fetchAndVerifyVerifier,
} from '@spellguard/ctls/client';

export {
  generateKeyPair,
  sign,
  verify,
  derivePublicKey,
} from '@spellguard/ctls/crypto';

// ═══════════════════════════════════════════════════════════════════
// Re-exports from @spellguard/amp (Auditable Messaging Protocol)
// ═══════════════════════════════════════════════════════════════════

export {
  encryptForVerifier,
  decryptFromVerifier,
  hashPayload as hash,
} from '@spellguard/amp/client';

// ═══════════════════════════════════════════════════════════════════
// Client-specific types
// ═══════════════════════════════════════════════════════════════════

export type {
  SpellguardConfig,
  SpellguardDiscoveryConfig,
  ResolvedAgent,
  ClientChannel,
  UnilateralSendOptions,
  ManagedConfig,
  DirectConfig,
  SpellguardConfigMode,
  SpellguardOptions,
  IntentDetectionModelOrFactory,
  ModelOrFactory,
  MessageContext,
  MessageAttachment,
  WithAttachments,
} from './types';

// Re-export ClientChannel as Channel for backwards compatibility
export type { ClientChannel as Channel } from './types';

// ═══════════════════════════════════════════════════════════════════
// Client-specific functionality
// ═══════════════════════════════════════════════════════════════════

// Configuration and channel management
export {
  configure,
  createAttestationState,
  discoverAndConfigure,
  getOrCreateChannel,
  getConfig,
  invalidateChannel,
  rediscover,
  reset,
  runWithAttestationState,
  checkToolPolicy,
} from './attestation';
export type { AttestationState, ToolCheckResult } from './attestation';

// Discovery
export {
  discoverAgents,
  resolveAgentCard,
  clearAgentCache,
  registerLocalAgent,
} from './discovery';

// Intent detection
export {
  AGENT_DETECTION_SYSTEM_PROMPT,
  detectAgentReferences,
  mightContainAgentReference,
  setIntentDetectionModel,
  setIntentDetectFn,
  getIntentDetectionModel,
} from './intent';

// Shared AI helpers (used by @spellguard/langchain, @spellguard/openai, and other integrations)
export {
  buildAgentContextBlock,
  isSpellguardAgent,
  extractTextFromResponse,
  isPolicyOrRateLimitError,
  resolveAndCollectAgentResponses,
  // Peer fan-out width: the default, and the env-configurable resolver.
  DEFAULT_FANOUT_CONCURRENCY,
  resolveFanoutConcurrency,
} from './ai';
export type { AgentResponse } from './ai';

// Bounded-concurrency fan-out helper (backs the peer fan-out; exported for reuse + tests)
export { mapWithConcurrency } from './concurrency';

// Spellguard instance + middleware
export { createSpellguard } from './spellguard';
export type { SpellguardInstance } from './spellguard';

// Trace context (hops + correlation id).  Top-level callers wrap
// their work in `runWithHops(0, fn)` — every nested channel.send
// inside the closure stamps the same auto-generated correlation id
// onto outbound payloads, so multi-hop conversations land in
// audit_logs under a single correlation_id and surface as one
// multi-party session in the dashboard.
export {
  getCurrentHops,
  getCurrentCorrelationId,
  runWithHops,
} from './hop-context';

// Backwards-compatible middleware helper
export { createSpellguardMiddleware } from './middleware';

// — self-reported SDK token telemetry. Exported
// so the OpenAI + LangChain adapter packages emit through the same fail-open
// transport as the core generateText/intent/streamText instrumentation.
export {
  reportUsageEvent,
  reportAiSdkUsage,
  modelIdOf,
} from './usage-telemetry';
export type { UsageEvent, ReportUsageDeps } from './usage-telemetry';
export { runWithWaitUntil, withRequestWaitUntil } from './wait-until';
export type { WaitUntil } from './wait-until';

// Lockfile / dependency reporting (advisory pipeline input)
export {
  readLockfileFromDir,
  reportDependencies,
  SUPPORTED_LOCKFILES,
  type LockfileFile,
  type ParsedDependency,
  type ReportDependenciesOptions,
  type ReportDependenciesResult,
} from './dependencies';
