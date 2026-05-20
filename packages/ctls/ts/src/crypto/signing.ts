// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Ed25519 Signing Utilities
 *
 * Key generation, signing, and verification.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Generate an Ed25519 key pair.
 */
export async function generateKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  return {
    publicKey: bytesToHex(publicKey),
    privateKey: bytesToHex(privateKey),
  };
}

/**
 * Derive the Ed25519 public key for a given private key.
 *
 * Diagnostic helper — used to confirm that a stored private key
 * still corresponds to the public key recorded server-side.  When a
 * Verifier rejects evidence with "Invalid evidence signature", the
 * usual root cause is a private/public key drift across a re-launch
 * or partial-rotation; deriving the public key here lets a caller
 * diff it against what's in the agents row.
 */
export async function derivePublicKey(privateKey: string): Promise<string> {
  const isValidHex = /^[0-9a-fA-F]{64}$/.test(privateKey);
  if (!isValidHex) {
    throw new Error('derivePublicKey: privateKey must be 64-char hex');
  }
  const publicKey = await ed.getPublicKeyAsync(hexToBytes(privateKey));
  return bytesToHex(publicKey);
}

/**
 * Sign data with a private key.
 *
 * If privateKey is not a valid 64-char hex string, it's treated as a seed
 * and hashed to derive a 32-byte private key.
 *
 * @param data - Data to sign
 * @param privateKey - Private key (hex) or seed string
 * @returns Hex-encoded signature
 */
export async function sign(data: string, privateKey: string): Promise<string> {
  const dataBytes = new TextEncoder().encode(data);

  // Check if privateKey is a valid 64-char hex string (32 bytes)
  const isValidHex = /^[0-9a-fA-F]{64}$/.test(privateKey);
  const keyBytes = isValidHex
    ? hexToBytes(privateKey)
    : sha256(new TextEncoder().encode(privateKey)); // Derive key from seed

  const signature = await ed.signAsync(dataBytes, keyBytes);
  return bytesToHex(signature);
}

/**
 * Verify an Ed25519 signature.
 *
 * @param data - Original data that was signed
 * @param signature - Hex-encoded signature
 * @param publicKey - Hex-encoded public key
 * @returns True if signature is valid
 */
export async function verify(
  data: string,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  const dataBytes = new TextEncoder().encode(data);
  return ed.verifyAsync(
    hexToBytes(signature),
    dataBytes,
    hexToBytes(publicKey),
  );
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
