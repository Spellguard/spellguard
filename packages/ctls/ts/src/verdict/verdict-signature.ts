// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Signed verdicts (#1259)
 *
 * Management trusts a Verifier's policy verdict (`/v1/mcp/evaluate`,
 * `/admin/evaluate`) only when the Verifier signed it with the session key
 * management attested. Each request carries a fresh nonce; the answer carries
 *
 *   X-Spellguard-Verdict-Signature: v1:<ts ms>:<hex Ed25519 signature>
 *
 * over `v1|<verifierId>|<nonce>|<ts>|<sha256(response body)>`. Built on the
 * same envelope helper as signed deliveries (#1244).
 */

import {
  type EnvelopeSigner,
  sha256Hex,
  signEnvelope,
  verifyEnvelope,
} from '../crypto/signed-envelope';

export const VERDICT_SIGNATURE_HEADER = 'X-Spellguard-Verdict-Signature';
export const VERDICT_NONCE_HEADER = 'X-Spellguard-Verdict-Nonce';
export const VERDICT_SIGNATURE_VERSION = 'v1';
/** A verdict signed further than this from the verifier's clock is refused. */
export const VERDICT_MAX_SKEW_MS = 60_000;

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export type VerdictFailure =
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'bad_signature';

/** A fresh 128-bit verdict nonce, lowercase hex. */
export function newVerdictNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Whether a request-supplied nonce has the shape a signer will bind. */
export function isVerdictNonce(value: string | null | undefined): boolean {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

export function verdictSigningString(input: {
  verifierId: string;
  nonce: string;
  timestamp: number;
  body: string | Uint8Array;
}): string {
  return [
    VERDICT_SIGNATURE_VERSION,
    input.verifierId,
    input.nonce,
    String(input.timestamp),
    sha256Hex(input.body),
  ].join('|');
}

/** The Verifier side: the `X-Spellguard-Verdict-Signature` header value. */
export async function signVerdict(input: {
  verifierId: string;
  nonce: string;
  body: string | Uint8Array;
  sign: EnvelopeSigner;
  now?: number;
}): Promise<string> {
  const timestamp = input.now ?? Date.now();
  const signature = await signEnvelope(
    verdictSigningString({
      verifierId: input.verifierId,
      nonce: input.nonce,
      timestamp,
      body: input.body,
    }),
    input.sign,
  );
  return `${VERDICT_SIGNATURE_VERSION}:${timestamp}:${signature}`;
}

/**
 * Management's side. `publicKeyHex` is the session key management attested
 * for this Verifier; `nonce` is the one it just sent.
 */
export async function verifyVerdict(input: {
  headerValue: string | null | undefined;
  verifierId: string;
  nonce: string;
  body: string | Uint8Array;
  publicKeyHex: string;
  now?: number;
  maxSkewMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: VerdictFailure }> {
  if (!input.headerValue) return { ok: false, reason: 'missing' };
  const parts = input.headerValue.split(':');
  if (
    parts.length !== 3 ||
    parts[0] !== VERDICT_SIGNATURE_VERSION ||
    !/^\d{1,16}$/.test(parts[1])
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const timestamp = Number(parts[1]);
  const now = input.now ?? Date.now();
  if (Math.abs(now - timestamp) > (input.maxSkewMs ?? VERDICT_MAX_SKEW_MS)) {
    return { ok: false, reason: 'stale' };
  }
  const valid = await verifyEnvelope(
    verdictSigningString({
      verifierId: input.verifierId,
      nonce: input.nonce,
      timestamp,
      body: input.body,
    }),
    parts[2],
    input.publicKeyHex,
  );
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
