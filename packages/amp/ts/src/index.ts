// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Auditable Messaging Protocol
 *
 * Commitment generation, message routing, and pluggable logging backends.
 *
 * This package provides:
 * - Message commitment generation for tamper-evident audit trails
 * - Channel management for agent-to-agent communication
 * - Pluggable backends for commitment logging (memory, Rekor)
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
 * import { encryptForVerifier, verifyArchiveIntegrity } from '@spellguard/amp';
 *
 * const encrypted = encryptForVerifier(payload, sessionPublicKey);
 * const isValid = await verifyArchiveIntegrity(commitment, archive);
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
  hashPayload,
} from './client/encrypt';

export { verifyArchiveIntegrity } from './client/verify';

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
  rekorBackend,
  s3Backend,
  // Testing utilities
  clearMemoryBackends,
  getAllCommitments,
  getArchiveCount,
  getCommitmentCount,
  getMemoryArchiveCount,
  getMemoryCommitmentCount,
} from './logging/index';
