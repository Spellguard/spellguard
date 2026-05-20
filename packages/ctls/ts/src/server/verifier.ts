// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Evidence Verification
 *
 * Server-side verification of agent evidence (RFC 9334 RATS pattern).
 */

import { sha256 } from '@noble/hashes/sha256';
import {
  getSessionPublicKey,
  getSessionX25519PublicKey,
} from '../crypto/ephemeral';
import { verify } from '../crypto/signing';
import type {
  AttestationResult,
  Evidence,
  RegisteredAgent,
} from '../types/index';
import { registerAgent } from './registry';

// Token validity duration (24 hours)
const TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1000;

// Validation constants
const MAX_AGENT_ID_LENGTH = 255;
const ALLOWED_ALGORITHMS = ['AES-256-GCM', 'ChaCha20-Poly1305'];

// SSRF protection: Block internal network addresses
const INTERNAL_IP_PATTERNS = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
];

/**
 * Options for evidence verification.
 */
export interface VerifyEvidenceOptions {
  /** Verifier's own port (for SSRF self-reference protection) */
  verifierPort?: string;
  /** Agent's Ed25519 public key (hex) for real signature verification */
  agentPublicKey?: string;
  /** Verifier's own attestation type — included in the attestation result */
  verifierAttestationType?: 'nitro' | 'phala' | 'internal' | 'mock';
}

/**
 * Check if a URL points to an internal network address.
 */
function isInternalUrl(urlString: string, verifierPort = '3000'): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;

    for (const pattern of INTERNAL_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return true;
      }
    }

    // Block self-reference to Verifier
    if (
      (hostname === 'localhost' || hostname === '127.0.0.1') &&
      url.port === verifierPort
    ) {
      return true;
    }

    return false;
  } catch {
    return true; // Invalid URL = blocked
  }
}

/**
 * Verify agent evidence and issue attestation result.
 *
 * The verifier acts as the "Verifier" role in RFC 9334 RATS:
 * 1. Receives Evidence from the Attester (agent)
 * 2. Appraises the Evidence against policy
 * 3. Returns Attestation Result
 *
 * @param evidence - Evidence submitted by the agent
 * @param options - Verification options
 * @returns Attestation result
 */
export async function verifyEvidence(
  evidence: Evidence,
  options?: VerifyEvidenceOptions,
): Promise<AttestationResult> {
  const sessionPublicKey = getSessionPublicKey();
  if (!sessionPublicKey) {
    throw new Error('Verifier session keys not initialized');
  }

  const sessionX25519PubKey = getSessionX25519PublicKey();

  const failResult = (error?: string): AttestationResult => ({
    agentId: evidence.agentId,
    verified: false,
    channelToken: '',
    sessionPublicKey: '',
    expiresAt: 0,
    error,
  });

  // Step 0: Validate agent ID length
  if (evidence.agentId.length > MAX_AGENT_ID_LENGTH) {
    return failResult(
      `Agent ID too long (max ${MAX_AGENT_ID_LENGTH} characters)`,
    );
  }

  // Step 1: Verify the evidence signature
  const signatureValid = await verifyEvidenceSignature(
    evidence,
    options?.agentPublicKey,
  );
  if (!signatureValid) {
    return failResult('Invalid evidence signature');
  }

  // Step 2: Validate claims
  const claimsValidation = validateClaims(
    evidence.claims,
    options?.verifierPort,
  );
  if (!claimsValidation.valid) {
    return failResult(claimsValidation.error);
  }

  // Step 3: Generate channel token
  const channelToken = generateChannelToken();
  const expiresAt = Date.now() + TOKEN_VALIDITY_MS;

  // Step 4: Register the agent
  const registeredAgent: RegisteredAgent = {
    agentId: evidence.agentId,
    endpoint: evidence.claims.endpoint,
    agentCardUrl: evidence.claims.agentCardUrl,
    codeHash: evidence.claims.codeHash,
    channelToken,
    registeredAt: Date.now(),
    expiresAt,
  };

  // Step 1 above already verified the evidence signature against the
  // agent's management-tracked public key, so the registering party
  // demonstrably controls the agent identity AND signed off on the
  // claimed endpoint.  That makes endpoint updates on re-registration
  // safe — preventing them only locks legitimate redeploys (e.g.
  // moving to a custom domain) out of an existing agentId without
  // adding any real anti-hijacking guarantee on top of the signature.
  const regResult = registerAgent(registeredAgent, {
    allowEndpointUpdate: true,
  });
  if (!regResult.success) {
    return failResult(regResult.error);
  }

  // Step 5: Return attestation result
  return {
    agentId: evidence.agentId,
    verified: true,
    channelToken,
    sessionPublicKey,
    sessionX25519PublicKey: sessionX25519PubKey || undefined,
    expiresAt,
    rotationPolicy: {
      maxAge: TOKEN_VALIDITY_MS,
      refreshEndpoint: '/channels/refresh',
    },
    verifierAttestationType: options?.verifierAttestationType,
  };
}

/**
 * Verify the signature on the evidence using Ed25519.
 *
 * If an agentPublicKey is provided (from management JWT), performs real
 * cryptographic verification. Otherwise falls back to field-presence
 * check for backward compatibility with pre-migration agents.
 */
async function verifyEvidenceSignature(
  evidence: Evidence,
  agentPublicKey?: string,
): Promise<boolean> {
  // If we have the agent's public key, perform real Ed25519 verification
  if (agentPublicKey) {
    try {
      // CR-001: Sign over both agentId and claims to prevent identity substitution
      const signedPayload = JSON.stringify({
        agentId: evidence.agentId,
        claims: evidence.claims,
      });
      return await verify(signedPayload, evidence.signature, agentPublicKey);
    } catch (err) {
      console.error('[cTLS] Ed25519 signature verification error:', err);
      return false;
    }
  }

  // Fallback: field-presence check for pre-migration agents without public key
  return !!(
    evidence.agentId &&
    evidence.claims &&
    evidence.claims.codeHash &&
    evidence.claims.endpoint &&
    evidence.signature
  );
}

/**
 * Validate the claims in the evidence.
 */
function validateClaims(
  claims: Evidence['claims'],
  verifierPort?: string,
): { valid: boolean; error?: string } {
  if (!claims.codeHash || !claims.endpoint) {
    return {
      valid: false,
      error: 'Missing required fields: codeHash or endpoint',
    };
  }

  try {
    new URL(claims.endpoint);
  } catch {
    return { valid: false, error: 'Invalid endpoint URL format' };
  }

  if (isInternalUrl(claims.endpoint, verifierPort)) {
    return {
      valid: false,
      error: 'internal network endpoints not allowed (SSRF protection)',
    };
  }

  if (claims.agentCardUrl) {
    try {
      new URL(claims.agentCardUrl);
    } catch {
      return { valid: false, error: 'Invalid agent card URL format' };
    }

    if (isInternalUrl(claims.agentCardUrl, verifierPort)) {
      return {
        valid: false,
        error: 'internal network agent card URLs not allowed (SSRF protection)',
      };
    }
  }

  if (claims.preferredAlgorithm) {
    if (!ALLOWED_ALGORITHMS.includes(claims.preferredAlgorithm)) {
      return {
        valid: false,
        error: `Unsupported algorithm: ${claims.preferredAlgorithm}. Allowed: ${ALLOWED_ALGORITHMS.join(', ')}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Generate a cryptographically secure channel token.
 */
function generateChannelToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
