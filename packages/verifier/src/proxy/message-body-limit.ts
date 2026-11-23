// SPDX-License-Identifier: Apache-2.0

/**
 * The largest request body `/messages/send` and `/messages/unilateral`
 * accept (#1578; internal design notes). The routes
 * refuse a larger body with 413 before reading it.
 *
 * The bound is a per-runtime setting on the app. The Cloudflare Verifier
 * handles every message in one Durable Object of 128 MB, so it derives the
 * bound from the attachment ceiling: one maximum-size attachment and the
 * envelopes around it fit, nothing larger reaches the object. The Node
 * Verifier (Fargate) gets a generous fixed bound instead, which closes the
 * unbounded read without changing what it accepts in practice.
 */

const MiB = 1024 * 1024;

/** The Node Verifier's bound. */
export const NODE_MAX_MESSAGE_BODY_BYTES = 32 * MiB;

/**
 * Room in the payload JSON around the attachment's base64: the prompt and
 * other fields, attachment names and media types, the trace stamps.
 */
const PAYLOAD_JSON_OVERHEAD = 64 * 1024;

/**
 * The payload encryption envelope (crypto/encrypt.ts): a version byte, the
 * 32-byte ephemeral key, the 12-byte nonce and the 16-byte GCM tag.
 */
const ENVELOPE_BYTES = 1 + 32 + 12 + 16;

/** Room in the request JSON around the envelope: sender and recipient. */
const BODY_JSON_OVERHEAD = 4 * 1024;

/** Headroom on top of the arithmetic. */
const HEADROOM = 1 * MiB;

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * The body bound for a runtime whose largest attachment is
 * `attachmentBytes`. The attachment is base64 inside the payload JSON; the
 * payload is encrypted, and the envelope is base64 again inside the request
 * JSON. It bounds a message's attachments together: four attachments share
 * it, so their sum, not each one, is at most about `attachmentBytes`. For
 * 4 MiB: 5,592,408 + 65,536 + 61 → 7,544,008 as base64, + 4,096 + 1 MiB =
 * 8,596,680 bytes (8.2 MiB).
 */
export function messageBodyLimitFor(attachmentBytes: number): number {
  const payload = base64Length(attachmentBytes) + PAYLOAD_JSON_OVERHEAD;
  const envelope = base64Length(payload + ENVELOPE_BYTES);
  return envelope + BODY_JSON_OVERHEAD + HEADROOM;
}

/** "8.2 MB", "4 MB": bytes in mebibytes, one decimal when it is not whole. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / MiB;
  const rounded = Math.round(mb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MB`;
}
