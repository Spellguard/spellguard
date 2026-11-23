// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Auditable Messaging Protocol
 *
 * Commitment generation, message routing, and pluggable logging backends.
 *
 * This package provides:
 * - Message commitment generation for tamper-evident audit trails
 * - Channel management for agent-to-agent communication
 * - Pluggable backends for commitment logging (memory, Rekor, none)
 * - Pluggable backends for message archiving (memory, S3)
 * - Client-side encryption utilities
 *
 * @example
 * ```typescript
 * // Server-side: Generate commitments and log them
 * import {
 *   generateCommitment,
 *   initLoggingBackends,
 *   logAndArchive
 * } from '@spellguard/amp';
 *
 * await initLoggingBackends();
 * const commitment = generateCommitment(message);
 * const result = await logAndArchive(message, commitment);
 * ```
 *
 * @example
 * ```typescript
 * // Client-side: Encrypt messages for Verifier
 * import { encryptForVerifier } from '@spellguard/amp';
 *
 * const encrypted = encryptForVerifier(payload, sessionPublicKey);
 * ```
 */

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type {
  SecureMessage,
  AuditCommitment,
  AttestationLevel,
  Channel,
  CommitmentBackend,
  ArchiveBackend,
  ArchiveOptions,
  ArchivePayload,
  LoggingResult,
  BackendConfig,
  // A2A protocol types
  A2ARequest,
  A2AResponse,
  // Unilateral communication types
  UnilateralSendRequest,
  UnilateralSendResult,
  // Shared policy primitives
  Obligation,
} from './types/index';

export { OBLIGATION_VALUES } from './types/index';

// ═══════════════════════════════════════════════════════════════════
// Client-side
// ═══════════════════════════════════════════════════════════════════

export {
  encryptForVerifier,
  decryptFromVerifier,
  deriveAgentKeyPair,
  generateAgentKeyPair,
  hashPayload,
} from './client/encrypt';

// ═══════════════════════════════════════════════════════════════════
// Server-side
// ═══════════════════════════════════════════════════════════════════

export {
  generateCommitment,
  verifyCommitment,
  generateUnilateralCommitment,
} from './server/commitment';

export {
  getOrCreateChannel,
  getChannel,
  updateChannelActivity,
  getChannelStats,
  clearChannels,
} from './server/channel';

// ═══════════════════════════════════════════════════════════════════
// Logging backends
// ═══════════════════════════════════════════════════════════════════

export {
  // Backend management
  initLoggingBackends,
  getBackendConfig,
  isCommitmentBackendConnected,
  isArchiveBackendConnected,
  getCommitmentBackendName,
  getArchiveBackendName,
  // Operations
  logCommitment,
  verifyCommitmentExists,
  archiveMessage,
  retrieveArchivedMessage,
  logAndArchive,
  // Backend implementations
  memoryCommitmentBackend,
  memoryArchiveBackend,
  noneCommitmentBackend,
  rekorBackend,
  s3Backend,
  // The SHA-256 of each archived message object, for signed audit records
  archiveDigestFor,
  // Testing utilities
  clearArchiveDigests,
  clearMemoryBackends,
  getAllCommitments,
  getArchiveCount,
  getCommitmentCount,
  getMemoryArchiveCount,
  getMemoryCommitmentCount,
} from './logging/index';

// ═══════════════════════════════════════════════════════════════════
// Profile (transport / discovery / identity abstraction)
// ═══════════════════════════════════════════════════════════════════

export {
  loadProfile,
  createOriginalProfile,
  createAgntcyProfile,
  resolveProfileLayers,
} from './profile/index';

export type {
  AgentAddress,
  DirectoryName,
  IdentityName,
  IssueCredentialInput,
  IssuedCredential,
  ProfileBundle,
  ProfileEnv,
  ProfileName,
  PublishableRecord,
  SpellguardDirectory,
  SpellguardIdentity,
  SpellguardTransport,
  TransportName,
  VerifiedClaims,
} from './profile/index';

// Shared policy registry (management, dashboard and Verifier).
export {
  AGENT_CONDUCT_MODEL_IDS,
  CREATABLE_POLICY_TYPES,
  DECISION_MODEL_IDS,
  DECISION_MODELS,
  DECISION_POLICY_TYPES,
  DEFAULT_DECISION_MODEL_ID,
  DEFAULT_DOCUMENT_READER_ID,
  DOCUMENT_READER_IDS,
  DOCUMENT_READERS,
  decisionModelIdsFor,
  getDecisionModel,
  getDocumentReader,
  getPolicyType,
  isConfiguredPolicyType,
  POLICY_TYPE_REGISTRY,
  POLICY_TYPES,
} from './policy-types';
export type {
  DecisionModel,
  DecisionModelId,
  DecisionModelProvider,
  DecisionPolicyType,
  DocumentReader,
  DocumentReaderId,
  DocumentReaderProvider,
  PolicyAuthoringMode,
  PolicyEngineFamily,
  PolicyType,
  PolicyTypeRegistryEntry,
} from './policy-types';

// Computed values and their expressions (the Verifier's engines and the
// policy readers that refuse a bad expression at save).
export {
  MAX_EXPRESSION_LENGTH,
  computeValue,
  computeValues,
  expressionNames,
  parseExpression,
} from './computed-values';
export type { ComputedResult, Expression } from './computed-values';

// The agent-conduct profile reader (management and Verifier).
export {
  AGENT_CONDUCT_CHANNELS,
  AGENT_CONDUCT_CHECKS,
  AGENT_CONDUCT_DEFAULT_THRESHOLDS,
  AGENT_CONDUCT_EFFECTS,
  AGENT_CONDUCT_FACT_KINDS,
  AGENT_CONDUCT_KEYS,
  AGENT_CONDUCT_LIMITS,
  AGENT_CONDUCT_OBSERVED_CHANNELS,
  AGENT_CONDUCT_PROBLEMS,
  AGENT_CONDUCT_TRUST_LEVELS,
  AGENT_CONDUCT_UNOBSERVED_CHANNELS,
  readAgentConductProfile,
  readAgentConductStructure,
} from './agent-conduct';
export type {
  AgentConductChannel,
  AgentConductCheck,
  AgentConductEffect,
  AgentConductFact,
  AgentConductFactKind,
  AgentConductLimit,
  AgentConductMatch,
  AgentConductOutputRule,
  AgentConductProfile,
  AgentConductReadResult,
  AgentConductSource,
  AgentConductTrust,
  PatternCompiler,
} from './agent-conduct';

// Document limits for message attachments (management and Verifier).
export {
  DOCUMENT_LIMIT_CEILING,
  DOCUMENT_LIMIT_DEFAULTS,
  DOCUMENT_LIMIT_FLOOR,
  MAX_ATTACHMENTS_PER_MESSAGE,
  effectiveDocumentLimits,
  ocrUnitsAllowed,
} from './document-limits';
export type { DocumentLimits } from './document-limits';
