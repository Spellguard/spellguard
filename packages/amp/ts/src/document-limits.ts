// SPDX-License-Identifier: Apache-2.0

/**
 * Limits on the documents an agent receives as message attachments
 * (internal design notes). Shared by management (the
 * organization setting and its validation) and the Verifier (the ingest
 * gate).
 *
 * There is no partial reading: the agent's model reads every page of a
 * document, so the Verifier reads every page or blocks the document on the
 * recipient's inbound leg. An organization may lower its limits, or raise
 * them up to the platform ceiling.
 */

export interface DocumentLimits {
  /** Largest decoded attachment, in bytes. */
  maxBytes: number;
  /** Most pages in one document. A standalone image is one page. */
  maxPages: number;
}

const MiB = 1024 * 1024;

/** What an organization gets when it sets nothing. */
export const DOCUMENT_LIMIT_DEFAULTS: Readonly<DocumentLimits> = Object.freeze({
  maxBytes: 4 * MiB,
  maxPages: 20,
});

/**
 * The most an organization can set. The byte ceiling is set by the
 * Cloudflare Verifier: every message passes through one Durable Object
 * (128 MB), which holds the message body several times over while it
 * decrypts, archives and re-encrypts it. Measured 2026-10-29, attachments up
 * to 7.3 MiB completed cleanly, 8 to 10 MiB tripped the memory limit after
 * the request, and 14.6 MiB reset the object; 4 MiB is half the failure
 * point. Moving attachments out of that object (phase 2) raises it. The page
 * ceiling is about what the decision model can judge in one call.
 */
export const DOCUMENT_LIMIT_CEILING: Readonly<DocumentLimits> = Object.freeze({
  maxBytes: 4 * MiB,
  maxPages: 30,
});

/** The least an organization can set. */
export const DOCUMENT_LIMIT_FLOOR: Readonly<DocumentLimits> = Object.freeze({
  maxBytes: 1 * MiB,
  maxPages: 1,
});

/**
 * Attachments read per message. A message with more is blocked: the agent
 * would receive attachments the Verifier never read.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/**
 * Images one document may need read by OCR: two per allowed page, so a page
 * with a picture and a pasted table still fits and a document of tiny
 * images cannot buy unbounded reading.
 */
export function ocrUnitsAllowed(maxPages: number): number {
  return 2 * maxPages;
}

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, Math.floor(value)));
}

function usable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The limits that apply: the organization's setting where it has one, the
 * defaults otherwise, each clamped to the floor and the ceiling. `null`
 * means "use the default", as it does in the organization's columns.
 */
export function effectiveDocumentLimits(
  setting?: {
    maxBytes?: number | null;
    maxPages?: number | null;
  } | null,
): DocumentLimits {
  const bytes = setting?.maxBytes;
  const pages = setting?.maxPages;
  const maxBytes = usable(bytes) ? bytes : DOCUMENT_LIMIT_DEFAULTS.maxBytes;
  const maxPages = usable(pages) ? pages : DOCUMENT_LIMIT_DEFAULTS.maxPages;
  return {
    maxBytes: clamp(
      maxBytes,
      DOCUMENT_LIMIT_FLOOR.maxBytes,
      DOCUMENT_LIMIT_CEILING.maxBytes,
    ),
    maxPages: clamp(
      maxPages,
      DOCUMENT_LIMIT_FLOOR.maxPages,
      DOCUMENT_LIMIT_CEILING.maxPages,
    ),
  };
}
