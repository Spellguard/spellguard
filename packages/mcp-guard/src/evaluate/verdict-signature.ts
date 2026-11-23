// SPDX-License-Identifier: Apache-2.0
//
// Signed verdicts (#1915).
//
// The guard acts on a Verifier answer only when a Verifier that Spellguard
// attested signed it, for the nonce the guard just sent. Anything else that
// can answer at the guard's Verifier URL (a rogue endpoint, a compromised hop,
// a DNS or proxy mistake on this machine) can't sign, so it can't wave a call
// through with `{"result":"allow"}`.
//
// The wire format is the one in `@spellguard/ctls` (verdict-signature.ts),
// which the Verifier signs with and management verifies with:
//
//   X-Spellguard-Verdict-Signature: v1:<ts ms>:<hex Ed25519 signature>
//
// over `v1|<verifierId>|<nonce>|<ts>|<hex sha256 of the body>`. It is written
// again here on node:crypto because the guard is published on its own and
// ctls is not. Tests hold the two implementations to each other.
//
// Unlike management, the guard doesn't refuse a signature for its timestamp:
// the nonce is fresh for every request, which already rules out a replay, and
// the guard runs on machines whose clocks can be minutes off.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const VERDICT_SIGNATURE_HEADER = 'X-Spellguard-Verdict-Signature';
export const VERDICT_NONCE_HEADER = 'X-Spellguard-Verdict-Nonce';

/** A Verifier session key Spellguard attested, and the id it signs under. */
export interface VerifierKey {
  verifierId: string;
  /** Ed25519 public key, 64 hex characters. */
  publicKey: string;
}

/**
 * Why an answer's signature didn't check out.
 * - `no_keys`: Spellguard named no attested Verifier to check against.
 * - `missing`: the answer carries no signature.
 * - `malformed`: the signature header isn't `v1:<ts>:<128 hex>`.
 * - `bad_signature`: no known key signed this body for this nonce.
 */
export type VerdictSignatureFailure =
  | 'no_keys'
  | 'missing'
  | 'malformed'
  | 'bad_signature';

const PUBLIC_KEY = /^[0-9a-f]{64}$/i;
const SIGNATURE = /^[0-9a-f]{128}$/i;

/** A fresh 128-bit nonce, lowercase hex, the shape the Verifier signs for. */
export function newVerdictNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Whether a value is a usable key entry from Spellguard. */
export function isVerifierKey(value: unknown): value is VerifierKey {
  if (value === null || typeof value !== 'object') return false;
  const { verifierId, publicKey } = value as Record<string, unknown>;
  return (
    typeof verifierId === 'string' &&
    verifierId.length > 0 &&
    typeof publicKey === 'string' &&
    PUBLIC_KEY.test(publicKey)
  );
}

function ed25519Verify(
  publicKeyHex: string,
  message: string,
  signature: Buffer,
): boolean {
  try {
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(publicKeyHex, 'hex').toString('base64url'),
      },
      format: 'jwk',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

/**
 * Check a Verifier answer's signature against every key Spellguard named.
 * `body` is the exact response text the guard is about to parse.
 */
export function checkVerdictSignature(input: {
  headerValue: string | null;
  nonce: string;
  body: string;
  keys: readonly VerifierKey[];
}):
  | { ok: true; verifierId: string }
  | { ok: false; reason: VerdictSignatureFailure } {
  if (input.keys.length === 0) return { ok: false, reason: 'no_keys' };
  if (!input.headerValue) return { ok: false, reason: 'missing' };
  const parts = input.headerValue.split(':');
  if (
    parts.length !== 3 ||
    parts[0] !== 'v1' ||
    !/^\d{1,16}$/.test(parts[1]) ||
    !SIGNATURE.test(parts[2])
  ) {
    return { ok: false, reason: 'malformed' };
  }
  // The signer joins the timestamp as a number, so normalise it the same way.
  const timestamp = String(Number(parts[1]));
  const bodyHash = createHash('sha256')
    .update(input.body, 'utf8')
    .digest('hex');
  const signature = Buffer.from(parts[2], 'hex');
  for (const key of input.keys) {
    const message = [
      'v1',
      key.verifierId,
      input.nonce,
      timestamp,
      bodyHash,
    ].join('|');
    if (ed25519Verify(key.publicKey, message, signature)) {
      return { ok: true, verifierId: key.verifierId };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}
