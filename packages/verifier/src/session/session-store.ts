// SPDX-License-Identifier: Apache-2.0

/**
 * The session store contract. Two implementations exist:
 *
 *   - `createMemorySessionStore` (`./memory-session-store`): in process
 *     memory, for local development and tests.
 *   - The Cloudflare Verifier's Durable Object store
 *     (closed source): one
 *     SQLite-backed Durable Object per session, every part and fact value
 *     encrypted at rest with a per-session key.
 *
 * A runtime that has neither passes no store, and the session policies then
 * report `session_unavailable` and act on their `failBehavior`.
 *
 * Design of record: internal design notes.
 */

import type {
  SessionFact,
  SessionFactInput,
  SessionLeg,
  SessionPart,
  SessionPartInput,
} from './types';

/** Which kept image: its document part, page and place on the page. */
export interface SessionImageRef {
  partSeq: number;
  /** The page it is on, from 1. */
  page: number;
  /** Its place among the page's images, from 0. */
  ordinal: number;
}

/** A kept page image without its bytes, and the text OCR read from it. */
export interface SessionImageMeta extends SessionImageRef {
  mediaType: string;
  /** Its size in bytes. */
  bytes: number;
  /** The OCR text of this image. Plaintext in memory only. */
  text: string;
}

/** A page image to keep beside a document part. */
export interface SessionImageInput extends SessionImageRef {
  mediaType: string;
  data: Uint8Array;
  text: string;
}

/** Why a session did not keep an image. */
export type SessionImageRefusal =
  | 'too_large'
  | 'session_images_full'
  | 'session_image_bytes_full'
  | 'no_document_part'
  | 'unavailable';

export interface SessionPartsFilter {
  /** Only parts from these legs. Omitted: every leg. */
  legs?: SessionLeg[];
  /** At most this many: the most recent ones that match. */
  limit?: number;
}

/** One open session. Cheap to create; holds no lock. */
export interface SessionHandle {
  readonly key: string;
  /**
   * Append a part. The store truncates `text` to the per-part cap, stamps
   * `seq`, `at` and `digest`, and returns the stored part. Throws
   * `SessionCapacityError` when the session is full.
   */
  append(part: SessionPartInput): Promise<SessionPart>;
  /**
   * Parts in ascending `seq` order. Throws `SessionUnreadableError` when a
   * stored part cannot be decrypted (the store key changed).
   */
  parts(filter?: SessionPartsFilter): Promise<SessionPart[]>;
  /** Facts, sorted by name. Throws `SessionUnreadableError` like `parts`. */
  facts(): Promise<SessionFact[]>;
  /**
   * Record a fact. The first assertion of a name wins unless a later one
   * comes from a stronger source leg (`shouldReplaceFact` in `./types`).
   */
  setFact(fact: SessionFactInput): Promise<void>;
  /** Restart the idle TTL. Every append and setFact touches too. */
  touch(): Promise<void>;
  /**
   * The page images kept beside the session's document parts, without their
   * bytes, in part, page and place order. Absent on a store that keeps none.
   */
  images?(): Promise<SessionImageMeta[]>;
  /**
   * Keep a page image beside its document part, under SESSION_IMAGE_LIMITS.
   * On the Cloudflare Verifier the DocumentReader object writes images
   * itself, sealed, so the Verifier's own object never holds them; this
   * method is the in-memory store's.
   */
  keepImage?(
    input: SessionImageInput,
  ): Promise<{ kept: true } | { kept: false; reason: SessionImageRefusal }>;
}

export interface SessionStore {
  /**
   * Open a session, creating it on first use. Never reads: a session that
   * does not exist yet costs nothing until something is appended.
   *
   * Deferred (design §10): `restoreFromArchive(key)`, which would rebuild an
   * expired session from the encrypted message archive. The archive holds
   * whole messages under the management archive key, so a restore needs a
   * management round trip; nothing calls it in this version.
   */
  open(key: string): Promise<SessionHandle>;
}

/** The session already holds its maximum parts or bytes. */
export class SessionCapacityError extends Error {
  constructor(readonly limit: 'parts' | 'bytes') {
    super(
      limit === 'parts'
        ? 'session is full: part limit reached'
        : 'session is full: byte limit reached',
    );
    this.name = 'SessionCapacityError';
  }
}

/** A stored part or fact could not be decrypted with the current store key. */
export class SessionUnreadableError extends Error {
  constructor(message = 'session content could not be decrypted') {
    super(message);
    this.name = 'SessionUnreadableError';
  }
}

/** A caller passed a part or fact the store refuses (bad leg, kind, value). */
export class SessionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInputError';
  }
}
