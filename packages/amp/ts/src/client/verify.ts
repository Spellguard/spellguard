// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Archive Integrity Verification
 *
 * Verify that archived data matches commitment hashes.
 */

import { hashPayload } from './encrypt';

/**
 * Verify that archived data matches the commitment hash.
 * Used to detect tampering of archived messages.
 *
 * @param commitment - The commitment from the audit trail
 * @param archive - The archived message data
 * @returns True if the archive matches the commitment
 */
export async function verifyArchiveIntegrity(
  commitment: { hash: string; messageId: string },
  archive: { id: string; encryptedPayload: string },
): Promise<boolean> {
  // Compute the hash of the archived payload
  const computedHash = hashPayload(archive.encryptedPayload);

  // Compare with the commitment hash
  return commitment.hash === computedHash;
}
