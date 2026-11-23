// SPDX-License-Identifier: Apache-2.0

/**
 * The session ledger: what one agent received, sent and did inside one
 * correlation (one logical conversation), kept so a policy on a later leg can
 * judge it against the earlier ones.
 *
 * A session is keyed by agent AND correlation id (`sessionKey` in `./keys`).
 * It holds ordered PARTS (the content of each leg, as the Verifier saw it) and
 * named FACTS (values extracted from those parts). Only the Verifier writes
 * them; an agent never writes its own ledger.
 *
 * Design of record: internal design notes.
 */

/** The legs a part can come from. */
export const SESSION_LEGS = [
  'message:inbound',
  'message:outbound',
  'tool:input',
  'tool:output',
  'document',
] as const;
export type SessionLeg = (typeof SESSION_LEGS)[number];

/**
 * `hidden-layer`: the invisible text layer of a document's scanned pages
 * (internal design notes). Kept apart from the
 * document part, which holds what a person sees on the page, and never a
 * source: a value only the hidden layer states is the hidden-text attack.
 */
export const SESSION_PART_KINDS = [
  'text',
  'json',
  'document',
  'hidden-layer',
] as const;
export type SessionPartKind = (typeof SESSION_PART_KINDS)[number];

/**
 * Who produced a part. The sender for `message:inbound` and `document`
 * parts; the session's own agent for `message:outbound`, `tool:input` and
 * `tool:output`. The Verifier sets it from the authenticated leg, never from
 * the payload.
 */
export interface SessionPartFrom {
  agentId: string;
  orgId?: string;
}

/** How a hidden-layer part's label ends, after the document's file name. */
export const HIDDEN_LAYER_LABEL_SUFFIX = ': invisible text layer';

export function hiddenLayerLabel(documentName: string): string {
  return `${documentName}${HIDDEN_LAYER_LABEL_SUFFIX}`;
}

/** The legs whose parts another agent produced; the rest are the agent's own. */
export const COUNTERPARTY_LEGS: ReadonlySet<SessionLeg> = new Set([
  'message:inbound',
  'document',
]);

export interface SessionPart {
  /** Monotonic per session, from 1. */
  seq: number;
  /** When the store appended it (ms epoch). */
  at: number;
  leg: SessionLeg;
  kind: SessionPartKind;
  /** Tool name, or an attachment's file name. */
  label?: string;
  /** Who produced it. */
  from: SessionPartFrom;
  /** The content. Plaintext in memory only; encrypted wherever it is stored. */
  text: string;
  /** SHA-256 hex of `text` (after truncation). */
  digest: string;
  /** True when `text` was cut to the per-part cap, by the store or upstream. */
  truncated: boolean;
}

/** What a caller hands to `append`; the store assigns the rest. */
export interface SessionPartInput {
  leg: SessionLeg;
  kind: SessionPartKind;
  label?: string;
  from: SessionPartFrom;
  text: string;
  /** Set when the producer already cut the text (an extractor's own cap). */
  truncated?: boolean;
}

export const SESSION_FACT_KINDS = [
  'identifier',
  'number',
  'money',
  'text',
] as const;
export type SessionFactKind = (typeof SESSION_FACT_KINDS)[number];

export const SESSION_FACT_VIAS = [
  'jsonpath',
  'regex',
  'decision-model',
] as const;
export type SessionFactVia = (typeof SESSION_FACT_VIAS)[number];

export interface SessionFact {
  name: string;
  value: string | number;
  kind: SessionFactKind;
  /** The part the value was read from. Its leg decides the fact's strength. */
  sourceSeq: number;
  via: SessionFactVia;
  confidence?: number;
  at: number;
}

export type SessionFactInput = Omit<SessionFact, 'at'>;

/**
 * Per-session bounds. A full session refuses further parts rather than
 * dropping its oldest ones: the earliest parts are the document and the
 * request a later action is judged against, so a flood of later traffic must
 * not be able to push them out (design §3.4).
 */
export interface SessionLimits {
  maxParts: number;
  /** UTF-8 bytes of one part's text; longer text is cut and marked truncated. */
  maxPartTextBytes: number;
  /** UTF-8 bytes of all parts' text together. */
  maxSessionBytes: number;
  /** A session untouched for this long is deleted. */
  idleTtlMs: number;
}

export const SESSION_LIMITS: Readonly<SessionLimits> = Object.freeze({
  maxParts: 200,
  // A document part holds a whole document's text (up to
  // MAX_EXTRACTED_TEXT_BYTES), since nothing is read in part.
  maxPartTextBytes: 128 * 1024,
  maxSessionBytes: 2 * 1024 * 1024,
  idleTtlMs: 7 * 24 * 60 * 60 * 1000,
});

