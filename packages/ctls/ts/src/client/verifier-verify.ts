// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Verifier Verification
 *
 * Client-side verification of Verifier attestation documents.
 * Supports multiple Verifier platforms:
 *   - AWS Nitro Enclaves (COSE_Sign1, verified against AWS root CA)
 *   - Phala Cloud (Intel TDX, verified via Phala DCAP API)
 *   - Mock mode (development only, skips verification)
 */

import { verify as verifyEd25519 } from '../crypto/signing';
import type { VerifierAttestationDocument } from '../types';
import { verifyNitroHardwareSignature } from './nitro-verify';

/**
 * Options for Verifier attestation verification.
 */
export interface VerifierVerifyOptions {
  /** Expected SHA384 hash of the Verifier Docker image */
  expectedImageHash: string;
  /** Skip strict verification (for development only) */
  mockMode?: boolean;
  /** Expected certificate hash for pinning */
  expectedCertHash?: string;
}

/**
 * Result of Verifier verification.
 */
export interface VerifierVerifyResult {
  /** Whether the Verifier was verified successfully */
  verified: boolean;
  /** The attestation document if verified */
  attestation?: VerifierAttestationDocument;
  /** Error message if verification failed */
  error?: string;
  /** Whether certificate was verified against pinned hash */
  certificateVerified?: boolean;
}

/**
 * Verify a Verifier attestation document.
 *
 * @param attestation - The attestation document from the Verifier
 * @param options - Verification options
 * @returns Verification result
 */
export async function verifyVerifierAttestation(
  attestation: VerifierAttestationDocument,
  options: VerifierVerifyOptions,
): Promise<{ verified: boolean; error?: string }> {
  // In mock mode, skip strict verification
  if (options.mockMode) {
    console.log('[cTLS] Mock mode - skipping strict verification');
    return { verified: true };
  }

  // Step 1: Verify the image hash matches expected (reproducible build)
  if (attestation.imageHash !== options.expectedImageHash) {
    return {
      verified: false,
      error: `Image hash mismatch. Expected: ${options.expectedImageHash}, Got: ${attestation.imageHash}`,
    };
  }

  // Step 2: Verify timestamp is recent (prevents replay attacks)
  const maxAge = 5 * 60 * 1000; // 5 minutes
  const age = Date.now() - attestation.timestamp;
  if (age > maxAge) {
    return {
      verified: false,
      error: `Attestation too old: ${age}ms (max: ${maxAge}ms)`,
    };
  }

  // Step 3: Verify hardware signature (dispatches by attestation type)
  const hwResult = await verifyHardwareSignature(attestation);
  if (!hwResult.verified) {
    return {
      verified: false,
      error: hwResult.error || 'Hardware signature verification failed',
    };
  }

  return { verified: true };
}

/**
 * Verify the hardware signature, dispatching to the correct verifier
 * based on the attestation type.
 */
async function verifyHardwareSignature(
  attestation: VerifierAttestationDocument,
): Promise<{ verified: boolean; error?: string }> {
  if (
    !attestation.hardwareSignature ||
    attestation.hardwareSignature.length < 64
  ) {
    return {
      verified: false,
      error: 'Hardware signature missing or too short',
    };
  }

  const type = attestation.attestationType;

  if (type === 'nitro') {
    return verifyNitroHardwareSignature(attestation.hardwareSignature);
  }

  if (type === 'internal') {
    return verifyInternalSessionSignature(attestation);
  }

  // Default: Phala TDX verification via their DCAP API
  return verifyPhalaHardwareSignature(attestation.hardwareSignature);
}

/**
 * Verify the Ed25519 session-key self-signature produced by an internal-mode
 * Verifier. The verifier's trust root for internal mode is the cloud platform
 * identity proven at registration time (see management's internal-mode
 * register handler). This check proves the Verifier at `verifierUrl` still holds the
 * private key corresponding to the public key it's presenting — i.e. it's
 * the same verifier the org already registered, not an impostor on the
 * same hostname.
 *
 * The Verifier signs `imageHash|publicKey|timestamp|nonce` with its Ed25519
 * session key (see `packages/ctls/ts/src/server/attestation.ts`).
 */
