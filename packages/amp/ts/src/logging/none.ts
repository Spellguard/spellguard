// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - "none" commitment backend
 *
 * Commitment logging deliberately switched off. Every deployed Verifier runs
 * this since the Rekor backend was retired (2026-09-30): the Rekor entries were
 * never linked back to an archive object or audit row, so they added a public
 * third-party call on the A2A hot path without adding auditability. The
 * versioned S3 archive holds the message content. The hash-chained
 * platform-audit export covers control-plane events only, not the `audit_logs`
 * rows these commitments are stored on, so those rows have no tamper evidence
 * of their own.
 *
 * Unlike the `memory` backend this holds nothing, so a long-lived process does
 * not grow with traffic and the memory-only `/logs/commitments` listing stays
 * unavailable. `logCommitment` returns a deterministic id rather than `null`
 * so callers do not emit a "commitment logging unavailable" warning on every
 * message.
 */

import type { AuditCommitment, CommitmentBackend } from '../types';

export const noneCommitmentBackend: CommitmentBackend = {
  name: 'none',

  async init(): Promise<void> {
    console.log('[AMP/None] Commitment backend initialized (logging disabled)');
  },

  async logCommitment(commitment: AuditCommitment): Promise<string | null> {
    return `none_${commitment.hash}`;
  },

  async verifyCommitment(): Promise<boolean> {
    return false;
  },

  isConnected(): boolean {
    return true;
  },
};
