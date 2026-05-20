// SPDX-License-Identifier: Apache-2.0

/**
 * Management JWT Verification for Verifier
 *
 * Verifies management JWTs to extract agentPublicKey and other claims.
 * The management server signs JWTs with Ed25519; the Verifier verifies them
 * using the management server's public key.
 */

import * as jose from 'jose';

const ISSUER = 'spellguard';

let managementPublicKey: jose.KeyLike | Uint8Array | null = null;

/**
 * Initialize the management server's public key for JWT verification.
 * Should be called at Verifier startup.
 *
 * Accepts the public key as a PEM-encoded SPKI string (env var MANAGEMENT_PUBLIC_KEY)
 * or skips initialization if not configured (graceful degradation).
 */
/** Ed25519 SPKI DER prefix (12 bytes) */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

/**
 * Convert a 64-char hex Ed25519 public key to PEM (SPKI) format.
 */
function hexToPem(hex: string): string {
  const derHex = ED25519_SPKI_PREFIX + hex;
  const pairs = derHex.match(/.{2}/g) ?? [];
  const der = Uint8Array.from(pairs.map((b) => Number.parseInt(b, 16)));
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

export async function initManagementPublicKey(): Promise<void> {
  const keyInput = process.env.MANAGEMENT_PUBLIC_KEY;
  if (!keyInput) {
    console.warn(
      '[Verifier] MANAGEMENT_PUBLIC_KEY not set — management JWT verification disabled',
    );
    return;
  }

  try {
    // Accept either PEM (SPKI) or raw 64-char hex Ed25519 public key
    const pem = /^[0-9a-f]{64}$/i.test(keyInput.trim())
      ? hexToPem(keyInput.trim())
      : keyInput;
    managementPublicKey = await jose.importSPKI(pem, 'EdDSA');
    console.log('[Verifier] Management public key loaded for JWT verification');
  } catch (err) {
    console.error('[Verifier] Failed to import management public key:', err);
  }
}

/**
 * Verify a management JWT and extract agent claims.
 *
 * @param token - The JWT string from the X-Spellguard-Management-Token header
 * @returns Agent claims from the token, or null if verification is not configured
 * @throws If the token is invalid or expired
 */
export async function verifyAndExtractAgentPublicKey(
  token: string,
): Promise<{ agentId: string; agentPublicKey?: string } | null> {
  if (!managementPublicKey) {
    // Management JWT verification not configured — skip
    return null;
  }

  const { payload } = await jose.jwtVerify(token, managementPublicKey, {
    issuer: ISSUER,
  });

  const claims = payload as {
    type?: string;
    agentId?: string;
    agentPublicKey?: string;
  };

  if (claims.type !== 'management') {
    throw new Error('Invalid token type');
  }

  return {
    agentId: claims.agentId || '',
    agentPublicKey: claims.agentPublicKey,
  };
}
