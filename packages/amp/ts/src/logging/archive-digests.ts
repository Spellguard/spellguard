// SPDX-License-Identifier: Apache-2.0
/**
 * The SHA-256 of each archived message object, by message id, for the
 * Verifier's signed audit records (internal design notes,
 * slice 3): a record's signature covers the hash of the exact bytes archived
 * for its message, so a replay can show whether the archive still matches.
 *
 * The hash is recorded when the object's bytes are built, before the upload
 * starts, so it is known by the time the record is reported even when the
 * caller does not wait for the upload. A failed upload removes it. Several
 * records share one message (both perspectives, obligation rows), so an entry
 * is kept until it ages out of a bounded window rather than read once.
 */

import { sha256 } from '@noble/hashes/sha256';

const MAX_ENTRIES = 10_000;
const digests = new Map<string, string>();

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Records the SHA-256 of the object archived for `messageId`. */
export function recordArchiveDigest(messageId: string, body: string): string {
  const digest = toHex(sha256(new TextEncoder().encode(body)));
  digests.delete(messageId);
  digests.set(messageId, digest);
  if (digests.size > MAX_ENTRIES) {
    const oldest = digests.keys().next().value;
    if (oldest !== undefined) digests.delete(oldest);
  }
  return digest;
}

/** Forgets a digest whose upload failed: no object holds those bytes. */
export function forgetArchiveDigest(messageId: string): void {
  digests.delete(messageId);
}

/** The SHA-256 of the object archived for `messageId`, if one was written. */
export function archiveDigestFor(messageId: string): string | null {
  return digests.get(messageId) ?? null;
}

/** Testing: forget every digest. */
export function clearArchiveDigests(): void {
  digests.clear();
}
