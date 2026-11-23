// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Signed Verifier → management requests (#1344)
 *
 * Every request a Verifier makes to management carries
 *
 *   X-Spellguard-Verifier-Signature: v1:<ts ms>:<hex Ed25519 signature>
 *
 * over `v1|<verifierId>|<METHOD>|<pathname+search>|<ts>|<sha256(body)>`,
 * signed with the session key the Verifier registered and management attests
 * (#1259). Binding the method and path means a signature authorises exactly
 * one request: an empty-body GET's signature is not valid for any other
 * empty-body route. Built on the same envelope helper as signed deliveries
 * (#1244) and verdicts (#1259).
 *
 * A signature stays valid for the skew window, so on routes that record
 * something per call management accepts each signed message once (#1369): it
 * claims the message's `requestDigest`. A Verifier therefore never signs two
 * requests with the same timestamp (`nextRequestTimestamp`), so two genuine
 * requests with the same method, path and body never share a digest.
 */

import {
  type EnvelopeSigner,
  sha256Hex,
  signEnvelope,
  verifyEnvelope,
} from '../crypto/signed-envelope';

export const VERIFIER_REQUEST_SIGNATURE_HEADER =
  'X-Spellguard-Verifier-Signature';
export const VERIFIER_REQUEST_SIGNATURE_VERSION = 'v1';
/** A request signed further than this from management's clock is refused. */
export const VERIFIER_REQUEST_MAX_SKEW_MS = 60_000;

export type VerifierRequestFailure =
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'bad_signature';

export function verifierRequestSigningString(input: {
  verifierId: string;
  method: string;
  path: string;
  timestamp: number;
  body: string | Uint8Array;
}): string {
  return [
    VERIFIER_REQUEST_SIGNATURE_VERSION,
    input.verifierId,
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    sha256Hex(input.body),
  ].join('|');
}

let lastRequestTimestamp = 0;

/**
 * A millisecond timestamp strictly greater than every one this process has
 * signed before (#1369), and never behind the clock.
 */
function nextRequestTimestamp(): number {
  lastRequestTimestamp = Math.max(Date.now(), lastRequestTimestamp + 1);
  return lastRequestTimestamp;
}

/** The Verifier side: the `X-Spellguard-Verifier-Signature` header value. */
export async function signVerifierRequest(input: {
  verifierId: string;
  method: string;
  /** The request URL's pathname plus its search string. */
  path: string;
  body: string | Uint8Array;
  sign: EnvelopeSigner;
  now?: number;
}): Promise<string> {
  const timestamp = input.now ?? nextRequestTimestamp();
  const signature = await signEnvelope(
    verifierRequestSigningString({ ...input, timestamp }),
    input.sign,
  );
  return `${VERIFIER_REQUEST_SIGNATURE_VERSION}:${timestamp}:${signature}`;
}

/** A verified request: when it was signed, and the digest that identifies it. */
export interface VerifiedVerifierRequest {
  ok: true;
  timestamp: number;
  /**
   * sha256 hex of the signing string. The same value for a replay of this
   * request, and for any re-encoding of its signature; different for every
   * other request (#1369).
   */
  requestDigest: string;
}

/**
 * Management's side. `publicKeyHex` is the key the Verifier registered;
 * `method`, `path` and `body` are the request as management received it.
 */
export async function verifyVerifierRequest(input: {
  headerValue: string | null | undefined;
  verifierId: string;
  method: string;
  path: string;
  body: string | Uint8Array;
  publicKeyHex: string;
  now?: number;
  maxSkewMs?: number;
}): Promise<
  VerifiedVerifierRequest | { ok: false; reason: VerifierRequestFailure }
> {
  if (!input.headerValue) return { ok: false, reason: 'missing' };
  const parts = input.headerValue.split(':');
  if (
    parts.length !== 3 ||
    parts[0] !== VERIFIER_REQUEST_SIGNATURE_VERSION ||
    !/^\d{1,16}$/.test(parts[1])
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const timestamp = Number(parts[1]);
  const now = input.now ?? Date.now();
  if (
    Math.abs(now - timestamp) >
    (input.maxSkewMs ?? VERIFIER_REQUEST_MAX_SKEW_MS)
  ) {
    return { ok: false, reason: 'stale' };
  }
  const signingString = verifierRequestSigningString({ ...input, timestamp });
  const valid = await verifyEnvelope(
    signingString,
    parts[2],
    input.publicKeyHex,
  );
  return valid
    ? { ok: true, timestamp, requestDigest: sha256Hex(signingString) }
    : { ok: false, reason: 'bad_signature' };
}
