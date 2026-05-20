// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Ephemeral Session Keys
 *
 * RAM-only session key management for forward secrecy.
 * Keys are never persisted and destroyed on shutdown.
 *
 * Ed25519 keys are used for signing.
 * X25519 keys are used for ECDH key agreement (encryption).
 */

import { x25519 } from '@noble/curves/ed25519.js';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// RAM-only session keys - never persisted
let sessionPrivateKey: Uint8Array | null = null;
let sessionPublicKey: string | null = null;

// X25519 keys for ECDH key agreement
let sessionX25519PrivateKey: Uint8Array | null = null;
let sessionX25519PublicKey: string | null = null;

/**
 * Generate ephemeral session keys.
 * These exist ONLY in RAM and provide forward secrecy.
 * Generates both Ed25519 (signing) and X25519 (encryption) key pairs.
 */
export async function generateSessionKeys(): Promise<void> {
  // Ed25519 for signing
  sessionPrivateKey = ed.utils.randomPrivateKey();
  const publicKeyBytes = await ed.getPublicKeyAsync(sessionPrivateKey);
  sessionPublicKey = bytesToHex(publicKeyBytes);

  // X25519 for ECDH key agreement
  const x25519PrivKey = x25519.utils.randomSecretKey();
  sessionX25519PrivateKey = x25519PrivKey;
  const x25519PublicKeyBytes = x25519.getPublicKey(x25519PrivKey);
  sessionX25519PublicKey = bytesToHex(x25519PublicKeyBytes);

  console.log(
    '[cTLS] Generated ephemeral session keys (Ed25519 + X25519, RAM-only)',
  );
}

/**
 * Destroy session keys.
 * Called on shutdown for forward secrecy.
 */
export function destroySessionKeys(): void {
  if (sessionPrivateKey) {
    sessionPrivateKey.fill(0);
    sessionPrivateKey = null;
  }
  sessionPublicKey = null;

  if (sessionX25519PrivateKey) {
    sessionX25519PrivateKey.fill(0);
    sessionX25519PrivateKey = null;
  }
  sessionX25519PublicKey = null;

  console.log('[cTLS] Destroyed session keys');
}

/**
 * Get the Ed25519 session public key.
 */
export function getSessionPublicKey(): string | null {
  return sessionPublicKey;
}

/**
 * Get the X25519 session public key for ECDH key agreement.
 */
export function getSessionX25519PublicKey(): string | null {
  return sessionX25519PublicKey;
}

/**
 * Get the X25519 session private key (used by Verifier for decryption).
 */
export function getSessionX25519PrivateKey(): string | null {
  if (!sessionX25519PrivateKey) return null;
  return bytesToHex(sessionX25519PrivateKey);
}

/**
 * Sign data with the session private key.
 */
export async function signWithSessionKey(data: Uint8Array): Promise<string> {
  if (!sessionPrivateKey) {
    throw new Error('Session keys not initialized');
  }

  const signature = await ed.signAsync(data, sessionPrivateKey);
  return bytesToHex(signature);
}

/**
 * Verify a signature made with the session key.
 */
export async function verifySessionSignature(
  data: Uint8Array,
  signature: string,
): Promise<boolean> {
  if (!sessionPublicKey) {
    throw new Error('Session keys not initialized');
  }

  return ed.verifyAsync(
    hexToBytes(signature),
    data,
    hexToBytes(sessionPublicKey),
  );
}

/**
 * Serializable session key data for persistence (e.g. Durable Object storage).
 */
export interface SessionKeyData {
  ed25519PrivateKey: string; // hex
  ed25519PublicKey: string; // hex
  x25519PrivateKey: string; // hex
  x25519PublicKey: string; // hex
}

/**
 * Export current session keys as a serializable object.
 * Used to persist keys to external storage (e.g. Durable Object).
 */
export function exportSessionKeys(): SessionKeyData | null {
  if (!sessionPrivateKey || !sessionPublicKey) return null;
  if (!sessionX25519PrivateKey || !sessionX25519PublicKey) return null;

  return {
    ed25519PrivateKey: bytesToHex(sessionPrivateKey),
    ed25519PublicKey: sessionPublicKey,
    x25519PrivateKey: bytesToHex(sessionX25519PrivateKey),
    x25519PublicKey: sessionX25519PublicKey,
  };
}

/**
 * Restore session keys from a previously exported SessionKeyData object.
 * Used to hydrate module state on cold start (e.g. from Durable Object storage).
 */
export function restoreSessionKeys(data: SessionKeyData): void {
  sessionPrivateKey = hexToBytes(data.ed25519PrivateKey);
  sessionPublicKey = data.ed25519PublicKey;
  sessionX25519PrivateKey = hexToBytes(data.x25519PrivateKey);
  sessionX25519PublicKey = data.x25519PublicKey;

  console.log('[cTLS] Restored session keys from external storage');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
