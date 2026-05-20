// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - In-Memory Backends
 *
 * Reference implementations for testing and development.
 * Data is lost when the process restarts.
 */

import type {
  ArchiveBackend,
  ArchiveOptions,
  ArchivePayload,
  AuditCommitment,
  CommitmentBackend,
  SecureMessage,
} from '../types';

// In-memory storage
const commitmentStore = new Map<
  string,
  { commitment: AuditCommitment; entryId: string; timestamp: number }
>();
const archiveStore = new Map<string, ArchivePayload | SecureMessage>();

/**
 * In-memory commitment backend.
 */
export const memoryCommitmentBackend: CommitmentBackend = {
  name: 'memory',

  async init(): Promise<void> {
    console.log(
      '[AMP/Memory] Commitment backend initialized (in-memory storage)',
    );
  },

  async logCommitment(commitment: AuditCommitment): Promise<string | null> {
    const entryId = `mem_commit_${Date.now()}_${commitment.messageId}`;
    commitmentStore.set(commitment.hash, {
      commitment,
      entryId,
      timestamp: Date.now(),
    });
    console.log(
      `[AMP/Memory] Logged commitment: ${commitment.hash} -> ${entryId}`,
    );
    return entryId;
  },

  async verifyCommitment(commitmentHash: string): Promise<boolean> {
    return commitmentStore.has(commitmentHash);
  },

  isConnected(): boolean {
    return true;
  },
};

/**
 * In-memory archive backend.
 */
export const memoryArchiveBackend: ArchiveBackend = {
  name: 'memory',

  async init(): Promise<void> {
    console.log('[AMP/Memory] Archive backend initialized (in-memory storage)');
  },

  async archive(
    message: SecureMessage,
    commitment: AuditCommitment,
    options?: ArchiveOptions,
  ): Promise<string | null> {
    const archiveId = `mem_archive_${Date.now()}_${message.id}`;

    if (options?.encryptedEnvelope) {
      const payload: ArchivePayload = {
        messageId: message.id,
        encryptedEnvelope: options.encryptedEnvelope,
        commitment: {
          hash: commitment.hash,
          attestationLevel: commitment.attestationLevel,
        },
        archivedAt: new Date().toISOString(),
      };
      archiveStore.set(archiveId, payload);
    } else {
      archiveStore.set(archiveId, message);
    }

    console.log(
      `[AMP/Memory] Archived message: ${commitment.hash} -> ${archiveId}`,
    );
    return archiveId;
  },

  async retrieve(
    archiveId: string,
  ): Promise<ArchivePayload | SecureMessage | null> {
    return archiveStore.get(archiveId) || null;
  },

  isConnected(): boolean {
    return true;
  },
};

/**
 * Clear all in-memory data (useful for testing).
 */
export function clearMemoryBackends(): void {
  commitmentStore.clear();
  archiveStore.clear();
}

/**
 * Get commitment count (useful for testing).
 */
export function getCommitmentCount(): number {
  return commitmentStore.size;
}

/**
 * Get archive count (useful for testing).
 */
export function getArchiveCount(): number {
  return archiveStore.size;
}

/**
 * Get all commitments (useful for testing).
 * Returns commitments with their full data including attestation level.
 */
export function getAllCommitments(): Array<{
  commitment: AuditCommitment;
  entryId: string;
  timestamp: number;
}> {
  return Array.from(commitmentStore.values());
}
