// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Signed envelopes
 *
 * The one Ed25519 envelope helper the Verifier signs with and every consumer
 * verifies with: delivery signatures to agents (#1244) and signed verdicts to
 * management (#1259). A signing string is a fixed, newline- or pipe-joined
 * list of fields; the signature is Ed25519 over its UTF-8 bytes, hex-encoded.
 *
 * The signer is injected, so the Verifier signs with its RAM-only session key
 * (`signWithSessionKey`) and tests sign with fixed vector keys.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/** Signs the given bytes and returns a hex Ed25519 signature. */
export type EnvelopeSigner = (data: Uint8Array) => Promise<string>;

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/** Lowercase hex sha256 of a string's UTF-8 bytes, or of raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256(bytes));
}

/**
 * A short, stable id for an Ed25519 public key: the first 16 hex characters
 * of sha256 over the raw 32 key bytes. Lets a receiver tell "a key I do not
 * know" from "a bad signature by the key I know".
 */
export function envelopeKeyId(publicKeyHex: string): string {
  return sha256Hex(hexToBytes(publicKeyHex.toLowerCase())).slice(0, 16);
}

/** Sign a signing string with the injected signer. */
export async function signEnvelope(
  signingString: string,
  sign: EnvelopeSigner,
): Promise<string> {
  return sign(new TextEncoder().encode(signingString));
}

/**
 * Verify a hex Ed25519 signature over a signing string. Malformed input is a
 * failed verification, never an exception.
 */
export async function verifyEnvelope(
  signingString: string,
  signatureHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  const signature = signatureHex.toLowerCase();
  const publicKey = publicKeyHex.toLowerCase();
  if (!HEX_128.test(signature) || !HEX_64.test(publicKey)) return false;
  try {
    return await ed.verifyAsync(
      hexToBytes(signature),
      new TextEncoder().encode(signingString),
      hexToBytes(publicKey),
    );
  } catch {
    return false;
  }
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
