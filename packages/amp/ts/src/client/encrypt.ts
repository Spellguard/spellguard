// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Message Encryption
 *
 * ECDH + AES-256-GCM encryption for Verifier communication.
 *
 * Wire format (version 0x01):
 *   0x01 || ephemeralPublicKey (32 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
 * Base64-encoded for transport.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

const VERSION_BYTE = 0x01;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;

/**
 * Encrypt a payload for the Verifier using ephemeral ECDH + AES-256-GCM.
 *
 * For each encryption:
 * 1. Generate fresh X25519 ephemeral key pair
 * 2. Compute shared secret via ECDH(ephemeralPrivate, verifierX25519Public)
 * 3. Derive AES key via HKDF-SHA256
 * 4. Encrypt with AES-256-GCM (random 96-bit nonce)
 *
 * @param payload - Plaintext payload to encrypt
 * @param verifierX25519PublicKey - Verifier's X25519 public key (hex-encoded)
 * @returns Base64-encoded encrypted payload
 */
export function encryptForVerifier(
  payload: string,
  verifierX25519PublicKey: string,
): string {
  const payloadBytes = new TextEncoder().encode(payload);
  const verifierPublicKeyBytes = hexToBytes(verifierX25519PublicKey);

  // Generate ephemeral X25519 key pair for this encryption
  const ephemeralPrivateKey = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  // ECDH: compute shared secret
  const sharedSecret = x25519.getSharedSecret(
    ephemeralPrivateKey,
    verifierPublicKeyBytes,
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

/**
 * Decrypt a payload from the Verifier.
 *
 * @param encryptedPayload - Base64-encoded encrypted payload
 * @param x25519PrivateKey - Recipient's X25519 private key (hex-encoded)
 * @returns Decrypted plaintext payload
 */
export function decryptFromVerifier(
  encryptedPayload: string,
  x25519PrivateKey: string,
): string {
  const data = base64ToBytes(encryptedPayload);
  const privateKeyBytes = hexToBytes(x25519PrivateKey);

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
 * Hash a payload for commitment verification.
 *
 * @param payload - Payload to hash
 * @returns Hex-encoded SHA256 hash
 */
/**
 * Generate a fresh X25519 key pair for an agent client. The agent keeps the
 * private key and registers the public key with the Verifier, so the Verifier
 * can encrypt delivered payloads + responses TO this agent (gateway-opaque,
 * app-layer end-to-end to the agent). Keys are per-process/ephemeral — the
 * agent re-registers (rotating the key) on restart.
 */
export function generateAgentKeyPair(): {
  publicKeyHex: string;
  privateKeyHex: string;
} {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    publicKeyHex: bytesToHex(publicKey),
    privateKeyHex: bytesToHex(privateKey),
  };
}

/**
 * Derive a STABLE X25519 keypair for an agent from a secret seed (its
 * agent-secret or signing key). DETERMINISTIC — every process/instance of the
 * same agent derives the SAME keypair, so the public key the agent registers
 * always matches the private key it decrypts with, even across restarts and
 * multiple instances. (A random per-process key does NOT match across
 * processes, which silently breaks gateway-opaque delivery — the bug this
 * replaces.) HKDF domain-separates this from the seed's other uses (signing).
 */
export function deriveAgentKeyPair(seed: string): {
  publicKeyHex: string;
  privateKeyHex: string;
} {
  const privateKey = hkdf(
    sha256,
    new TextEncoder().encode(seed),
    undefined,
    'spellguard-agent-x25519-v1',
    KEY_LENGTH,
  );
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    publicKeyHex: bytesToHex(publicKey),
    privateKeyHex: bytesToHex(privateKey),
  };
}

export function hashPayload(payload: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(payload)));
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

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
