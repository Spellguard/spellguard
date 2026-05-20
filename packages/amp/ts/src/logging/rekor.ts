// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Rekor Backend
 *
 * Sigstore Rekor transparency log for tamper-evident commitment logging.
 * Free, public, and requires no tokens or cryptocurrency.
 *
 * @see https://docs.sigstore.dev/logging/overview/
 */

import { getSessionPublicKey, signWithSessionKey } from '@spellguard/ctls';
import type { AuditCommitment, CommitmentBackend } from '../types';

const REKOR_URL = process.env.REKOR_URL || 'https://rekor.sigstore.dev';

let connected = false;
let treeSize = 0;

/**
 * Rekor transparency log backend.
 */
export const rekorBackend: CommitmentBackend = {
  name: 'rekor',

  async init(): Promise<void> {
    try {
      // Check Rekor server status
      const response = await fetch(`${REKOR_URL}/api/v1/log`, {
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const logInfo = (await response.json()) as { treeSize?: number };
        treeSize = logInfo.treeSize || 0;
        connected = true;
        console.log(
          `[AMP/Rekor] Connected to ${REKOR_URL} (tree size: ${treeSize})`,
        );
      } else {
        console.warn(`[AMP/Rekor] Failed to connect: ${response.status}`);
        connected = false;
      }
    } catch (error) {
      console.warn(`[AMP/Rekor] Connection error: ${error}`);
      connected = false;
    }
  },

  async logCommitment(commitment: AuditCommitment): Promise<string | null> {
    if (!connected) {
      console.warn('[AMP/Rekor] Not connected, skipping log');
      return null;
    }

    try {
      // Sign the commitment with the Verifier's session Ed25519 key using DSSE
      // (Dead Simple Signing Envelope).  Ed25519 is NOT compatible with
      // Rekor's `hashedrekord` type (which requires a pre-hashed artifact,
      // but Ed25519 hashes internally via SHA-512 and Rekor cannot verify
      // the signature without the original artifact).  DSSE wraps the
      // payload in a standard envelope and Ed25519 signs the PAE string.
      const sessionPubKey = getSessionPublicKey();
      if (!sessionPubKey) {
        console.warn('[AMP/Rekor] No session key available, skipping log');
        return null;
      }

      // Build DSSE payload (commitment metadata — NOT the plaintext message)
      const payloadType = 'application/vnd.spellguard.commitment+json';
      const payload = JSON.stringify({
        hash: commitment.hash,
        messageId: commitment.messageId,
        sender: commitment.sender,
        recipient: commitment.recipient,
        timestamp: commitment.timestamp,
        attestationLevel: commitment.attestationLevel,
      });

      // DSSE Pre-Authentication Encoding (PAE)
      const paeStr = `DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} ${payload}`;
      const paeBytes = new TextEncoder().encode(paeStr);

      // Sign the PAE with Ed25519
      const signatureHex = await signWithSessionKey(paeBytes);
      const sigMatches = signatureHex.match(/.{1,2}/g) ?? [];
      const sigBytes = new Uint8Array(
        sigMatches.map((b) => Number.parseInt(b, 16)),
      );
      const sigBase64 = btoa(String.fromCharCode(...sigBytes));

      // Build DSSE envelope
      const payloadBase64 = btoa(payload);
      const envelope = JSON.stringify({
        payloadType,
        payload: payloadBase64,
        signatures: [{ sig: sigBase64 }],
      });

      // Wrap raw Ed25519 public key in SubjectPublicKeyInfo DER + PEM
      const pubMatches = sessionPubKey.match(/.{1,2}/g) ?? [];
      const pubBytes = new Uint8Array(
        pubMatches.map((b) => Number.parseInt(b, 16)),
      );
      const spkiPrefix = new Uint8Array([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
      ]);
      const spkiBytes = new Uint8Array(spkiPrefix.length + pubBytes.length);
      spkiBytes.set(spkiPrefix);
      spkiBytes.set(pubBytes, spkiPrefix.length);
      const pemBody = btoa(String.fromCharCode(...spkiBytes));
      const pem = `-----BEGIN PUBLIC KEY-----\n${pemBody}\n-----END PUBLIC KEY-----\n`;
      const verifierBase64 = btoa(pem);

      const entry = {
        apiVersion: '0.0.1',
        kind: 'dsse',
        spec: {
          proposedContent: {
            envelope,
            verifiers: [verifierBase64],
          },
        },
      };

      const response = await fetch(`${REKOR_URL}/api/v1/log/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const result = (await response.json()) as Record<string, unknown>;
        const uuid = Object.keys(result)[0];
        console.log(
          `[AMP/Rekor] Logged commitment: ${commitment.hash} -> ${uuid}`,
        );
        return uuid;
      }

      // 409 means entry already exists (duplicate), which is OK
      if (response.status === 409) {
        console.log(
          `[AMP/Rekor] Commitment already exists: ${commitment.hash}`,
        );
        return `existing_${commitment.hash}`;
      }

      const body = await response.text().catch(() => '');
      console.warn(
        `[AMP/Rekor] Failed to log: ${response.status} ${body.slice(0, 500)}`,
      );
      return null;
    } catch (error) {
      console.error(`[AMP/Rekor] Error logging commitment: ${error}`);
      return null;
    }
  },

  async verifyCommitment(commitmentHash: string): Promise<boolean> {
    if (!connected) {
      return false;
    }

    try {
      // Search Rekor index for entries containing this hash.
      // DSSE entries are indexed by the SHA-256 of the envelope, not by
      // the commitment hash directly.  As a fallback, also try the
      // sha256:<hash> format that works with hashedrekord entries.
      const response = await fetch(`${REKOR_URL}/api/v1/index/retrieve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hash: `sha256:${commitmentHash}`,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const entries = await response.json();
        return Array.isArray(entries) && entries.length > 0;
      }

      return false;
    } catch (error) {
      console.error(`[AMP/Rekor] Error verifying commitment: ${error}`);
      return false;
    }
  },

  isConnected(): boolean {
    return connected;
  },
};
