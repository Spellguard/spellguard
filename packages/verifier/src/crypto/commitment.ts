// SPDX-License-Identifier: Apache-2.0

import { sha256 } from '@noble/hashes/sha256';
import type { AuditCommitment, SecureMessage } from '../types';

/**
 * Generate a commitment hash for a message.
 * This is what gets logged to the blockchain - NOT the plaintext payload.
 *
 * The commitment proves:
 * 1. A message existed between sender and recipient
 * 2. It was sent at a specific time
 * 3. The payload hasn't been tampered with (via payloadHash)
 *
 * But it does NOT reveal:
 * - The actual message content
 * - Any sensitive data in the payload
 */
export function generateCommitment(message: SecureMessage): AuditCommitment {
  // Hash the encrypted payload
  const payloadHash = bytesToHex(
    sha256(new TextEncoder().encode(message.encryptedPayload)),
  );

  // Generate commitment hash: H(sender || recipient || timestamp || payloadHash)
  const commitmentData = [
    message.sender,
    message.recipient,
    message.timestamp.toString(),
    payloadHash,
  ].join('|');

  const commitmentHash = bytesToHex(
    sha256(new TextEncoder().encode(commitmentData)),
  );

  return {
    messageId: message.id,
    sender: message.sender,
    recipient: message.recipient,
    hash: commitmentHash,
    timestamp: message.timestamp,
    attestationLevel: 'bilateral',
  };
}

/**
 * Verify a commitment matches a message.
 * Used for audit purposes - anyone with the message can verify the commitment.
 */
export function verifyCommitment(
  message: SecureMessage,
  commitment: AuditCommitment,
): boolean {
  const generated = generateCommitment(message);
  return generated.hash === commitment.hash;
}

/**
 * Generate a payload hash for inclusion in commitment.
 */
export function hashPayload(payload: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(payload)));
}

// Utility function
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
