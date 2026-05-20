// SPDX-License-Identifier: Apache-2.0

// ═══════════════════════════════════════════════════════════════════
// Re-exports from @spellguard/ctls (Confidential TLS)
// ═══════════════════════════════════════════════════════════════════

export type {
  VerifierAttestationDocument,
  SessionKeys,
  Evidence,
  AttestationResult,
  AgentCard,
  RegisteredAgent,
} from '@spellguard/ctls';

export {
  // Attestation
  generateAttestationDocument,
  getExpectedImageHash,
  computeImageHash,
  verifyEvidence,
  // Registry
  registerAgent,
  getAgent,
  getAgentByToken,
  getAllAgents,
  isAgentRegistered,
  rotateChannelToken,
  verifyChannelToken,
  clearRegistry,
  // Crypto
  generateSessionKeys,
  destroySessionKeys,
  getSessionPublicKey,
  signWithSessionKey,
  sign,
  verify,
  generateKeyPair,
} from '@spellguard/ctls';

// ═══════════════════════════════════════════════════════════════════
// Re-exports from @spellguard/amp (Auditable Messaging Protocol)
// ═══════════════════════════════════════════════════════════════════

export type {
  SecureMessage,
  AuditCommitment,
  Channel,
  CommitmentBackend,
  ArchiveBackend,
  LoggingResult,
  BackendConfig,
} from '@spellguard/amp';

export {
  // Commitment
  generateCommitment,
  verifyCommitment,
  // Channel
  getOrCreateChannel,
  getChannel,
  updateChannelActivity,
  getChannelStats,
  clearChannels,
  // Logging
  initLoggingBackends,
  getBackendConfig,
  isCommitmentBackendConnected,
  isArchiveBackendConnected,
  getCommitmentBackendName,
  getArchiveBackendName,
  logCommitment,
  verifyCommitmentExists,
  archiveMessage,
  retrieveArchivedMessage,
  logAndArchive,
  memoryCommitmentBackend,
  memoryArchiveBackend,
  rekorBackend,
  s3Backend,
  clearMemoryBackends,
  // Client utilities
  encryptForVerifier,
  decryptFromVerifier,
  hashPayload,
  verifyArchiveIntegrity,
} from '@spellguard/amp';

// ═══════════════════════════════════════════════════════════════════
// Verifier-specific exports (local)
// ═══════════════════════════════════════════════════════════════════

// Discovery (A2A protocol)
export {
  resolveAgentCard,
  resolveAgentCards,
  clearAgentCardCache,
} from './discovery/resolver';

// Proxy/Router
export {
  routeMessage,
  generateMessageId,
} from './proxy/router';

// Policy Evaluator
export {
  evaluatePolicies,
  type PolicyCheckResult,
  type PolicyDetection,
} from './proxy/policy-evaluator';

export type {
  NormalizedIdentityClaims,
  ResolvedPolicyBinding,
  ResolvedPolicyConfig,
  PolicyEvalContext,
  PolicyEngine,
} from './proxy/policy-evaluator-types';

// Effect Handlers
export {
  resolveResponseLevel,
  effectToDecision,
  shouldQuarantineFromChecks,
  RESPONSE_LEVEL_PRIORITY,
  type ResponseLevel,
} from './proxy/effect-handlers';

// Redactor
export {
  redact,
  type RedactionResult,
  type RedactionMetadata,
} from './proxy/redactor';

// Engine Registry
export {
  registerEngine,
  getEngine,
  clearEngines,
  getRegisteredTypes,
  initDefaultEngines,
  getSharedRateLimiter,
} from './proxy/engine-registry';

// Rate Limiter
export {
  RateLimiter,
  type RateLimitConfig,
  type RateLimitKey,
  type CheckResult as RateLimitCheckResult,
} from './proxy/rate-limiter';

// Engines
export { BuiltinEngine, safeRegex } from './proxy/builtin-engine';
export { ExternalEngine } from './proxy/external-engine';
export { ExfiltrationEngine } from './proxy/exfiltration-engine';
export { InjectionEngine } from './proxy/injection-engine';
export { LoopEngine } from './proxy/loop-engine';
export { RegexEngine } from './proxy/regex-engine';
export { SchemaEngine } from './proxy/schema-engine';
export { TimeWindowEngine } from './proxy/time-window-engine';
export { UrlEngine } from './proxy/url-engine';

// Message Buffer (for loop detection)
export {
  addMessage,
  getRecentMessages,
  clearAgentBuffer,
  clearAllBuffers,
  getBufferCount,
  type BufferedMessage,
} from './proxy/message-buffer';

// Policy Cache
export {
  getAgentPolicies,
  invalidateAgentPolicies,
  clearPolicyCache,
  startPolicyPoller,
  stopPolicyPoller,
} from './management/policy-cache';
