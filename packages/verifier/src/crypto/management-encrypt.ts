// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypt message content for Management Server decryption.
 *
 * Two archive formats are produced depending on whether ADMIN_AUDIT_KMS_ARN is set:
 *
 * Version 0x02 (legacy, ADMIN_AUDIT_KMS_ARN not set):
 *   Single-key ECDH X25519 + AES-256-GCM targeted at MANAGEMENT_PUBLIC_KEY.
 *   Wire format: 0x02 || ephemeralPublicKey (32 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
 *   Base64-encoded for storage.
 *
 * Version 3 (ADMIN_AUDIT_KMS_ARN set):
 *   Envelope encryption with a per-message AES-256 DEK.
 *   The DEK is wrapped under two independent keys:
 *     - wrappedDEK.kms      — KMS-encrypted blob (admin/auditor path)
 *     - wrappedDEK.management — ECDH-wrapped DEK under MANAGEMENT_PUBLIC_KEY (operational path)
 *   Wire format for wrappedDEK.management uses version byte 0x03 with
 *   HKDF info "spellguard-dek-wrap-v1" to distinguish it from v2 full-plaintext wrapping.
 *   The outer archive is stored as a JSON string (not binary).
 */

import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { generateDataKey } from '../services/kms-client';

const VERSION_V2 = 0x02;
const VERSION_DEK_WRAP = 0x03;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const HKDF_INFO_V2 = 'spellguard-archive-v1';
const HKDF_INFO_DEK_WRAP = 'spellguard-dek-wrap-v1';

/** Ed25519 SPKI DER prefix (12 bytes before the 32-byte public key) */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

let managementX25519PublicKey: Uint8Array | null = null;
let adminCmkArn: string | null = null;

/**
 * Initialize the management encryption key and read the KMS CMK ARN.
 *
 * Accepts PEM (SPKI) or 64-char hex — same formats as management-jwt.ts.
 * Called once at Verifier startup.
 */
export function initManagementEncryptionKey(): boolean {
  // Reset state so callers get a clean slate on each call
  managementX25519PublicKey = null;
  adminCmkArn = null;

  const keyInput = process.env.MANAGEMENT_PUBLIC_KEY;
  if (!keyInput) {
    console.warn(
      '[ManagementEncrypt] MANAGEMENT_PUBLIC_KEY not set — archive encryption disabled',
    );
    return false;
  }

  try {
    const ed25519PubKey = extractEd25519PublicKey(keyInput.trim());
    managementX25519PublicKey = ed25519.utils.toMontgomery(ed25519PubKey);
    console.log(
      '[ManagementEncrypt] Derived X25519 encryption key from MANAGEMENT_PUBLIC_KEY',
    );
  } catch (err) {
    console.error('[ManagementEncrypt] Failed to derive encryption key:', err);
    return false;
  }

  adminCmkArn = process.env.ADMIN_AUDIT_KMS_ARN?.trim() || null;
  if (adminCmkArn) {
    console.log(
      '[ManagementEncrypt] KMS dual-key encryption enabled (v3 archives)',
    );
  } else {
    console.warn(
      '[ManagementEncrypt] ADMIN_AUDIT_KMS_ARN not set — falling back to v2 single-key archives',
    );
  }

  return true;
}

/**
 * Check whether management encryption is available.
 */
export function isManagementEncryptionEnabled(): boolean {
  return managementX25519PublicKey !== null;
}

/**
 * Encrypt an envelope for management.
 *
 * Produces a v3 JSON archive when ADMIN_AUDIT_KMS_ARN is configured, otherwise
 * falls back to the v2 base64 binary format.
 *
 * @param plaintext - JSON string to encrypt
 * @returns Encrypted archive string, or null if encryption is not configured
 */
export async function encryptForManagement(
  plaintext: string,
): Promise<string | null> {
  if (!managementX25519PublicKey) return null;

  if (adminCmkArn) {
    return encryptV3(plaintext, adminCmkArn, managementX25519PublicKey);
  }

  return encryptV2(plaintext, managementX25519PublicKey);
}

// ── V3: dual-key envelope encryption ────────────────────────────────────────

async function encryptV3(
  plaintext: string,
  cmkArn: string,
  recipientX25519PubKey: Uint8Array,
): Promise<string | null> {
  let plaintextDEK: Uint8Array | null = null;

  try {
    const { plaintextDEK: dek, encryptedDEK } = await generateDataKey(cmkArn);
    plaintextDEK = dek;

    // Encrypt the payload with the fresh DEK
    const payloadBytes = new TextEncoder().encode(plaintext);
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = gcm(plaintextDEK, nonce);
    const ciphertext = cipher.encrypt(payloadBytes);

    // Wrap the DEK under the management X25519 key
    const wrappedDEKManagement = wrapDEK(plaintextDEK, recipientX25519PubKey);

    return JSON.stringify({
      version: 3,
      kmsKeyId: cmkArn,
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
      wrappedDEK: {
        kms: bytesToBase64(encryptedDEK),
        management: wrappedDEKManagement,
      },
    });
  } catch (err) {
    console.error(
      '[ManagementEncrypt] V3 encryption failed, falling back to v2:',
      err,
    );
    return encryptV2(plaintext, recipientX25519PubKey);
  } finally {
    if (plaintextDEK) {
      plaintextDEK.fill(0);
    }
  }
}

// ── V2: legacy single-key encryption (unchanged) ─────────────────────────────

function encryptV2(
  plaintext: string,
  recipientX25519PubKey: Uint8Array,
): string {
  const payloadBytes = new TextEncoder().encode(plaintext);

  const ephemeralPrivateKey = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  const sharedSecret = x25519.getSharedSecret(
    ephemeralPrivateKey,
    recipientX25519PubKey,
  );

  const aesKey = hkdf(
    sha256,
    sharedSecret,
    undefined,
    HKDF_INFO_V2,
    KEY_LENGTH,
  );

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = gcm(aesKey, nonce);
  const ciphertext = cipher.encrypt(payloadBytes);

  const result = new Uint8Array(1 + 32 + NONCE_LENGTH + ciphertext.length);
  result[0] = VERSION_V2;
  result.set(ephemeralPublicKey, 1);
  result.set(nonce, 33);
  result.set(ciphertext, 33 + NONCE_LENGTH);

  return bytesToBase64(result);
}

// ── DEK wrapping ──────────────────────────────────────────────────────────────

/**
 * Wrap a 32-byte DEK under the given X25519 public key using ECDH + AES-256-GCM.
 *
 * Uses version byte 0x03 and HKDF info "spellguard-dek-wrap-v1" to distinguish
 * this from v2 full-plaintext encryption. Same wire layout as v2 otherwise:
 *   0x03 || ephemeralPublicKey (32 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
 *
 * @returns Base64-encoded wrapped DEK
 */
export function wrapDEK(
  dek: Uint8Array,
  recipientX25519PubKey: Uint8Array,
): string {
  const ephemeralPrivateKey = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  const sharedSecret = x25519.getSharedSecret(
    ephemeralPrivateKey,
    recipientX25519PubKey,
  );

  const aesKey = hkdf(
    sha256,
    sharedSecret,
    undefined,
    HKDF_INFO_DEK_WRAP,
    KEY_LENGTH,
  );

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = gcm(aesKey, nonce);
  const ciphertext = cipher.encrypt(dek);

  const result = new Uint8Array(1 + 32 + NONCE_LENGTH + ciphertext.length);
  result[0] = VERSION_DEK_WRAP;
  result.set(ephemeralPublicKey, 1);
  result.set(nonce, 33);
  result.set(ciphertext, 33 + NONCE_LENGTH);

  return bytesToBase64(result);
}

// ── Key parsing helpers ──────────────────────────────────────────────────────

/**
 * Extract raw 32-byte Ed25519 public key from PEM (SPKI) or 64-char hex.
 */
function extractEd25519PublicKey(input: string): Uint8Array {
  if (/^[0-9a-f]{64}$/i.test(input)) {
    return hexToBytes(input);
  }

  const base64 = input.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = base64ToBytes(base64);
  const derHex = bytesToHex(der);

  const prefixIndex = derHex.indexOf(ED25519_SPKI_PREFIX);
  if (prefixIndex === -1) {
    throw new Error('Not a valid Ed25519 SPKI public key');
  }

  const keyHex = derHex.slice(
    prefixIndex + ED25519_SPKI_PREFIX.length,
    prefixIndex + ED25519_SPKI_PREFIX.length + 64,
  );
  return hexToBytes(keyHex);
}

// ── Byte helpers ─────────────────────────────────────────────────────────────

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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
