// SPDX-License-Identifier: Apache-2.0

/**
 * SG-02 + SG-10: Asymmetric Admin Authentication
 *
 * Ed25519 signature verification with key ring for rotation support.
 * Replaces the previous shared-secret HMAC model.
 */

import { sha256 } from '@noble/hashes/sha256';
import { verify } from '@spellguard/ctls';
import type { AdminEvaluateError } from './admin-evaluate';

interface AdminSigningKey {
  keyId: string; // first 16 hex chars of SHA-256(publicKeyBytes)
  publicKeyHex: string; // 64-char hex Ed25519 public key
  addedAt: number;
  expiresAt: number | null;
}

const adminKeyRing = new Map<string, AdminSigningKey>();

/** Ed25519 SPKI DER prefix (12 bytes): SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING } */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse a public key value that may be PEM (SPKI) or raw 64-char hex.
 * Returns the 64-char hex representation of the raw 32-byte Ed25519 key.
 */
function parsePublicKey(value: string): string {
  const trimmed = value.trim();

  // Raw hex (64 hex chars = 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  // PEM format — strip headers, decode base64, extract raw key
  if (trimmed.startsWith('-----BEGIN')) {
    const base64 = trimmed.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    // Ed25519 SPKI is exactly 44 bytes: 12-byte prefix + 32-byte key
    if (der.length !== 44) {
      throw new Error(
        `Invalid SPKI DER length: expected 44 bytes, got ${der.length}`,
      );
    }
    const derHex = bytesToHex(der);
    if (!derHex.startsWith(ED25519_SPKI_PREFIX)) {
      throw new Error('Not an Ed25519 SPKI public key');
    }
    return derHex.slice(ED25519_SPKI_PREFIX.length);
  }

  throw new Error('MANAGEMENT_PUBLIC_KEY must be PEM (SPKI) or 64-char hex');
}

function computeKeyId(publicKeyHex: string): string {
  const pubBytes = hexToBytes(publicKeyHex);
  const hash = sha256(pubBytes);
  return bytesToHex(hash).slice(0, 16);
}

export function addAdminKey(
  publicKeyInput: string,
  expiresAt?: number | null,
): string {
  const publicKeyHex = parsePublicKey(publicKeyInput);
  const keyId = computeKeyId(publicKeyHex);
  adminKeyRing.set(keyId, {
    keyId,
    publicKeyHex,
    addedAt: Date.now(),
    expiresAt: expiresAt ?? null,
  });
  return keyId;
}

export function initAdminKeys(): void {
  adminKeyRing.clear();
  const primary = process.env.MANAGEMENT_PUBLIC_KEY;
  if (primary) {
    const keyId = addAdminKey(primary);
    console.log(`[AdminAuth] Loaded primary signing key: ${keyId}`);
  }
  const previous = process.env.MANAGEMENT_PUBLIC_KEY_PREVIOUS;
  if (previous) {
    const expiryStr = process.env.MANAGEMENT_KEY_PREVIOUS_EXPIRES;
    const expiresAt = expiryStr
      ? new Date(expiryStr).getTime()
      : Date.now() + 86_400_000; // 24h default
    const keyId = addAdminKey(previous, expiresAt);
    console.log(
      `[AdminAuth] Loaded previous signing key: ${keyId} (expires: ${new Date(expiresAt).toISOString()})`,
    );
  }
  if (adminKeyRing.size === 0) {
    console.warn('[AdminAuth] No admin signing keys configured');
  }
}

export function getAdminKeyCount(): number {
  return adminKeyRing.size;
}

export async function verifyAdminSignature(
  signature: string | undefined,
  keyId: string | undefined,
  rawBody: string,
): Promise<AdminEvaluateError | null> {
  if (!signature) {
    return {
      code: 'UNAUTHORIZED',
      message: 'Missing admin signature',
      status: 401,
    };
  }

  if (adminKeyRing.size === 0) {
    // SG-07: Return normalized error — don't reveal that keys aren't configured
    return {
      code: 'EVALUATION_FAILED',
      message: 'Could not process evaluation request',
      status: 422,
    };
  }

  const now = Date.now();

  // If key ID provided, look up specific key
  if (keyId) {
    const key = adminKeyRing.get(keyId);
    if (!key) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Invalid admin signature',
        status: 401,
      };
    }
    if (key.expiresAt && now > key.expiresAt) {
      return {
        code: 'UNAUTHORIZED',
        message: 'Invalid admin signature',
        status: 401,
      };
    }
    try {
      const valid = await verify(rawBody, signature, key.publicKeyHex);
      if (valid) return null;
    } catch {
      // Verification failed — fall through
    }
    return {
      code: 'UNAUTHORIZED',
      message: 'Invalid admin signature',
      status: 401,
    };
  }

  // No key ID — try all non-expired keys (transition period)
  for (const key of adminKeyRing.values()) {
    if (key.expiresAt && now > key.expiresAt) continue;
    try {
      const valid = await verify(rawBody, signature, key.publicKeyHex);
      if (valid) return null;
    } catch {
      // Try next key
    }
  }

  return {
    code: 'UNAUTHORIZED',
    message: 'Invalid admin signature',
    status: 401,
  };
}

/** Reset key ring (for testing). */
export function resetAdminKeys(): void {
  adminKeyRing.clear();
}
