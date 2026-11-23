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
import { sign } from '../crypto/signing';
import type { VerifierAttestationDocument } from '../types';

/**
 * The string an internal-mode Verifier's attestation key signs (#1259):
 * `verifierId|publicKey|imageHash|timestamp|nonce`. Management verifies it
 * with the public half a platform admin registered on the Verifier's row.
 */
export function attestationKeySigningString(input: {
  verifierId: string;
  publicKey: string;
  imageHash: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    input.verifierId,
    input.publicKey,
    input.imageHash,
    input.timestamp.toString(),
    input.nonce,
  ].join('|');
}

/**
 * Sign the document with the long-term attestation key, when one is
 * provisioned. The key is a deploy secret; a malformed value is a
 * misconfiguration and fails loudly rather than signing with a derived key.
 */
async function signWithAttestationKey(input: {
  publicKey: string;
  imageHash: string;
  timestamp: number;
  nonce: string;
}): Promise<{ verifierId: string; attestationKeySignature: string } | null> {
  const key = process.env.VERIFIER_ATTESTATION_KEY?.trim();
  if (!key) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'VERIFIER_ATTESTATION_KEY must be a 64-character hex Ed25519 private key',
    );
  }
  const verifierId = process.env.VERIFIER_ID?.trim();
  if (!verifierId) {
    throw new Error('VERIFIER_ATTESTATION_KEY is set but VERIFIER_ID is not');
  }
  return {
    verifierId,
    attestationKeySignature: await sign(
      attestationKeySigningString({ verifierId, ...input }),
      key,
    ),
  };
}

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
    // ── Internal mode (platform-attested) ─────────────────────────
    // No hardware Verifier — the verifier proves identity via cloud platform
    // tokens (AWS IAM, GCP SA, Azure MI, OIDC) instead of hardware quotes.
    // Self-sign with session key like mock mode, but this is a legitimate
    // production deployment. It is not restricted to intra-organization
    // traffic: the router's cross-org block was removed in #208.
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

  // NOTE (dev-stack live-E2E root cause): `platform === 'internal'` stamps
  // 'internal' EVEN in mock mode. The mock branch above produces the exact
  // same document as the internal branch (session-key Ed25519 over
  // `imageHash|publicKey|timestamp|nonce`), but stamping it 'mock' sent every
  // published plugin's client dispatch (`verifier-verify.ts`) down its DEFAULT
  // branch — the Phala DCAP API — which 400s on a non-TDX signature. The
  // agent's verifier channel then never establishes and every dispatch
  // fail-closes ("Blocked by Spellguard policy"), with no plugin-side fix
  // possible on already-provisioned boxes. Deploys that set
  // VERIFIER_PLATFORM=internal + VERIFIER_MOCK_MODE=true (the per-dev
  // dev-stack verifier — scripts/cloud-dev/deploy-verifier.mjs) now report the
  // scheme the document actually uses.
  const attestationType: 'nitro' | 'phala' | 'internal' | 'mock' =
    platform === 'internal'
      ? 'internal'
      : isMockMode
        ? 'mock'
        : platform === 'nitro'
          ? 'nitro'
          : 'phala';

  // Internal mode has no hardware root, so its identity is the attestation
  // key a platform admin registered for this verifier id (#1259). The mock
  // branch (a dev-stack's internal-mode Verifier) signs too when provisioned.
  const attestationKey =
    attestationType === 'internal' || isMockMode
      ? await signWithAttestationKey({ publicKey, imageHash, timestamp, nonce })
      : null;

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
    // #1244: every delivery to an agent is signed with this session key.
    deliveryAuth: 'v1',
    ...(attestationKey ?? {}),
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
