// SPDX-License-Identifier: Apache-2.0

/**
 * An OCR engine: one image in, its transcription out
 * (internal design notes).
 *
 * The document-reader registry (`DOCUMENT_READERS`) names the engines a
 * policy can choose; a runtime has one client per provider. The Cloudflare
 * Verifier's client calls Workers AI vision models. Every client answers
 * the same shape, so an engine that reports a confidence per word (Textract)
 * fits beside the vision models, which report none.
 */

import type { DocumentReaderEntry } from './document-extractor';

export interface OcrInput {
  /** `image/jpeg`, `image/png` or `image/webp`. */
  mediaType: string;
  bytes: Uint8Array;
}

export interface OcrResult {
  /** The transcription, plain text. */
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Wall time of the call, retries included. */
  ms: number;
  /**
   * Per-word confidence, for engines that report it. Empty for vision
   * models; no rule reads it yet.
   */
  words?: Array<{ text: string; confidence: number }>;
}

export type OcrErrorCode =
  /** The engine errored, or answered nothing usable. */
  | 'failed'
  /** The engine stopped at its output limit: the transcription is partial. */
  | 'truncated'
  /** The engine's rate limit held past the deadline. */
  | 'rate_limited'
  /** The registry entry is not one this client serves. */
  | 'unsupported_reader';

export class OcrError extends Error {
  constructor(
    readonly code: OcrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OcrError';
  }
}

export interface OcrClient {
  /**
   * Transcribe one image with the registry entry `reader`. Rejects with an
   * OcrError; aborts when `signal` does.
   */
  transcribe(
    reader: DocumentReaderEntry,
    input: OcrInput,
    options: { signal: AbortSignal },
  ): Promise<OcrResult>;

  /**
   * Asked after an empty transcription: does the image carry any text or
   * marks at all? `blank: true` only on a plain no. A page left unread can
   * only remove sources, which pushes a check toward blocking, never toward
   * approving; anything but a clear no is a failed reading.
   */
  checkBlank?(
    reader: DocumentReaderEntry,
    input: OcrInput,
    options: { signal: AbortSignal },
  ): Promise<{
    blank: boolean;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}
