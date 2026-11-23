// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Signed deliveries (#1244)
 *
 * An agent's `/_spellguard/receive` must accept only deliveries its own
 * Verifier sent. The Verifier signs every delivery with the Ed25519 session
 * key the agent pinned at registration (after attesting it, #1259). The signed
 * string binds:
 *
 *   spellguard-delivery-v1
 *   <recipient agent id>          a delivery for one agent can't go to another
 *   <sha256(channel token)>       the header token can't be swapped
 *   <timestamp ms>                ±5 minutes
 *   <nonce, 128-bit hex>          replay cache
 *   <sha256(raw body)>            senderId, messageId and ciphertext
 *
 * joined with '\n'. Test vectors shared with the Python SDK:
 * `tests/fixtures/delivery-auth/delivery-auth-v1.json`.
 */

import {
  type EnvelopeSigner,
  envelopeKeyId,
  sha256Hex,
  signEnvelope,
  verifyEnvelope,
} from '../crypto/signed-envelope';

export const DELIVERY_AUTH_VERSION = 'v1';
export const DELIVERY_AUTH_SCHEME = 'spellguard-delivery-v1';

/** Header names, exactly as the Verifier sends them. */
export const DELIVERY_AUTH_HEADERS = {
  version: 'X-Spellguard-Delivery-Auth',
  keyId: 'X-Spellguard-Delivery-Key',
  timestamp: 'X-Spellguard-Delivery-Timestamp',
  nonce: 'X-Spellguard-Delivery-Nonce',
  signature: 'X-Spellguard-Delivery-Signature',
} as const;

/** A delivery's timestamp must be within this of the receiver's clock. */
export const DELIVERY_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

export type DeliveryAuthFailure =
  | 'missing'
  | 'unsupported_version'
  | 'unknown_key'
  | 'stale'
  | 'bad_signature'
  | 'replayed';

export type DeliveryVerdict =
  | { ok: true; keyId: string }
  | { ok: false; reason: DeliveryAuthFailure };

/**
 * Records nonces a receiver has accepted. `checkAndRecord` returns true the
 * first time it sees `key` and false for a replay; `now` is the clock the
 * delivery was judged by, and an entry may be forgotten once `now` passes its
 * `expiresAt` (its delivery can no longer pass the timestamp window). The
 * default is an in-process LRU; a deployment that runs several receivers
 * (Workers isolates, replicas) passes a shared store (a Durable Object, KV,
 * Redis).
 */
export interface DeliveryNonceStore {
  checkAndRecord(
    key: string,
    expiresAt: number,
    now: number,
  ): boolean | Promise<boolean>;
}

/**
 * Bounded in-process nonce cache. Entries expire once their delivery could no
 * longer pass the timestamp window, so the bound only matters under a flood
 * of valid, signed deliveries.
 */
export class DeliveryNonceCache implements DeliveryNonceStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {}

  checkAndRecord(key: string, expiresAt: number, now: number): boolean {
    for (const [k, exp] of this.entries) {
      if (exp > now) break;
      this.entries.delete(k);
    }
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > now) return false;
    this.entries.delete(key);
    this.entries.set(key, expiresAt);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }
}

/** The key id a delivery names: sha256(raw public key) truncated to 16 hex. */
export function deliveryKeyId(publicKeyHex: string): string {
  return envelopeKeyId(publicKeyHex);
}

export function deliverySigningString(input: {
  recipientAgentId: string;
  channelToken: string;
  timestamp: number;
  nonce: string;
  body: string | Uint8Array;
}): string {
  return [
    DELIVERY_AUTH_SCHEME,
    input.recipientAgentId,
    sha256Hex(input.channelToken),
    String(input.timestamp),
    input.nonce,
    sha256Hex(input.body),
  ].join('\n');
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The Verifier side: the headers that authenticate one delivery. */
export async function signDelivery(input: {
  recipientAgentId: string;
  channelToken: string;
  body: string | Uint8Array;
  publicKeyHex: string;
  sign: EnvelopeSigner;
  now?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  const timestamp = input.now ?? Date.now();
  const nonce = input.nonce ?? randomNonce();
  const signature = await signEnvelope(
    deliverySigningString({
      recipientAgentId: input.recipientAgentId,
      channelToken: input.channelToken,
      timestamp,
      nonce,
      body: input.body,
    }),
    input.sign,
  );
  return {
    [DELIVERY_AUTH_HEADERS.version]: DELIVERY_AUTH_VERSION,
    [DELIVERY_AUTH_HEADERS.keyId]: deliveryKeyId(input.publicKeyHex),
    [DELIVERY_AUTH_HEADERS.timestamp]: String(timestamp),
    [DELIVERY_AUTH_HEADERS.nonce]: nonce,
    [DELIVERY_AUTH_HEADERS.signature]: signature,
  };
}

/**
 * The agent side. `publicKeyHex` is the session key the agent pinned from its
 * own attested registration, never a key the delivery supplies. A nonce is
 * recorded only after the signature verified, so a forgery cannot burn it.
 */
export async function verifyDelivery(input: {
  header: (name: string) => string | null | undefined;
  recipientAgentId: string;
  channelToken: string;
  body: string | Uint8Array;
  publicKeyHex: string;
  nonces: DeliveryNonceStore;
  now?: number;
  maxSkewMs?: number;
}): Promise<DeliveryVerdict> {
  const read = (name: string) => {
    const value = input.header(name);
    return value === null || value === undefined || value === '' ? null : value;
  };
  const version = read(DELIVERY_AUTH_HEADERS.version);
  if (version === null) return { ok: false, reason: 'missing' };
  if (version !== DELIVERY_AUTH_VERSION) {
    return { ok: false, reason: 'unsupported_version' };
  }
  const keyId = read(DELIVERY_AUTH_HEADERS.keyId);
  const timestampRaw = read(DELIVERY_AUTH_HEADERS.timestamp);
  const nonce = read(DELIVERY_AUTH_HEADERS.nonce);
  const signature = read(DELIVERY_AUTH_HEADERS.signature);
  if (!keyId || !timestampRaw || !nonce || !signature) {
    return { ok: false, reason: 'missing' };
  }

  const expectedKeyId = deliveryKeyId(input.publicKeyHex);
  if (keyId.toLowerCase() !== expectedKeyId) {
    return { ok: false, reason: 'unknown_key' };
  }

  const maxSkew = input.maxSkewMs ?? DELIVERY_AUTH_MAX_SKEW_MS;
  const now = input.now ?? Date.now();
  const timestamp = /^\d{1,16}$/.test(timestampRaw)
    ? Number(timestampRaw)
    : Number.NaN;
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > maxSkew) {
    return { ok: false, reason: 'stale' };
  }

  if (!/^[0-9a-f]{32}$/i.test(nonce)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const valid = await verifyEnvelope(
    deliverySigningString({
      recipientAgentId: input.recipientAgentId,
      channelToken: input.channelToken,
      timestamp,
      nonce,
      body: input.body,
    }),
    signature,
    input.publicKeyHex,
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const fresh = await input.nonces.checkAndRecord(
    `${expectedKeyId}:${nonce.toLowerCase()}`,
    timestamp + maxSkew,
    now,
  );
  if (!fresh) return { ok: false, reason: 'replayed' };
  return { ok: true, keyId: expectedKeyId };
}
