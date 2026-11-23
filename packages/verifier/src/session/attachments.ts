// SPDX-License-Identifier: Apache-2.0

/**
 * Attachments on an agent-to-agent message
 * (internal design notes).
 *
 * The payload object a sender passes to `channel.send` may carry
 * `attachments: [{ name, mediaType, data }]`, `data` base64. On the
 * recipient's inbound leg the Verifier reads each one: limits first, on the
 * base64 length and before decoding anything, then the extractor. Every
 * attachment yields one reading, readable or not, so the ledger and the audit
 * event account for all of them; an unreadable one is never a transport
 * error.
 */

import {
  type DocumentExtractor,
  type DocumentReadingRecord,
  type HiddenLayerReading,
  type KeptImages,
  type UnreadableReason,
  isUnreadable,
} from './document-extractor';
import { MAX_PART_LABEL_CHARS } from './types';

/** Attachments read per message; later ones are recorded as too_large. */
export const MAX_ATTACHMENTS = 4;

/** Decoded bytes per attachment. */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024;

/** The longest base64 that can decode to MAX_ATTACHMENT_BYTES. */
export const MAX_ATTACHMENT_BASE64_CHARS =
  Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface AttachmentReading {
  name: string;
  mediaType: string;
  /** Decoded size, when it was decoded. */
  bytes?: number;
  /** The extracted text; absent when the attachment was unreadable. */
  text?: string;
  truncated?: boolean;
  unreadable?: UnreadableReason;
  /** Pages, when a document reader read the structure. */
  pages?: number;
  /** How the document reader read it (the ingest gate). */
  reading?: DocumentReadingRecord;
  /** The invisible text layer of scanned pages, kept out of `text`. */
  hidden?: HiddenLayerReading;
  /** A plain sentence for the audit event when it was not read. */
  message?: string;
  /**
   * Keep the images the reader read beside this document's session part
   * (`DocumentReadHandle.keepImages`); set only when OCR read some.
   */
  keepImages?: (target: {
    sessionKey: string;
    partSeq: number;
  }) => Promise<KeptImages>;
  /** Forget those images instead (`DocumentReadHandle.discardImages`). */
  discardImages?: () => Promise<void>;
}

/**
 * Forget the page images of documents that will not be kept in a session.
 * Best effort: a reader that cannot be reached drops them on eviction.
 */
export async function discardPageImages(
  readings: readonly AttachmentReading[],
): Promise<void> {
  await Promise.allSettled(readings.map((r) => r.discardImages?.()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The payload as an object, or undefined when it is not a JSON object. */
export function payloadObject(
  content: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function decodeBase64(data: string): Uint8Array | undefined {
  const compact = data.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) return undefined;
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

export function attachmentName(raw: unknown, index: number): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return (name || `attachment-${index + 1}`).slice(0, MAX_PART_LABEL_CHARS);
}

/** Read one attachment entry into a reading. */
async function readOne(
  entry: unknown,
  index: number,
  extractor: DocumentExtractor | undefined,
): Promise<AttachmentReading> {
  const record = isRecord(entry) ? entry : {};
  const name = attachmentName(record.name, index);
  const mediaType =
    typeof record.mediaType === 'string' ? record.mediaType.trim() : '';
  if (index >= MAX_ATTACHMENTS) {
    return { name, mediaType, unreadable: 'too_large' };
  }
  if (typeof record.data !== 'string' || mediaType === '') {
    return { name, mediaType, unreadable: 'invalid_encoding' };
  }
  if (record.data.length > MAX_ATTACHMENT_BASE64_CHARS) {
    return { name, mediaType, unreadable: 'too_large' };
  }
  const bytes = decodeBase64(record.data);
  if (!bytes) return { name, mediaType, unreadable: 'invalid_encoding' };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      name,
      mediaType,
      bytes: bytes.byteLength,
      unreadable: 'too_large',
    };
  }
  if (!extractor) {
    return {
      name,
      mediaType,
      bytes: bytes.byteLength,
      unreadable: 'no_extractor',
    };
  }
  if (!extractor.supports(mediaType)) {
    return {
      name,
      mediaType,
      bytes: bytes.byteLength,
      unreadable: 'unsupported_media_type',
    };
  }
  const result = await extractor.extract({ name, mediaType, bytes });
  if (isUnreadable(result)) {
    return {
      name,
      mediaType,
      bytes: bytes.byteLength,
      unreadable: result.unreadable,
    };
  }
  return {
    name,
    mediaType,
    bytes: bytes.byteLength,
    text: result.text,
    truncated: result.truncated,
  };
}

/**
 * Read every attachment on the payload, in order. A payload with no
 * `attachments` key yields none; one whose `attachments` is not an array
 * yields a single unreadable reading so the audit event shows it.
 */
export async function readAttachments(
  payload: Record<string, unknown> | undefined,
  extractor: DocumentExtractor | undefined,
): Promise<AttachmentReading[]> {
  if (!payload || payload.attachments === undefined) return [];
  if (!Array.isArray(payload.attachments)) {
    return [
      { name: 'attachments', mediaType: '', unreadable: 'invalid_encoding' },
    ];
  }
  const readings: AttachmentReading[] = [];
  for (const [index, entry] of payload.attachments.entries()) {
    readings.push(await readOne(entry, index, extractor));
  }
  return readings;
}

/** What the audit event records about one attachment. */
export function attachmentAuditRecord(
  reading: AttachmentReading,
): Record<string, unknown> {
  return {
    name: reading.name,
    mediaType: reading.mediaType,
    ...(reading.bytes !== undefined ? { bytes: reading.bytes } : {}),
    status: reading.unreadable
      ? `unreadable:${reading.unreadable}`
      : 'extracted',
    ...(reading.text !== undefined ? { chars: reading.text.length } : {}),
    ...(reading.truncated ? { truncated: true } : {}),
  };
}

/** Decoded size of base64 data from its length, or undefined when it is not base64. */
export function base64Bytes(data: string): number | undefined {
  const compact = data.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) return undefined;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return (compact.length / 4) * 3 - padding;
}

