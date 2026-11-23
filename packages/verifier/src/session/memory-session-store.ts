// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory session store, for local development (`dev:verifier`) and tests.
 *
 * Same contract as the Cloudflare Durable Object store: the same caps, the
 * same first-assertion rule, the same idle TTL (checked when a session is
 * opened). It is not encrypted, because nothing here is at rest, and it is
 * lost when the process exits. The number of sessions held is bounded; the
 * least recently opened one is dropped first.
 */

import {
  SessionCapacityError,
  type SessionHandle,
  type SessionImageInput,
  type SessionImageMeta,
  type SessionImageRefusal,
  SessionInputError,
  type SessionPartsFilter,
  type SessionStore,
} from './session-store';
import {
  MAX_PART_LABEL_CHARS,
  SESSION_IMAGE_LIMITS,
  SESSION_LIMITS,
  type SessionFact,
  type SessionFactInput,
  type SessionLimits,
  type SessionPart,
  type SessionPartInput,
  normalizeFrom,
  sha256Hex,
  shouldReplaceFact,
  truncateUtf8,
  utf8ByteLength,
  validateFactInput,
  validatePartInput,
} from './types';

export interface MemorySessionStoreOptions {
  /** Clock, for tests. */
  now?: () => number;
  /** Most sessions held at once. Default 1000. */
  maxSessions?: number;
  limits?: Partial<SessionLimits>;
}

interface MemorySession {
  parts: SessionPart[];
  facts: Map<string, SessionFact>;
  images: Array<SessionImageMeta & { data: Uint8Array }>;
  bytes: number;
  nextSeq: number;
  touchedAt: number;
}

export function createMemorySessionStore(
  options: MemorySessionStoreOptions = {},
): SessionStore {
  const now = options.now ?? Date.now;
  const maxSessions = options.maxSessions ?? 1000;
  const limits: SessionLimits = { ...SESSION_LIMITS, ...options.limits };
  const sessions = new Map<string, MemorySession>();

  function fresh(): MemorySession {
    return {
      parts: [],
      facts: new Map(),
      images: [],
      bytes: 0,
      nextSeq: 1,
      touchedAt: now(),
    };
  }

  function load(key: string): MemorySession {
    let session = sessions.get(key);
    if (session && now() - session.touchedAt >= limits.idleTtlMs) {
      session = undefined;
    }
    if (!session) session = fresh();
    // Re-insert so Map order is least-recently-opened first.
    sessions.delete(key);
    sessions.set(key, session);
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return session;
  }

  return {
    async open(key: string): Promise<SessionHandle> {
      const session = load(key);
      return new MemorySessionHandle(key, session, limits, now);
    },
  };
}

class MemorySessionHandle implements SessionHandle {
  constructor(
    readonly key: string,
    private readonly session: MemorySession,
    private readonly limits: SessionLimits,
    private readonly now: () => number,
  ) {}

  async append(input: SessionPartInput): Promise<SessionPart> {
    const problem = validatePartInput(input);
    if (problem) throw new SessionInputError(problem);
    const { text, truncated } = truncateUtf8(
      input.text,
      this.limits.maxPartTextBytes,
    );
    const bytes = utf8ByteLength(text);
    if (this.session.parts.length >= this.limits.maxParts) {
      throw new SessionCapacityError('parts');
    }
    if (this.session.bytes + bytes > this.limits.maxSessionBytes) {
      throw new SessionCapacityError('bytes');
    }
    const at = this.now();
    const part: SessionPart = {
      seq: this.session.nextSeq++,
      at,
      leg: input.leg,
      kind: input.kind,
      ...(input.label !== undefined
        ? { label: input.label.slice(0, MAX_PART_LABEL_CHARS) }
        : {}),
      from: normalizeFrom(input.from),
      text,
      digest: await sha256Hex(text),
      truncated: truncated || input.truncated === true,
    };
    this.session.parts.push(part);
    this.session.bytes += bytes;
    this.session.touchedAt = at;
    return copyPart(part);
  }

  async parts(filter: SessionPartsFilter = {}): Promise<SessionPart[]> {
    let parts = this.session.parts;
    if (filter.legs) {
      const legs = new Set(filter.legs);
      parts = parts.filter((p) => legs.has(p.leg));
    }
    if (filter.limit !== undefined) {
      parts = filter.limit > 0 ? parts.slice(-filter.limit) : [];
    }
    return parts.map(copyPart);
  }

  async facts(): Promise<SessionFact[]> {
    return [...this.session.facts.values()]
      .map((f) => ({ ...f }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async setFact(input: SessionFactInput): Promise<void> {
    const problem = validateFactInput(input);
    if (problem) throw new SessionInputError(problem);
    const existing = this.session.facts.get(input.name);
    const legOf = (seq: number) =>
      this.session.parts.find((p) => p.seq === seq)?.leg;
    const at = this.now();
    if (
      !existing ||
      shouldReplaceFact(legOf(existing.sourceSeq), legOf(input.sourceSeq))
    ) {
      this.session.facts.set(input.name, { ...input, at });
    }
    this.session.touchedAt = at;
  }

  async touch(): Promise<void> {
    this.session.touchedAt = this.now();
  }

  async images(): Promise<SessionImageMeta[]> {
    return this.session.images.map(({ data: _data, ...meta }) => ({
      ...meta,
    }));
  }

  /** The kept images' bytes, for tests. */
  async imageData(ref: {
    partSeq: number;
    page: number;
    ordinal: number;
  }): Promise<Uint8Array | undefined> {
    return this.session.images.find(
      (i) =>
        i.partSeq === ref.partSeq &&
        i.page === ref.page &&
        i.ordinal === ref.ordinal,
    )?.data;
  }

  async keepImage(
    input: SessionImageInput,
  ): Promise<{ kept: true } | { kept: false; reason: SessionImageRefusal }> {
    const images = this.session.images;
    const part = this.session.parts.find((p) => p.seq === input.partSeq);
    if (!part || part.kind !== 'document') {
      return { kept: false, reason: 'no_document_part' };
    }
    const bytes = input.data.byteLength;
    if (bytes > SESSION_IMAGE_LIMITS.maxImageBytes) {
      return { kept: false, reason: 'too_large' };
    }
    if (images.length >= SESSION_IMAGE_LIMITS.maxImages) {
      return { kept: false, reason: 'session_images_full' };
    }
    const held = images.reduce((n, i) => n + i.bytes, 0);
    if (held + bytes > SESSION_IMAGE_LIMITS.maxSessionImageBytes) {
      return { kept: false, reason: 'session_image_bytes_full' };
    }
    images.push({
      partSeq: input.partSeq,
      page: input.page,
      ordinal: input.ordinal,
      mediaType: input.mediaType,
      bytes,
      text: input.text,
      data: input.data.slice(),
    });
    images.sort(
      (a, b) =>
        a.partSeq - b.partSeq || a.page - b.page || a.ordinal - b.ordinal,
    );
    this.session.touchedAt = this.now();
    return { kept: true };
  }
}

function copyPart(part: SessionPart): SessionPart {
  return { ...part, from: { ...part.from } };
}
