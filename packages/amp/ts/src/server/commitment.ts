// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Commitment Generation
 *
 * Generate cryptographic commitments for message auditability.
 */

import { sha256 } from '@noble/hashes/sha256';
import type { AuditCommitment, SecureMessage } from '../types';

/**
 * Generate a commitment hash for bilateral communication.
 *
 * This is what gets logged to the audit trail - NOT the plaintext payload.
 *
 * The commitment proves:
 * 1. A message existed between sender and recipient
 * 2. It was sent at a specific time
 * 3. The payload hasn't been tampered with (via payloadHash)
 *
 * But it does NOT reveal:
 * - The actual message content
 * - Any sensitive data in the payload
 *
 * @param message - The secure message to generate commitment for
 * @returns AuditCommitment with attestationLevel 'bilateral'
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
 *
 * @param message - The original message
 * @param commitment - The commitment to verify
 * @returns True if commitment matches the message
 */
export function verifyCommitment(
  message: SecureMessage,
  commitment: AuditCommitment,
): boolean {
  const generated = generateCommitment(message);
  return generated.hash === commitment.hash;
}

/**
 * Hash a payload for inclusion in a commitment.
 *
 * @param payload - Payload string to hash
 * @returns Hex-encoded SHA256 hash
 */
export function hashPayload(payload: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(payload)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a commitment for unilateral communication (to an A2A-only agent).
 *
 * This creates a commitment that includes:
 * - Direction (outbound/inbound)
 * - Attestation level ('unilateral' - only sender is attested)
 * - A2A agent URL
 * - Reachability status
 * - Correlation ID linking request/response
 *
 * @param message - The secure message
 * @param direction - 'outbound' (to A2A agent) or 'inbound' (from A2A agent)
 * @param correlationId - ID linking outbound request to inbound response
 * @param a2aAgentUrl - URL of the A2A-only agent
 * @param reachable - Whether the A2A agent was reachable
 * @param httpStatus - HTTP status code (if response received)
 * @returns AuditCommitment with attestationLevel 'unilateral'
 */
export function generateUnilateralCommitment(
  message: SecureMessage,
  direction: 'outbound' | 'inbound',
  correlationId: string,
  a2aAgentUrl: string,
  reachable: boolean,
  httpStatus?: number,
): AuditCommitment {
  // Generate base commitment (will have bilateral, we override)
  const base = generateCommitment(message);

  return {
    ...base,
    attestationLevel: 'unilateral',
    direction,
    a2aAgentUrl,
    reachable,
    httpStatus,
    correlationId,
  };
}