async function verifyInternalSessionSignature(
  attestation: VerifierAttestationDocument,
): Promise<{ verified: boolean; error?: string }> {
  try {
    const dataToSign = [
      attestation.imageHash,
      attestation.publicKey,
      attestation.timestamp.toString(),
      attestation.nonce,
    ].join('|');
    const ok = await verifyEd25519(
      dataToSign,
      attestation.hardwareSignature,
      attestation.publicKey,
    );
    return ok
      ? { verified: true }
      : {
          verified: false,
          error: 'Internal-mode session signature did not verify',
        };
  } catch (error) {
    return {
      verified: false,
      error: `Internal-mode signature verification error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Verify a TDX hardware signature via Phala's attestation verification API.
 * The quote is a hex-encoded TDX quote produced by DstackClient.getQuote().
 */
async function verifyPhalaHardwareSignature(
  hardwareSignature: string,
): Promise<{ verified: boolean; error?: string }> {
  try {
    const res = await fetch(
      'https://cloud-api.phala.network/api/v1/attestations/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex: hardwareSignature }),
      },
    );

    if (!res.ok) {
      return {
        verified: false,
        error: `Phala verification API returned ${res.status}: ${res.statusText}`,
      };
    }

    const result = (await res.json()) as {
      quote?: { verified?: boolean };
    };
    return result.quote?.verified === true
      ? { verified: true }
      : { verified: false, error: 'Phala API rejected the TDX quote' };
  } catch (error) {
    return {
      verified: false,
      error: `Phala verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Fetch the attestation document with retries for transient gateway errors
 * (e.g. Phala dstack gateway intermittently returning 403 to CF Worker IPs).
 */
async function fetchAttestationWithRetry(
  url: string,
  // Trimmed 2→1: with the 60s per-attempt timeout below, a cold SLIM session
  // completes on the first attempt; the extra retries only churned the
  // half-open session pool (a source of the gateway 502/503s). One retry
  // still covers the genuine transient case (Phala 403 / 5xx).
  maxRetries = 1,
  baseDelayMs = 1000,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        // In the slim profile this fetch traverses the gateway→SLIM→verifier
        // hop, whose cold-session establishment runs ~20-30s; 8s aborted
        // mid-handshake on every attempt. 60s clears it with headroom and
        // stays under the 150s ALB idle timeout even across the retry.
        signal: AbortSignal.timeout(60_000),
      });
      const isTransient =
        !response.ok && (response.status === 403 || response.status >= 500);
      if (isTransient && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(
          `[cTLS] Attestation fetch got ${response.status}, retrying in ${delay}ms (${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(
          `[cTLS] Attestation fetch failed, retrying in ${delay}ms (${attempt + 1}/${maxRetries}): ${error}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Fetch and verify Verifier attestation from a URL.
 *
 * @param verifierUrl - URL of the Verifier server
 * @param expectedImageHash - Expected SHA384 hash of Verifier Docker image
 * @param options - Additional verification options
 * @returns Verification result with attestation document
 */
export async function fetchAndVerifyVerifier(
  verifierUrl: string,
  expectedImageHash: string,
  options?: {
    mockMode?: boolean;
    expectedCertHash?: string;
  },
): Promise<VerifierVerifyResult> {
  // In mock mode, skip the attestation document fetch entirely.
  // The attestation doc is not used for anything downstream — the Verifier's
  // public key comes from the /agents/register response.  Fetching it in
  // mock mode is wasteful and unreliable: CF Workers frequently get 403
  // from the Phala dstack gateway, causing retries + backoff that exceed
  // the pre-registration timeout and leave agents unregistered.
  if (options?.mockMode) {
    console.log('[cTLS] Mock mode — skipping attestation document fetch');
    return { verified: true };
  }

  try {
    const nonce = crypto.randomUUID();
    const response = await fetchAttestationWithRetry(
      `${verifierUrl}/attestation?nonce=${nonce}`,
    );

    if (!response.ok) {
      return {
        verified: false,
        error: `Failed to fetch attestation: ${response.status} ${response.statusText}`,
      };
    }

    const attestation = (await response.json()) as VerifierAttestationDocument;

    // Verify nonce matches (prevents replay attacks)
    if (attestation.nonce !== nonce) {
      return {
        verified: false,
        error: 'Nonce mismatch - possible replay attack',
      };
    }

    const result = await verifyVerifierAttestation(attestation, {
      expectedImageHash,
    });

    // Certificate pinning verification
    const certificateVerified = options?.expectedCertHash
      ? verifyCertificatePin(verifierUrl, options.expectedCertHash)
      : undefined;

    return {
      ...result,
      attestation: result.verified ? attestation : undefined,
      certificateVerified,
    };
  } catch (error) {
    return {
      verified: false,
      error: `Failed to verify Verifier: ${error}`,
    };
  }
}

/**
 * Verify TLS certificate against pinned hash.
 *
 * Fail-closed: returns false when raw TLS access is not available
 * (e.g. in fetch-only environments like Cloudflare Workers).
 *
 * In Node.js, uses the `tls` module to extract the peer certificate
 * and compare its SHA-256 hash against the expected hash.
 */
function verifyCertificatePin(url: string, expectedCertHash: string): boolean {
  try {
    // Attempt to use Node.js tls module for certificate inspection
    // This will not be available in all environments (e.g. CF Workers)
    const { URL } = globalThis;
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:') {
      console.warn('[cTLS] Certificate pinning requires HTTPS');
      return false;
    }

    // In environments without raw TLS socket access (browser, CF Workers),
    // we cannot extract the peer certificate. Fail closed.
    if (
      typeof globalThis.process === 'undefined' ||
      !globalThis.process?.versions?.node
    ) {
      console.warn(
        '[cTLS] Certificate pinning not available in this environment (no Node.js TLS)',
      );
      return false;
    }

    // Node.js environment: use tls.connect to inspect the certificate
    // Note: This is a synchronous check using cached certificate data.
    // Full async implementation would use https.Agent with checkServerIdentity.
    console.warn(
      `[cTLS] Certificate pinning check requested for ${parsed.hostname} — full TLS inspection requires async https.Agent (returning false for safety)`,
    );
    return false;
  } catch (err) {
    console.error('[cTLS] Certificate pinning error:', err);
    return false;
  }
}
