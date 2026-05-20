// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Pluggable Logging Backend System
 *
 * Supports multiple backends for commitment logging and message archiving:
 *
 * Commitment Backends (tamper-evident audit trail):
 * - 'memory': In-memory for testing
 * - 'rekor': Sigstore transparency log (free, public)
 *
 * Archive Backends (encrypted message storage):
 * - 'memory': In-memory for testing
 * - 's3': AWS S3 (supports S3-compatible services like MinIO)
 *
 * Configuration via environment variables:
 * - COMMITMENT_BACKEND: 'memory' | 'rekor' (default: 'memory')
 * - ARCHIVE_BACKEND: 'memory' | 's3' (default: 'memory')
 */

import type {
  ArchiveBackend,
  ArchiveOptions,
  AuditCommitment,
  BackendConfig,
  CommitmentBackend,
  LoggingResult,
  SecureMessage,
} from '../types/index';
import { memoryArchiveBackend, memoryCommitmentBackend } from './memory';
import { rekorBackend } from './rekor';
import { s3Backend } from './s3';

// Re-export types
export type {
  ArchiveBackend,
  BackendConfig,
  CommitmentBackend,
  LoggingResult,
} from '../types/index';

// Re-export backend implementations
export { memoryCommitmentBackend, memoryArchiveBackend } from './memory';
export { rekorBackend } from './rekor';
export { s3Backend } from './s3';

// Re-export memory backend utilities for testing
export { clearMemoryBackends, getAllCommitments } from './memory';
export {
  getArchiveCount as getMemoryArchiveCount,
  getCommitmentCount as getMemoryCommitmentCount,
} from './memory';

// Backend-aware counters (increment on successful log/archive regardless of backend)
let commitmentCount = 0;
let archiveCount = 0;

export function getCommitmentCount(): number {
  return commitmentCount;
}

export function getArchiveCount(): number {
  return archiveCount;
}

// Current active backends
let commitmentBackend: CommitmentBackend = memoryCommitmentBackend;
let archiveBackend: ArchiveBackend = memoryArchiveBackend;

/**
 * Get backend configuration from environment.
 */
export function getBackendConfig(): BackendConfig {
  return {
    commitmentBackend: process.env.COMMITMENT_BACKEND || 'memory',
    archiveBackend: process.env.ARCHIVE_BACKEND || 'memory',
  };
}

/**
 * Initialize logging backends based on environment configuration.
 */
export async function initLoggingBackends(): Promise<void> {
  const config = getBackendConfig();

  console.log('[AMP] Initializing backends...');
  console.log(`[AMP]   Commitment backend: ${config.commitmentBackend}`);
  console.log(`[AMP]   Archive backend: ${config.archiveBackend}`);

  commitmentBackend = await initCommitmentBackend(config.commitmentBackend);
  archiveBackend = await initArchiveBackend(config.archiveBackend);

  console.log('[AMP] Backends initialized');
}

/**
 * Initialize a commitment backend by name.
 */
async function initCommitmentBackend(name: string): Promise<CommitmentBackend> {
  let backend: CommitmentBackend;

  switch (name.toLowerCase()) {
    case 'rekor':
      backend = rekorBackend;
      break;
    default:
      backend = memoryCommitmentBackend;
      break;
  }

  await backend.init();
  return backend;
}

/**
 * Initialize an archive backend by name.
 */
async function initArchiveBackend(name: string): Promise<ArchiveBackend> {
  let backend: ArchiveBackend;

  switch (name.toLowerCase()) {
    case 's3':
      backend = s3Backend;
      break;
    default:
      backend = memoryArchiveBackend;
      break;
  }

  await backend.init();
  return backend;
}

/**
 * Log a commitment using the configured backend.
 */
export async function logCommitment(
  commitment: AuditCommitment,
): Promise<string | null> {
  const result = await commitmentBackend.logCommitment(commitment);
  if (result !== null) commitmentCount++;
  return result;
}

/**
 * Verify a commitment exists using the configured backend.
 */
export async function verifyCommitmentExists(
  commitmentHash: string,
): Promise<boolean> {
  return commitmentBackend.verifyCommitment(commitmentHash);
}

/**
 * Archive a message using the configured backend.
 */
export async function archiveMessage(
  message: SecureMessage,
  commitment: AuditCommitment,
  options?: ArchiveOptions,
): Promise<string | null> {
  const result = await archiveBackend.archive(message, commitment, options);
  if (result !== null) archiveCount++;
  return result;
}

/**
 * Retrieve an archived message or payload using the configured backend.
 */
export async function retrieveArchivedMessage(
  archiveId: string,
): Promise<import('../types').ArchivePayload | SecureMessage | null> {
  return archiveBackend.retrieve(archiveId);
}

/**
 * Log and archive a message in one operation.
 * Returns IDs and any warnings about failures.
 */
export async function logAndArchive(
  message: SecureMessage,
  commitment: AuditCommitment,
  options?: ArchiveOptions,
): Promise<LoggingResult> {
  const warnings: string[] = [];

  const [commitmentResult, archiveResult] = await Promise.allSettled([
    logCommitment(commitment),
    archiveMessage(message, commitment, options),
  ]);

  let commitmentId: string | undefined;
  if (commitmentResult.status === 'fulfilled' && commitmentResult.value) {
    commitmentId = commitmentResult.value;
  } else {
    warnings.push(
      `${commitmentBackend.name} commitment logging unavailable or failed`,
    );
  }

  let archiveId: string | undefined;
  if (archiveResult.status === 'fulfilled' && archiveResult.value) {
    archiveId = archiveResult.value;
  } else {
    warnings.push(`${archiveBackend.name} archival unavailable or failed`);
  }

  return { commitmentId, archiveId, warnings };
}

/**
 * Check if commitment backend is connected.
 */
export function isCommitmentBackendConnected(): boolean {
  return commitmentBackend.isConnected();
}

/**
 * Check if archive backend is connected.
 */
export function isArchiveBackendConnected(): boolean {
  return archiveBackend.isConnected();
}

/**
 * Get the name of the active commitment backend.
 */
export function getCommitmentBackendName(): string {
  return commitmentBackend.name;
}

/**
 * Get the name of the active archive backend.
 */
export function getArchiveBackendName(): string {
  return archiveBackend.name;
}