function attachmentsOf(
  payload: Record<string, unknown> | undefined,
): unknown[] | undefined {
  return payload && Array.isArray(payload.attachments)
    ? payload.attachments
    : undefined;
}

/**
 * The message as the content policies and the loop buffer see it
 * (internal design notes): the payload with each
 * attachment's base64 `data` replaced by its decoded byte count, every other
 * field kept. A payload with no attachment data is returned verbatim, so
 * every other message is judged exactly as before.
 *
 * Used for the sender's outbound pass, the recipient's first inbound pass
 * and the ring buffer. Forwarding, the ledger and the audit path keep what
 * they carry: the recipient gets the attachment, and the documents' text is
 * judged on its own pass.
 */
export function policyMessage(content: string): string {
  const payload = payloadObject(content);
  const attachments = attachmentsOf(payload);
  if (
    !payload ||
    !attachments?.some((e) => isRecord(e) && typeof e.data === 'string')
  ) {
    return content;
  }
  return JSON.stringify({
    ...payload,
    attachments: attachments.map((entry) => {
      if (!isRecord(entry) || typeof entry.data !== 'string') return entry;
      const { data, ...rest } = entry;
      const bytes = base64Bytes(data);
      return { ...rest, ...(bytes !== undefined ? { bytes } : {}) };
    }),
  });
}

/**
 * The content to forward when the sender's outbound pass redacted the
 * policy view: the redacted view with each attachment's original `data`
 * put back, so a redaction in the message (or in an attachment's name)
 * holds and the recipient still gets the file. A redacted view that is no
 * longer a JSON object with the same attachments is forwarded as it is,
 * without them: the redaction wins over the delivery of the file.
 */
export function restoreAttachments(
  redactedView: string,
  original: string,
): string {
  const view = payloadObject(redactedView);
  const viewAttachments = attachmentsOf(view);
  const originalAttachments = attachmentsOf(payloadObject(original));
  if (
    !view ||
    !viewAttachments ||
    !originalAttachments ||
    viewAttachments.length !== originalAttachments.length
  ) {
    return redactedView;
  }
  return JSON.stringify({
    ...view,
    attachments: viewAttachments.map((entry, index) => {
      const source = originalAttachments[index];
      if (
        !isRecord(entry) ||
        !isRecord(source) ||
        typeof source.data !== 'string'
      ) {
        return entry;
      }
      const { bytes: _bytes, ...rest } = entry;
      return {
        ...rest,
        ...(source.bytes !== undefined ? { bytes: source.bytes } : {}),
        data: source.data,
      };
    }),
  });
}

/**
 * The message as the ledger keeps it: the payload object without the
 * attachments' data (each kept as its name and media type) and without the
 * Verifier's own `_spellguard*` stamps; a non-object payload verbatim.
 */
export function ledgerMessage(content: string | null | undefined): {
  text: string;
  kind: 'text' | 'json';
} {
  const payload = payloadObject(content);
  if (!payload) return { text: content ?? '', kind: 'text' };
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('_spellguard')) continue;
    if (key === 'attachments' && Array.isArray(value)) {
      kept.attachments = value.map((entry, index) => ({
        name: attachmentName(isRecord(entry) ? entry.name : undefined, index),
        mediaType:
          isRecord(entry) && typeof entry.mediaType === 'string'
            ? entry.mediaType
            : '',
      }));
      continue;
    }
    kept[key] = value;
  }
  return { text: JSON.stringify(kept), kind: 'json' };
}