/**
 * Bounds on the page images a session keeps beside its document parts, for
 * the decision model to see (internal design notes
 * §6.7). An image is a second reader, not the reading: one the session
 * cannot keep leaves the document read as it was.
 */
export interface SessionImageLimits {
  /**
   * One image's bytes; a larger image is not kept. Under Durable Object
   * SQLite's 2 MB row, with room beside it for the image's OCR text.
   */
  maxImageBytes: number;
  /** Images kept per session. */
  maxImages: number;
  /** Bytes of all kept images together. */
  maxSessionImageBytes: number;
}

export const SESSION_IMAGE_LIMITS: Readonly<SessionImageLimits> = Object.freeze(
  {
    maxImageBytes: 1_900_000,
    maxImages: 32,
    maxSessionImageBytes: 24 * 1024 * 1024,
  },
);

/** Longest label kept on a part; a longer one is cut. */
export const MAX_PART_LABEL_CHARS = 256;

/** Longest fact name accepted. */
export const MAX_FACT_NAME_CHARS = 128;

/**
 * How much a fact read from a part on this leg is worth. A tool's own output
 * is what a system of record said; a document is what the counterparty sent
 * in writing; a message is what someone typed. The agent's own tool input is
 * the thing being judged, so it never outranks anything.
 */
export function sourceStrength(leg: SessionLeg | undefined): number {
  switch (leg) {
    case 'tool:output':
      return 3;
    case 'document':
      return 2;
    case 'message:inbound':
    case 'message:outbound':
      return 1;
    default:
      return 0;
  }
}

/**
 * The first assertion of a fact wins, unless a later one comes from a
 * strictly stronger source (`sourceStrength`). Equal strength keeps the first.
 */
export function shouldReplaceFact(
  existingSourceLeg: SessionLeg | undefined,
  incomingSourceLeg: SessionLeg | undefined,
): boolean {
  return sourceStrength(incomingSourceLeg) > sourceStrength(existingSourceLeg);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a code
 * point: a cut that lands inside a multi-byte sequence backs up to its start.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  // A UTF-8 continuation byte is 10xxxxxx; back up to the sequence's lead byte.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

/** SHA-256 of the UTF-8 text, lowercase hex. WebCrypto, so both runtimes. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Longest agent or org id kept in a part's `from`. */
export const MAX_FROM_ID_CHARS = 256;

/** Why a part cannot be appended, or null when it can. */
export function validatePartInput(part: SessionPartInput): string | null {
  if (!SESSION_LEGS.includes(part.leg)) return 'unknown part leg';
  if (!SESSION_PART_KINDS.includes(part.kind)) return 'unknown part kind';
  if (typeof part.text !== 'string') return 'part text must be a string';
  if (part.label !== undefined && typeof part.label !== 'string') {
    return 'part label must be a string';
  }
  const from = part.from as SessionPartFrom | undefined;
  if (
    typeof from !== 'object' ||
    from === null ||
    typeof from.agentId !== 'string' ||
    from.agentId.length === 0 ||
    from.agentId.length > MAX_FROM_ID_CHARS
  ) {
    return 'part from.agentId must be a non-empty string';
  }
  if (
    from.orgId !== undefined &&
    (typeof from.orgId !== 'string' ||
      from.orgId.length === 0 ||
      from.orgId.length > MAX_FROM_ID_CHARS)
  ) {
    return 'part from.orgId must be a non-empty string when present';
  }
  return null;
}

/** A copy of `from` with only the two known fields. */
export function normalizeFrom(from: SessionPartFrom): SessionPartFrom {
  return from.orgId !== undefined
    ? { agentId: from.agentId, orgId: from.orgId }
    : { agentId: from.agentId };
}

/** Why a fact cannot be stored, or null when it can. */
export function validateFactInput(fact: SessionFactInput): string | null {
  if (typeof fact.name !== 'string' || fact.name.length === 0) {
    return 'fact name must be a non-empty string';
  }
  if (fact.name.length > MAX_FACT_NAME_CHARS) {
    return `fact name is longer than ${MAX_FACT_NAME_CHARS} characters`;
  }
  if (
    typeof fact.value !== 'string' &&
    !(typeof fact.value === 'number' && Number.isFinite(fact.value))
  ) {
    return 'fact value must be a string or a finite number';
  }
  if (!SESSION_FACT_KINDS.includes(fact.kind)) return 'unknown fact kind';
  if (!SESSION_FACT_VIAS.includes(fact.via)) return 'unknown fact source';
  if (!Number.isInteger(fact.sourceSeq) || fact.sourceSeq < 0) {
    return 'fact sourceSeq must be a non-negative integer';
  }
  if (
    fact.confidence !== undefined &&
    !(fact.confidence >= 0 && fact.confidence <= 1)
  ) {
    return 'fact confidence must be between 0 and 1';
  }
  return null;
}
