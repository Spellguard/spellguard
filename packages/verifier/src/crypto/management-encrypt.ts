// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypt message content for Management Server decryption.
 *
 * Two archive formats are produced depending on whether ADMIN_AUDIT_KMS_ARN is set:
 *
 * Version 0x02 (legacy, ADMIN_AUDIT_KMS_ARN not set):
 *   Single-key ECDH X25519 + AES-256-GCM targeted at the management archive key.
 *   Wire format: 0x02 || ephemeralPublicKey (32 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
 *   Base64-encoded for storage.
 *   NOTE: v2 has NO KMS-wrapped DEK, so the archive key is its ONLY decryption
 *   path — lose that key and v2 archives are unrecoverable.
 *
 * Version 3 (ADMIN_AUDIT_KMS_ARN set):
 *   Envelope encryption with a per-message AES-256 DEK.
 *   The DEK is wrapped under two independent keys:
 *     - wrappedDEK.kms      — KMS-encrypted blob (admin/auditor path)
 *     - wrappedDEK.management — ECDH-wrapped DEK under the archive key (operational path)
 *   Wire format for wrappedDEK.management uses version byte 0x03 with
 *   HKDF info "spellguard-dek-wrap-v1" to distinguish it from v2 full-plaintext wrapping.
 *   The outer archive is stored as a JSON string (not binary).
 *
 * KEY SPLIT: the archive key is `MANAGEMENT_ARCHIVE_PUBLIC_KEY`, a dedicated
 * native X25519 keypair. It used to be derived from the Ed25519
 * `MANAGEMENT_PUBLIC_KEY`, which also signs policy bundles, discovery responses
 * and agent-binding tokens — one key serving both EdDSA signing and X25519 key
 * agreement. That coupling meant rotating the signing key silently broke archive
 * decryption. `MANAGEMENT_PUBLIC_KEY` is still accepted here as a deprecated
 * fallback so a half-migrated deployment keeps working; remove it once every
 * environment sets the dedicated key.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { generateDataKey } from '../services/kms-client';
import { base64ToBytes, bytesToBase64 } from './base64';

const VERSION_V2 = 0x02;
const VERSION_DEK_WRAP = 0x03;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const HKDF_INFO_V2 = 'spellguard-archive-v1';
const HKDF_INFO_DEK_WRAP = 'spellguard-dek-wrap-v1';

/** Ed25519 SPKI DER prefix (12 bytes before the 32-byte public key). OID 1.3.101.112. */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
/** X25519 SPKI DER prefix. OID 1.3.101.110 — note `6e` vs Ed25519's `70`. */
const X25519_SPKI_PREFIX = '302a300506032b656e032100';

let managementX25519PublicKey: Uint8Array | null = null;
let adminCmkArn: string | null = null;

// Observability for the v3 → v2 downgrade path.
//
// A KMS failure deliberately does NOT stop archiving — losing the audit record
// outright would be worse than recording it under the weaker single-key format.
// The cost of that choice is that a misconfigured deployment looks exactly like
// a healthy one: archives keep flowing, nothing errors upstream, and the only
// evidence that dual-key protection stopped working is a log line. So emit that
// line unmissably, and on the FIRST occurrence, rather than leaving it buried in
// per-message noise where nobody reads it.
let v3ConfirmedLogged = false;
let v3DegradedLogged = false;

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
  v3ConfirmedLogged = false;
  v3DegradedLogged = false;

  // Preferred: a DEDICATED native X25519 archive key. Legacy: the combined
  // Ed25519 key, converted to X25519 — see the key-split note in the header.
  const archiveKey = process.env.MANAGEMENT_ARCHIVE_PUBLIC_KEY?.trim();
  const legacyKey = process.env.MANAGEMENT_PUBLIC_KEY?.trim();

  if (!archiveKey && !legacyKey) {
    // FAIL CLOSED. Previously this warned and disabled encryption, which meant
    // a single missing/misnamed variable silently produced PLAINTEXT archives
    // with nothing but a log line to show for it. An operator who genuinely
    // wants unencrypted archives must now say so explicitly.
    if (process.env.SPELLGUARD_ALLOW_UNENCRYPTED_ARCHIVES === 'true') {
      console.warn(
        '[ManagementEncrypt] No archive key set and SPELLGUARD_ALLOW_UNENCRYPTED_ARCHIVES=true — archive encryption DISABLED',
      );
      return false;
    }
    throw new Error(
      '[ManagementEncrypt] MANAGEMENT_ARCHIVE_PUBLIC_KEY is not set — refusing to start with archive encryption disabled. ' +
        'Set MANAGEMENT_ARCHIVE_PUBLIC_KEY (preferred) or the legacy MANAGEMENT_PUBLIC_KEY, or set ' +
        'SPELLGUARD_ALLOW_UNENCRYPTED_ARCHIVES=true to opt out deliberately (local development only).',
    );
  }

  try {
    if (archiveKey) {
      managementX25519PublicKey = parseX25519PublicKey(archiveKey);
      console.log(
        '[ManagementEncrypt] Loaded X25519 archive key from MANAGEMENT_ARCHIVE_PUBLIC_KEY',
      );
    } else {
      // biome-ignore lint/style/noNonNullAssertion: guarded by the !archiveKey && !legacyKey check above
      const ed25519PubKey = extractEd25519PublicKey(legacyKey!);
      managementX25519PublicKey = ed25519.utils.toMontgomery(ed25519PubKey);
      console.warn(
        '[ManagementEncrypt] DEPRECATED: derived the X25519 archive key from MANAGEMENT_PUBLIC_KEY. ' +
          'Set MANAGEMENT_ARCHIVE_PUBLIC_KEY instead — one key must not serve both EdDSA signing and X25519 key agreement.',
      );
    }
  } catch (err) {
    // FAIL CLOSED on a malformed key too, not just a missing one. Returning
    // false here would disable encryption — so a typo, or an Ed25519 value
    // pasted into the X25519 archive slot, would quietly produce PLAINTEXT
    // archives. A key that is PRESENT but unusable is a misconfiguration, never
    // an opt-out; SPELLGUARD_ALLOW_UNENCRYPTED_ARCHIVES is the only opt-out.
    throw new Error(
      `[ManagementEncrypt] Failed to load the management archive key — refusing to start. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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

export type ArchiveEncryptionMode = 'disabled' | 'v2' | 'v3';

/**
 * The archive format this process is CONFIGURED to write.
 *
 * Configured, not observed — the distinction matters. `'v3'` means
 * ADMIN_AUDIT_KMS_ARN is set, NOT that KMS is reachable or that the runtime
 * identity holds `kms:GenerateDataKey`. Because `encryptForManagement` falls
 * back to v2 on any KMS failure, a process can report `'v3'` while emitting v2
 * archives. Use this for startup/health reporting; use the one-time
 * CONFIRMED/DEGRADATION log lines to tell whether v3 is actually working.
 */
export function getArchiveEncryptionMode(): ArchiveEncryptionMode {
  if (!managementX25519PublicKey) return 'disabled';
  return adminCmkArn ? 'v3' : 'v2';
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

    if (!v3ConfirmedLogged) {
      v3ConfirmedLogged = true;
      console.log(
        '[ManagementEncrypt] v3 dual-key archive encryption CONFIRMED — first kms:GenerateDataKey succeeded; archives are being written in the dual-key format',
      );
    }

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
    if (!v3DegradedLogged) {
      v3DegradedLogged = true;
      console.error(
        '[ManagementEncrypt] SECURITY DEGRADATION: ADMIN_AUDIT_KMS_ARN is set but kms:GenerateDataKey FAILED. Archives are being written in the weaker v2 single-key format, so the admin/auditor KMS unwrap path does not exist for them and GET /v1/admin/logs/{logId}/content will answer 422 for anything archived while this persists. Most likely cause: the runtime identity lacks kms:GenerateDataKey on the CMK, or the ARN/region is wrong. Archiving deliberately continues — losing the record would be worse than recording it single-key. Logged once per process; per-message errors follow.',
      );
    }
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
 * Parse a 32-byte X25519 public key from SPKI PEM, 64-char hex, or base64.
 *
 * PEM is accepted because it is what `openssl genpkey -algorithm X25519` emits,
 * and requiring operators to hand-extract raw bytes to satisfy a mandatory
 * security control just pushes them toward the opt-out.
 *
 * NOTE the deliberate asymmetry with `extractEd25519PublicKey`: BARE keys are
 * 32 bytes in both algorithms, so hex alone cannot tell them apart, and the
 * VARIABLE NAME is what disambiguates — `MANAGEMENT_ARCHIVE_PUBLIC_KEY` is
 * always X25519 and is never converted; `MANAGEMENT_PUBLIC_KEY` is always
 * Ed25519 and is always converted. Do not merge these two parsers.
 *
 * A PEM, however, carries its algorithm OID, so the one confusion that IS
 * detectable — an Ed25519 PEM pasted into the archive slot — is caught and
 * named rather than being silently accepted as 32 opaque bytes.
 */
function parseX25519PublicKey(input: string): Uint8Array {
  if (input.includes('-----BEGIN')) {
    const der = base64ToBytes(
      input.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    );
    const derHex = bytesToHex(der);
    if (derHex.startsWith(ED25519_SPKI_PREFIX)) {
      throw new Error(
        'MANAGEMENT_ARCHIVE_PUBLIC_KEY is an Ed25519 key, but the archive key must be X25519. ' +
          'It is a SEPARATE keypair from the signing key — generate one with ' +
          '`openssl genpkey -algorithm X25519 -pubout`. (To keep the historical derived-key ' +
          'behaviour instead, set MANAGEMENT_PUBLIC_KEY and leave this unset.)',
      );
    }
    const prefixIndex = derHex.indexOf(X25519_SPKI_PREFIX);
    if (prefixIndex === -1) {
      throw new Error('Not a valid X25519 SPKI public key');
    }
    const keyHex = derHex.slice(
      prefixIndex + X25519_SPKI_PREFIX.length,
      prefixIndex + X25519_SPKI_PREFIX.length + 64,
    );
    return hexToBytes(keyHex);
  }

  const bytes = /^[0-9a-f]{64}$/i.test(input)
    ? hexToBytes(input)
    : base64ToBytes(input.replace(/\s+/g, ''));
  if (bytes.length !== KEY_LENGTH) {
    throw new Error(
      `MANAGEMENT_ARCHIVE_PUBLIC_KEY must be a 32-byte X25519 key (64-char hex or base64), got ${bytes.length} bytes`,
    );
  }
  return bytes;
}

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
