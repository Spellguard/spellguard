// SPDX-License-Identifier: Apache-2.0

/**
 * The text of a document that was read in part by OCR, as the ledger keeps it
 * and the decision model sees it (internal design notes
 * §5.3).
 *
 * A document with nothing read by OCR keeps its text layer exactly as the
 * converter gave it, with no markers. Otherwise every block of text is
 * preceded by one short marker line saying where it came from:
 *
 *   [page 1 of 3: read from the page image by Llama 4 Scout]
 *   [page 2 of 3: text layer]
 *   [page 2 of 3: text in an image on this page, read by Llama 4 Scout]
 *
 * The markers are what the decision model knows about provenance. Their
 * page numbers (and a reader label such as "Llama 4 Scout") are numbers
 * nobody stated, so the floor drops marker lines before it lists candidate
 * values (`withoutReadingMarkers`). A marker line carries nothing else, so
 * a document that forges one hides nothing by it.
 */

/** Where one block of a document's text came from. */
export type ReadingBlockSource =
  | { kind: 'text-layer' }
  | { kind: 'page-image'; readerLabel: string }
  | { kind: 'embedded-image'; readerLabel: string }
  /** The whole text layer, when it could not be split into pages. */
  | { kind: 'text-layer-all' }
  /** A page image the reader found blank. */
  | { kind: 'blank' };

export interface ReadingBlock {
  /** 1-based; ignored for `text-layer-all`. */
  page: number;
  source: ReadingBlockSource;
  text: string;
}

export function readingMarker(
  page: number,
  pages: number,
  source: ReadingBlockSource,
): string {
  switch (source.kind) {
    case 'text-layer':
      return `[page ${page} of ${pages}: text layer]`;
    case 'page-image':
      return `[page ${page} of ${pages}: read from the page image by ${source.readerLabel}]`;
    case 'embedded-image':
      return `[page ${page} of ${pages}: text in an image on this page, read by ${source.readerLabel}]`;
    case 'text-layer-all':
      return `[pages 1 to ${pages}: text layer]`;
    case 'blank':
      return `[page ${page} of ${pages}: blank]`;
  }
}

/** The document's text: each block under its marker, in order. */
export function assembleReading(
  blocks: readonly ReadingBlock[],
  pages: number,
): string {
  const lines: string[] = [];
  for (const block of blocks) {
    lines.push(readingMarker(block.page, pages, block.source));
    if (block.source.kind !== 'blank') lines.push(block.text.trim());
  }
  return lines.join('\n');
}

/** One whole marker line; reader labels are letters, digits, spaces, dots. */
const MARKER_LINE =
  /^\[(?:page \d{1,4} of \d{1,4}|pages 1 to \d{1,4}): (?:text layer|invisible text layer|blank|read from the page image by [\p{L}\p{N} .-]{1,64}|text in an image on this page, read by [\p{L}\p{N} .-]{1,64})\]$/u;

export function isReadingMarkerLine(line: string): boolean {
  return MARKER_LINE.test(line);
}

/**
 * The text without its marker lines, for listing and matching values. A
 * text with no marker is returned as it is.
 */
export function withoutReadingMarkers(text: string): string {
  if (!text.includes('[page')) return text;
  return text
    .split('\n')
    .filter((line) => !isReadingMarkerLine(line))
    .join('\n');
}
