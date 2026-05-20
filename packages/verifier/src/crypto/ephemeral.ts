// SPDX-License-Identifier: Apache-2.0

import { x25519 } from '@noble/curves/ed25519.js';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import type { SessionKeys } from '../types';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Ephemeral session keys for forward secrecy.
 * These keys exist ONLY in Verifier RAM and are destroyed on shutdown.
 * Even if the Verifier is compromised later, past messages cannot be decrypted.
 */
let currentSessionKeys: SessionKeys | null = null;

/**
 * Generate new ephemeral session keys.
 * Called once at Verifier boot - keys are never persisted.
 * Generates both Ed25519 (signing) and X25519 (encryption) key pairs.
 */
export async function generateSessionKeys(): Promise<SessionKeys> {
  // Ed25519 for signing
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  // X25519 for ECDH key agreement
  const x25519PrivateKey = x25519.utils.randomSecretKey();
  const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey);

  currentSessionKeys = {
    publicKey: bytesToHex(publicKey),
    privateKey: bytesToHex(privateKey),
    x25519PublicKey: bytesToHex(x25519PublicKey),
    x25519PrivateKey: bytesToHex(x25519PrivateKey),
    createdAt: Date.now(),
  };

  console.log(
    '[Verifier] Generated ephemeral session keys (Ed25519 + X25519, RAM-only)',
  );
  return currentSessionKeys;
}

/**
 * Get current session keys.
 * Returns null if keys haven't been generated yet.
 */
export function getSessionKeys(): SessionKeys | null {
  return currentSessionKeys;
}

/**
 * Get the Ed25519 public key for sharing with clients.
 */
export function getSessionPublicKey(): string | null {
  return currentSessionKeys?.publicKey ?? null;
}

/**
 * Get the X25519 public key for ECDH key agreement.
 */
export function getSessionX25519PublicKey(): string | null {
  return currentSessionKeys?.x25519PublicKey ?? null;
}

/**
 * Get the X25519 private key (used by Verifier for decryption).
 */
export function getSessionX25519PrivateKey(): string | null {
  return currentSessionKeys?.x25519PrivateKey ?? null;
}

/**
 * Sign data with the session private key.
 */
export async function signWithSessionKey(data: Uint8Array): Promise<string> {
  if (!currentSessionKeys) {
    throw new Error('Session keys not initialized');
  }
  const signature = await ed.signAsync(
    data,
    hexToBytes(currentSessionKeys.privateKey),
  );
  return bytesToHex(signature);
}

/**
 * Verify a signature against the session public key.
 */
export async function verifySessionSignature(
  data: Uint8Array,
  signature: string,
): Promise<boolean> {
  if (!currentSessionKeys) {
    throw new Error('Session keys not initialized');
  }
  return ed.verifyAsync(
    hexToBytes(signature),
    data,
    hexToBytes(currentSessionKeys.publicKey),
  );
}

/**
 * Destroy session keys from memory.
 * Called on Verifier shutdown to ensure forward secrecy.
 */
export function destroySessionKeys(): void {
  if (currentSessionKeys) {
    // Overwrite with zeros before nulling (defense in depth)
    currentSessionKeys.privateKey = '0'.repeat(
      currentSessionKeys.privateKey.length,
    );
    currentSessionKeys.publicKey = '0'.repeat(
      currentSessionKeys.publicKey.length,
    );
    currentSessionKeys.x25519PrivateKey = '0'.repeat(
      currentSessionKeys.x25519PrivateKey.length,
    );
    currentSessionKeys.x25519PublicKey = '0'.repeat(
      currentSessionKeys.x25519PublicKey.length,
    );
    currentSessionKeys = null;
    console.log('[Verifier] Session keys destroyed from memory');
  }
}

// Utility functions
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
