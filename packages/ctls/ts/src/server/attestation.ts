// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Attestation Document Generation
 *
 * Server-side generation of Verifier attestation documents.
 * Supports multiple Verifier platforms:
 *   - AWS Nitro Enclaves (via NSM device)
 *   - Phala Cloud (via dstack TDX quotes)
 *   - Mock mode (self-signed, for development)
 *
 * Platform is detected via the VERIFIER_PLATFORM environment variable.
 */

import { sha384 } from '@noble/hashes/sha512';
import { getSessionPublicKey, signWithSessionKey } from '../crypto/ephemeral';
import type { VerifierAttestationDocument } from '../types';

/**
 * Generate a Verifier attestation document.
 *
 * The document proves the Verifier's identity and code integrity. The format
 * varies by platform but always includes the image hash, a hardware
 * signature, the Verifier's ephemeral public key, and a client-provided nonce.
 *
 * @param nonce - Client-provided nonce to prevent replay attacks
 * @returns Attestation document
 */
export async function generateAttestationDocument(
  nonce: string,
): Promise<VerifierAttestationDocument> {
  const publicKey = getSessionPublicKey();

  if (!publicKey) {
    throw new Error('Session keys not initialized');
  }

  const timestamp = Date.now();
  const isMockMode = process.env.VERIFIER_MOCK_MODE === 'true';
  const platform = process.env.VERIFIER_PLATFORM?.toLowerCase();

  let imageHash: string;
  let hardwareSignature: string;
  let eventLog: string | undefined;
  let composeHash: string | undefined;

  if (platform === 'nitro' && !isMockMode) {
    // ── AWS Nitro Enclave ─────────────────────────────────────────
    // Image hash (PCR0) comes from the NSM hardware device — no env var needed.
    // The attestation document is a COSE_Sign1 signed by the Nitro hypervisor.
    const { generateNitroAttestation } = await import('./nitro-nsm');
    const userData = new TextEncoder().encode(
      ['pending', publicKey, timestamp.toString(), nonce].join('|'),
    );
    const result = await generateNitroAttestation(userData);
    hardwareSignature = result.attestationDocument;
    imageHash = result.pcrs[0] || result.pcrs['0'];
    if (!imageHash) {
      const pcrKeys = Object.keys(result.pcrs || {});
      throw new Error(
        `Nitro NSM returned no PCR0. Available keys: [${pcrKeys.join(',')}]`,
      );
    }
  } else if (platform === 'internal' && !isMockMode) {
    // ── Internal mode (platform-attested, intra-org only) ─────────
    // No hardware Verifier — the verifier proves identity via cloud platform
    // tokens (AWS IAM, GCP SA, Azure MI, OIDC) instead of hardware quotes.
    // Self-sign with session key like mock mode, but this is a legitimate
    // production deployment restricted to intra-organization traffic.
    imageHash = getExpectedImageHash();
    const dataToSign = [imageHash, publicKey, timestamp.toString(), nonce].join(
      '|',
    );
    hardwareSignature = await signWithSessionKey(
      new TextEncoder().encode(dataToSign),
    );
  } else if (isMockMode) {
    // ── Mock mode (development) ───────────────────────────────────
    // Self-sign with the session key. Not secure — for local dev only.
    imageHash = getExpectedImageHash();
    const dataToSign = [imageHash, publicKey, timestamp.toString(), nonce].join(
      '|',
    );
    hardwareSignature = await signWithSessionKey(
      new TextEncoder().encode(dataToSign),
    );
  } else {
    // ── Phala Cloud (Intel TDX) ───────────────────────────────────
    // Get a real TDX quote from Phala's dstack Guest Agent.
    // Requires /var/run/dstack.sock to be mounted in the container.
    imageHash = getExpectedImageHash();
    const dataToSign = [imageHash, publicKey, timestamp.toString(), nonce].join(
      '|',
    );
    const dataBytes = new TextEncoder().encode(dataToSign);

    const { DstackClient } = await import('@phala/dstack-sdk');
    const client = new DstackClient();

    // Hash the attestation data — getQuote accepts report_data up to 64 bytes
    const dataHash = sha384(dataBytes);
    const quoteResult = await client.getQuote(dataHash);

    hardwareSignature = quoteResult.quote; // hex-encoded TDX quote
    eventLog = quoteResult.event_log;

    // Retrieve compose hash from CVM info if available
    const info = await client.info();
    if (info.tcb_info && 'compose_hash' in info.tcb_info) {
      composeHash = (info.tcb_info as { compose_hash: string }).compose_hash;
    }
  }

  const attestationType: 'nitro' | 'phala' | 'internal' | 'mock' = isMockMode
    ? 'mock'
    : platform === 'nitro'
      ? 'nitro'
      : platform === 'internal'
        ? 'internal'
        : 'phala';

  return {
    imageHash,
    hardwareSignature,
    publicKey,
    timestamp,
    nonce,
    attestationType,
    supportedAlgorithms: ['AES-256-GCM', 'ChaCha20-Poly1305', 'Ed25519'],
    eventLog,
    composeHash,
  };
}

/**
 * Get the expected image hash for verification.
 *
 * Sources (in order):
 *   1. VERIFIER_IMAGE_HASH environment variable (set by CI/deployment)
 *   2. Mock placeholder (when VERIFIER_MOCK_MODE=true)
 *
 * For Nitro enclaves, the image hash comes from the NSM device (PCR0)
 * and this function is only used as a fallback.
 */
export function getExpectedImageHash(): string {
  const hash = process.env.VERIFIER_IMAGE_HASH;
  if (hash) return hash;

  if (process.env.VERIFIER_MOCK_MODE === 'true') {
    return 'sha384:mock-dev-image-hash';
  }

  throw new Error(
    'VERIFIER_IMAGE_HASH environment variable is required. ' +
      'Set it to the SHA384 hash of the Verifier Docker image.',
  );
}

/**
 * Compute image hash from Docker image contents.
 * Used during reproducible builds to generate the hash.
 */
export function computeImageHash(imageContents: Uint8Array): string {
  const hash = sha384(imageContents);
  return `sha384:${bytesToHex(hash)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
