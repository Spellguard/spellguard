// SPDX-License-Identifier: Apache-2.0

/**
 * Signs the audit records this Verifier reports (docs/design-audit-log-tamper-
 * evidence.md, slice 3; the format is packages/audit-verify/SPEC.md, "Signed
 * records").
 *
 * Each record gets a **signed record**: one line of JSON holding the values a
 * customer's verifier compares with the stored row, in a fixed order. The
 * Verifier signs its exact UTF-8 bytes with Ed25519 under its own audit
 * signing key (`VERIFIER_AUDIT_SIGNING_KEY`, separate from the attestation key
 * so a signature in one context can't be replayed in the other), and reports
 * both. Management stores the bytes as they are, and the key's public half is
 * published to the locked checkpoint bucket, so the signature can be checked
 * without trusting Spellguard's database.
 *
 * With no key configured, records keep the old placeholder signature and no
 * signed record, and a verifier reports them as unsigned.
 */

import { archiveDigestFor } from '@spellguard/amp';
import { derivePublicKey, envelopeKeyId, sign } from '@spellguard/ctls';

const SIGNED_RECORD_FORMAT = 1;
const PRIVATE_KEY_HEX = /^[0-9a-fA-F]{64}$/;

export interface AuditSigningKey {
  privateKey: string;
  keyId: string;
}

/** The fields of a reported entry that the signed record covers. */
export interface SignableEntry {
  id: string;
  agentId: string;
  direction: string;
  senderId: string;
  recipientId: string;
  timestamp: string;
  messageHash: string;
  attestationLevel: string;
  correlationId?: string;
  eventType?: string;
  responseLevel: string;
  policyChecks: ReadonlyArray<{
    policyId?: string;
    decision?: string;
    responseLevel?: string;
    severity?: string;
  }>;
  archiveRef?: string;
  verifierId: string;
}

let cachedKey: { source: string; key: AuditSigningKey | null } | null = null;

/**
 * The configured audit signing key, or null when none is set. A value that is
 * set but not 64 hex characters is refused rather than used: ctls's `sign`
 * would otherwise derive a different key from it, and every signature would
 * fail to verify against the published public key.
 */
export async function loadAuditSigningKey(
  value: string | undefined = process.env.VERIFIER_AUDIT_SIGNING_KEY,
): Promise<AuditSigningKey | null> {
  const source = value?.trim() ?? '';
  if (cachedKey && cachedKey.source === source) return cachedKey.key;
  let key: AuditSigningKey | null = null;
  if (source !== '') {
    if (!PRIVATE_KEY_HEX.test(source)) {
      console.error(
        '[AuditSigning] VERIFIER_AUDIT_SIGNING_KEY is not 64 hex characters; audit records are reported unsigned.',
      );
    } else {
      const publicKey = await derivePublicKey(source);
      key = {
        privateKey: source.toLowerCase(),
        keyId: envelopeKeyId(publicKey),
      };
    }
  }
  cachedKey = { source, key };
  return key;
}

/**
 * The signed record's exact text: SPEC.md's fields in SPEC.md's order.
 * `JSON.stringify` keeps insertion order, so the text is deterministic.
 */
export function signedRecordText(
  entry: SignableEntry,
  keyId: string,
  signedAt: Date,
): string {
  return JSON.stringify({
    format: SIGNED_RECORD_FORMAT,
    key_id: keyId,
    id: entry.id,
    agent_id: entry.agentId,
    direction: entry.direction,
    sender_id: entry.senderId,
    recipient_id: entry.recipientId,
    timestamp: entry.timestamp,
    message_hash: entry.messageHash.toLowerCase(),
    attestation_level: entry.attestationLevel,
    correlation_id: entry.correlationId ?? null,
    event_type: entry.eventType ?? 'message',
    response_level: entry.responseLevel,
    policy_checks: entry.policyChecks.map((check) => ({
      policy_id: check.policyId ?? null,
      decision: check.decision ?? null,
      response_level: check.responseLevel ?? null,
      severity: check.severity ?? null,
    })),
    archive_ref: entry.archiveRef ?? null,
    archive_sha256: entry.archiveRef
      ? archiveDigestFor(entry.archiveRef)
      : null,
    verifier_id: entry.verifierId,
    signed_at: signedAt.toISOString(),
  });
}

/**
 * Signs one entry: returns its signed record and its `verifier_signature`
 * (`ed25519:<key id>:<signature hex>`).
 */
export async function signAuditEntry(
  entry: SignableEntry,
  key: AuditSigningKey,
  signedAt: Date = new Date(),
): Promise<{ signedRecord: string; verifierSignature: string }> {
  const signedRecord = signedRecordText(entry, key.keyId, signedAt);
  const signature = await sign(signedRecord, key.privateKey);
  return {
    signedRecord,
    verifierSignature: `ed25519:${key.keyId}:${signature.toLowerCase()}`,
  };
}

/** Testing: forget the cached key. */
export function resetAuditSigningKeyCache(): void {
  cachedKey = null;
}
