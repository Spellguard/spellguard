// SPDX-License-Identifier: Apache-2.0

/**
 * Reading the documents an agent receives as message attachments.
 *
 * Two seams, one per runtime shape:
 *
 * - `DocumentReader` is what the ingest gate uses (router step 3a-iii,
 *   `session/document-gate.ts`). The Cloudflare Verifier implements it with
 *   one `DocumentReader` Durable Object per document, so parsing and OCR
 *   never land on the Verifier's own object. It reads the structure first,
 *   with no spend, so limits block before anything is read; then it reads
 *   every page: the text layer, and the page images and embedded images by
 *   OCR when a reader applies.
 * - `DocumentExtractor` is the text-layer converter (Workers AI
 *   `toMarkdown` on Cloudflare). The reader uses it for born-digital text;
 *   a runtime with no `DocumentReader` keeps the legacy attachment path
 *   (`readAttachments`), which takes an extractor directly. The Node Verifier
 *   passes neither, so every attachment there is recorded `no_extractor`.
 *
 * Design of record: internal design notes.
 */

import type { DocumentLimits } from '@spellguard/amp';
import type { DocumentReaderId } from '@spellguard/amp';

// The document-reader registry is the shared policy registry's
// (`@spellguard/amp` policy-types.ts `DOCUMENT_READERS`), like the decision
// models: one list for the Verifier, the policy creation schema and the
// dashboard.
export {
  DEFAULT_DOCUMENT_READER_ID,
  DOCUMENT_READER_IDS,
  DOCUMENT_READERS,
  getDocumentReader,
} from '@spellguard/amp';
export type {
  DocumentReader as DocumentReaderEntry,
  DocumentReaderId,
  DocumentReaderProvider,
} from '@spellguard/amp';

