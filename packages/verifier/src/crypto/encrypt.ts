// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier Encryption/Decryption using ECDH + AES-256-GCM.
 *
 * Wire format (version 0x01):
 *   0x01 || ephemeralPublicKey (32 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
 * Base64-encoded for transport.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { getSessionX25519PrivateKey } from '@spellguard/ctls/crypto';

const VERSION_BYTE = 0x01;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;

/**
 * Decrypt a payload sent by a client to the Verifier.
 *
 * Uses the Verifier's X25519 private key and the client's ephemeral public key
 * embedded in the ciphertext to derive the shared secret.
 *
 * @param encryptedBase64 - Base64-encoded encrypted payload
 * @param verifierX25519PrivateKeyHex - Verifier's X25519 private key (hex). If omitted, uses session key.
 * @returns Decrypted plaintext string
 */
export function decryptPayload(
  encryptedBase64: string,
  verifierX25519PrivateKeyHex?: string,
): string {
  const privateKeyHex =
    verifierX25519PrivateKeyHex || getSessionX25519PrivateKey();
  if (!privateKeyHex) {
    throw new Error('X25519 session keys not initialized');
  }

  const data = base64ToBytes(encryptedBase64);
  const privateKeyBytes = hexToBytes(privateKeyHex);

  // Parse wire format
  const version = data[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const MIN_OVERHEAD = 1 + 32 + 12 + 16; // version + ephemeralPubKey + nonce + GCM tag
  if (data.length < MIN_OVERHEAD) {
    throw new Error(
      `Encrypted payload too short: ${data.length} bytes (minimum ${MIN_OVERHEAD})`,
    );
  }

  const ephemeralPublicKey = data.slice(1, 33);
  const nonce = data.slice(33, 33 + NONCE_LENGTH);
  const ciphertext = data.slice(33 + NONCE_LENGTH);

  // ECDH: compute shared secret
  const sharedSecret = x25519.getSharedSecret(
    privateKeyBytes,
    ephemeralPublicKey,
  );

  // Derive AES key via HKDF-SHA256
  const aesKey = hkdf(
    sha256,
    sharedSecret,
    undefined,
    'spellguard-amp-v1',
    KEY_LENGTH,
  );

  // Decrypt with AES-256-GCM
  const cipher = gcm(aesKey, nonce);
  const plaintext = cipher.decrypt(ciphertext);

  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt a payload from Verifier to a recipient.
 *
 * Generates an ephemeral X25519 key pair for each encryption.
 *
 * @param payload - Plaintext to encrypt
 * @param recipientX25519PublicKeyHex - Recipient's X25519 public key (hex)
 * @returns Base64-encoded encrypted payload
 */
export function encryptPayload(
  payload: string,
  recipientX25519PublicKeyHex: string,
): string {
  const payloadBytes = new TextEncoder().encode(payload);
  const recipientPublicKeyBytes = hexToBytes(recipientX25519PublicKeyHex);

  // Generate ephemeral X25519 key pair
  const ephemeralPrivateKey = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  // ECDH: compute shared secret
  const sharedSecret = x25519.getSharedSecret(
    ephemeralPrivateKey,
    recipientPublicKeyBytes,
  );

  // Derive AES key via HKDF-SHA256
  const aesKey = hkdf(
    sha256,
    sharedSecret,
    undefined,
    'spellguard-amp-v1',
    KEY_LENGTH,
  );

  // Generate random nonce
  const nonce = new Uint8Array(NONCE_LENGTH);
  crypto.getRandomValues(nonce);

  // Encrypt with AES-256-GCM
  const cipher = gcm(aesKey, nonce);
  const ciphertext = cipher.encrypt(payloadBytes);

  // Build wire format: version || ephemeralPublicKey || nonce || ciphertext+tag
  const result = new Uint8Array(1 + 32 + NONCE_LENGTH + ciphertext.length);
  result[0] = VERSION_BYTE;
  result.set(ephemeralPublicKey, 1);
  result.set(nonce, 33);
  result.set(ciphertext, 33 + NONCE_LENGTH);

  return bytesToBase64(result);
}

// Utility functions
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