export interface DocumentInput {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export type DocumentExtraction =
  | { text: string; truncated: boolean }
  | { unreadable: UnreadableReason };

/** Why an attachment yielded no text. Recorded on the audit event. */
export type UnreadableReason =
  /** The Verifier does not read this media type. */
  | 'unsupported_media_type'
  /** The runtime has no extractor. */
  | 'no_extractor'
  /** `data` was not valid base64, or the bytes are not the declared type. */
  | 'invalid_encoding'
  /** Over the per-attachment size bound; nothing was read (legacy path). */
  | 'too_large'
  /** The extractor ran and failed (service error, timeout, corrupt file). */
  | 'extraction_failed'
  /** The document has no text and nothing to read by OCR (a blank page). */
  | 'no_text'
  /**
   * An image in the document is stored in an encoding the Verifier cannot
   * turn into a picture without decoding it: JPEG 2000, JBIG2, CCITT fax,
   * CMYK or LZW pixels, or several filters. The whole document is
   * unreadable; it is never read in part.
   */
  | 'unsupported_image_encoding'
  /**
   * The PDF draws its pages in a way the reader does not follow: images
   * nested deeper than three Form XObjects, an inline image large enough to
   * matter, or page headings in the text layer that do not match the pages.
   */
  | 'unsupported_pdf_structure'
  /** An image is over the pixel cap, so no model is given it. */
  | 'image_too_large'
  /**
   * The OCR model errored, returned nothing for an image with content, or
   * stopped at its output limit. The document is unreadable.
   */
  | 'ocr_failed'
  /** Reading did not finish inside the reading deadline. */
  | 'reading_timed_out'
  /**
   * A password-protected PDF, or an owner-locked one carrying images large
   * enough to be page scans, which the Verifier cannot decrypt to check.
   */
  | 'encrypted_pdf';

export interface DocumentExtractor {
  supports(mediaType: string): boolean;
  extract(input: DocumentInput): Promise<DocumentExtraction>;
}

/**
 * Text kept per document, in UTF-8 bytes. On the legacy path longer text is
 * cut; the ingest gate blocks a document whose text is longer
 * (`over_text_limit`), because nothing is read in part.
 */
export const MAX_EXTRACTED_TEXT_BYTES = 128 * 1024;

export function isUnreadable(
  result: DocumentExtraction,
): result is { unreadable: UnreadableReason } {
  return 'unreadable' in result;
}

// ── The reader seam ────────────────────────────────────────────────

/**
 * How a page is read. `text` reads the text layer; `scan` reads the page's
 * images by OCR; `scan+hidden` reads the images by OCR and keeps the text
 * layer, which is drawn invisibly, out of the document's text; `mixed`
 * reads the text layer and each qualifying image.
 */
export type DocumentPageClass = 'text' | 'scan' | 'scan+hidden' | 'mixed';

/** Where a page's text in the document came from. */
export type DocumentPageSource =
  | 'text-layer'
  | 'ocr'
  | 'text-layer+ocr'
  | 'hidden-layer+ocr';

export interface ReadingUsage {
  inputTokens: number;
  outputTokens: number;
}

/** How a document was read, for the audit event. No document content. */
export interface DocumentReadingRecord {
  /** The registry id of the OCR model, when one read anything. */
  reader?: DocumentReaderId;
  pages: Array<{ n: number; source: DocumentPageSource }>;
  /** Images read by OCR. */
  ocrUnits: number;
  /** Wall time of the OCR, all images together. */
  ocrMs: number;
  usage: ReadingUsage;
  /** Images too small to hold text that matters (logos, rules), not read. */
  skippedImages?: number;
  /**
   * Pages whose image the reader found empty and, asked again, said carries
   * no text or marks: the blank back of a duplex scan.
   */
  blankPages?: number[];
}

/** The invisible text layer of `scan+hidden` pages (#1573). */
export interface HiddenLayerReading {
  pages: number[];
  /** The invisible text, as the text layer gives it. */
  text: string;
  /** The OCR text of the same pages, to compare figures. */
  ocrText: string;
}

export type DocumentInspection =
  | { status: 'ok'; pages: number; ocrUnits: number }
  | {
      status: 'blocked';
      reason: 'over_page_limit' | 'over_image_limit';
      pages: number;
      ocrUnits: number;
      /**
       * Set when the images that must be decoded to be read are over the
       * per-document pixel budget, in megapixels.
       */
      decodedMegapixels?: number;
    }
  | {
      status: 'unreadable';
      reason: UnreadableReason;
      /** A plain detail for the message, e.g. the image encoding's name. */
      detail?: string;
      pages?: number;
    };

export type DocumentReadResult =
  | {
      status: 'read';
      /** Exactly the text layer when nothing was read by OCR. */
      text: string;
      pages: number;
      reading: DocumentReadingRecord;
      hidden?: HiddenLayerReading;
    }
  | {
      status: 'blocked';
      reason: 'over_text_limit';
      pages: number;
      reading: DocumentReadingRecord;
    }
  | {
      status: 'unreadable';
      reason: UnreadableReason;
      detail?: string;
      pages?: number;
      reading?: DocumentReadingRecord;
    };

/** One document, open for reading. Inspect first, then read. */
export interface DocumentReadHandle {
  /**
   * Read the structure (pages, images, how each page is drawn) and check the
   * page and image limits. Nothing is spent. `reader` is the OCR model that
   * will read, or undefined when no policy needs OCR (text layer only).
   */
  inspect(options: {
    limits: DocumentLimits;
    reader?: DocumentReaderId;
  }): Promise<DocumentInspection>;
  /** Read every page. Only after an `ok` inspection. */
  read(options: {
    reader?: DocumentReaderId;
    deadlineMs: number;
  }): Promise<DocumentReadResult>;
  /**
   * After a read that used OCR, keep the images it read beside the
   * document's part in the recipient's session, for the decision model, and
   * let the reader forget them. A runtime that keeps none leaves it out.
   */
  keepImages?(target: {
    sessionKey: string;
    partSeq: number;
  }): Promise<KeptImages>;
  /**
   * Forget the images the read used OCR on without keeping them: the
   * document was not delivered, or the recipient has no session to keep
   * them in. So plaintext images never wait in memory for eviction.
   */
  discardImages?(): Promise<void>;
}

/** What `keepImages` kept, for the audit event. No image content. */
export interface KeptImages {
  kept: number;
  /** Bytes of the images kept. */
  bytes: number;
  /** Each image not kept, and why (too large, the session's caps). */
  notKept: Array<{ page: number; ordinal: number; reason: string }>;
}

export interface DocumentReader {
  /** The media types it reads; anything else is `unsupported_media_type`. */
  supports(mediaType: string): boolean;
  open(input: DocumentInput): DocumentReadHandle;
}
