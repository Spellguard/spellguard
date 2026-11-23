// SPDX-License-Identifier: Apache-2.0

/**
 * The ingest gate for message attachments
 * (internal design notes).
 *
 * The agent's model reads every page of a document it receives, so the
 * Verifier reads every page or blocks the document on the recipient's
 * inbound leg; nothing is read in part. The gate runs on runtimes that have
 * a `DocumentReader` (the Cloudflare Verifier). The checks run in this
 * order, each before anything is spent, and the first that applies decides:
 *
 *   1. more attachments than MAX_ATTACHMENTS_PER_MESSAGE   too_many_attachments
 *   2. an attachment over the byte limit (from its base64)  over_size_limit
 *   3. the structure (no spend): pages over the limit       over_page_limit
 *      images to read over two per allowed page            over_image_limit
 *   4. the reading: text over MAX_EXTRACTED_TEXT_BYTES      over_text_limit
 *   5. text over what the bound decision model judges       over_model_capacity
 *   6. an attachment that could not be read: the recipient's session-family
 *      bindings decide by failBehavior (block, flag, or deliver)
 *
 * An attachment found unreadable at step 3 under a binding that blocks
 * stops the gate there, before anything is read by OCR.
 *
 * The audit record per attachment carries no document content.
 */

import {
  type DocumentLimits,
  MAX_ATTACHMENTS_PER_MESSAGE,
  getDecisionModel,
  ocrUnitsAllowed,
} from '@spellguard/amp';
import { base64ToBytes } from '../crypto/base64';
import { agentConductConfig } from '../proxy/conduct-config';
import { formatMegabytes } from '../proxy/message-body-limit';
import type { ResolvedPolicyConfig } from '../proxy/policy-evaluator-types';
import { readSemanticConsistencyConfig } from '../proxy/session-config';
import { numbersIn } from '../proxy/session-floor';
import { stateBudgetChars } from '../proxy/session-questions';
import {
  type AttachmentReading,
  attachmentName,
  base64Bytes,
} from './attachments';
import type { DecisionModelId } from './decision-model';
import {
  DEFAULT_DOCUMENT_READER_ID,
  type DocumentInspection,
  type DocumentReadHandle,
  type DocumentReadResult,
  type DocumentReader,
  type DocumentReaderId,
  type DocumentReadingRecord,
  type KeptImages,
  MAX_EXTRACTED_TEXT_BYTES,
  type UnreadableReason,
  getDocumentReader,
} from './document-extractor';
import { SESSION_POLICY_TYPES } from './runtime';

/** How long one document may take to read, OCR included. */
export const READING_DEADLINE_MS = 60_000;

/**
 * The share of the decision model's state budget one document may take,
 * leaving room for the message, other sources and the action.
 */
export const MODEL_CAPACITY_SHARE = 0.8;

export type DocumentBlockReason =
  | 'too_many_attachments'
  | 'over_size_limit'
  | 'over_page_limit'
  | 'over_image_limit'
  | 'over_text_limit'
  | 'over_model_capacity';

/**
 * Whether a hidden text layer states other numbers than the page images
 * read by OCR on the same pages. Audit only: it blocks nothing; the session
 * policies judge the values an action uses (`hidden_text_value`).
 */
export function numbersDiffer(hiddenText: string, ocrText: string): boolean {
  const hidden = numbersIn(hiddenText);
  const seen = numbersIn(ocrText);
  if (hidden.size !== seen.size) return true;
  for (const n of hidden) if (!seen.has(n)) return true;
  return false;
}

/** The handle's `keepImages`, when its read used OCR and it keeps images. */
function keepImagesOf(
  handle: DocumentReadHandle | undefined,
  result: Extract<DocumentReadResult, { status: 'read' }>,
): Pick<AttachmentReading, 'keepImages' | 'discardImages'> {
  if (!handle?.keepImages || result.reading.ocrUnits === 0) return {};
  return {
    keepImages: (target) => handle.keepImages?.(target) ?? noImages(),
    discardImages: async () => {
      await handle.discardImages?.();
    },
  };
}

async function noImages(): Promise<KeptImages> {
  return { kept: 0, bytes: 0, notKept: [] };
}

/** The reader and decision model the recipient's bindings choose. */
export interface ReaderChoice {
  /** Undefined: no session policy needs OCR, so the text layer only. */
  reader?: DocumentReaderId;
  /** The first consistency binding's model, for capacity. */
  model?: DecisionModelId;
  /** Every reader named, when later bindings named different ones. */
  conflict?: DocumentReaderId[];
}

/**
 * The reader for a recipient: the `reader` of its first consistency binding
 * (`semantic-consistency` or `agent-conduct`) with a valid config, inbound
 * bindings first; the default reader when it is bound only to
 * session-invariant; none when it has no session policy, because reading by
 * OCR costs money and time only a policy needs.
 */
export function chooseReader(
  config: Pick<ResolvedPolicyConfig, 'inbound' | 'outbound'> | null | undefined,
): ReaderChoice {
  if (!config) return {};
  const bindings = [...config.inbound, ...config.outbound];
  const named: Array<{ reader: DocumentReaderId; model: DecisionModelId }> = [];
  for (const binding of bindings) {
    if (binding.policyType === 'semantic-consistency') {
      const read = readSemanticConsistencyConfig(binding.config);
      if (read.ok) {
        named.push({ reader: read.config.reader, model: read.config.model });
      }
    } else if (binding.policyType === 'agent-conduct') {
      const read = agentConductConfig(binding.config ?? {});
      if (read.ok) {
        named.push({ reader: read.profile.reader, model: read.profile.model });
      }
    }
  }
  if (named.length > 0) {
    const readers = [...new Set(named.map((n) => n.reader))];
    return {
      reader: named[0].reader,
      model: named[0].model,
      ...(readers.length > 1 ? { conflict: readers } : {}),
    };
  }
  if (bindings.some((b) => SESSION_POLICY_TYPES.has(b.policyType))) {
    return { reader: DEFAULT_DOCUMENT_READER_ID };
  }
  return {};
}

/**
 * What an unreadable attachment means for this recipient: its session-family
 * bindings decide. `block` when any of them would block (failBehavior,
 * default block); `flag` when one warns; `deliver` otherwise, and for a
 * recipient with no session-family binding.
 */
export function unreadableOutcome(
  config: Pick<ResolvedPolicyConfig, 'inbound' | 'outbound'> | null | undefined,
): 'block' | 'flag' | 'deliver' {
  if (!config) return 'deliver';
  const session = [...config.inbound, ...config.outbound].filter((b) =>
    SESSION_POLICY_TYPES.has(b.policyType),
  );
  if (session.some((b) => (b.failBehavior ?? 'block') === 'block')) {
    return 'block';
  }
  if (session.some((b) => b.failBehavior === 'warn')) return 'flag';
  return 'deliver';
}

/** One attachment on the audit event. No document content. */
export interface AttachmentAuditRecord {
  name: string;
  mediaType: string;
  bytes?: number;
  pages?: number;
  /** `extracted`, `unreadable:<reason>` or `blocked:<reason>`. */
  status: string;
  /** A plain sentence when it was not read. */
  message?: string;
  reading?: DocumentReadingRecord;
  hiddenLayer?: { pages: number[]; differs?: boolean };
  chars?: number;
  truncated?: boolean;
}

/** The reading totals on the audit event, for metering later (#1577). */
export interface ReadingSummary {
  reader?: DocumentReaderId;
  readerConflict?: DocumentReaderId[];
  ocrUnits: number;
  ocrMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export type GateOutcome =
  | {
      kind: 'deliver';
      readings: AttachmentReading[];
      audit: AttachmentAuditRecord[];
      summary: ReadingSummary;
      /** An unreadable attachment under a warning binding: flag the event. */
      flag?: { message: string };
    }
  | {
      kind: 'block';
      reasonCode: 'document-limit-exceeded' | 'document-unreadable';
      reason: DocumentBlockReason | UnreadableReason;
      message: string;
      audit: AttachmentAuditRecord[];
      summary: ReadingSummary;
    };

export interface GateInput {
  payload: Record<string, unknown> | undefined;
  reader: DocumentReader;
  recipientConfig: ResolvedPolicyConfig | null | undefined;
  limits: DocumentLimits;
  deadlineMs?: number;
}

interface Entry {
  name: string;
  mediaType: string;
  data?: string;
  bytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decode(data: string): Uint8Array | undefined {
  const compact = data.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) return undefined;
  try {
    return base64ToBytes(compact);
  } catch {
    return undefined;
  }
}

function entriesOf(payload: Record<string, unknown> | undefined): Entry[] {
  if (!payload || payload.attachments === undefined) return [];
  if (!Array.isArray(payload.attachments)) {
    return [{ name: 'attachments', mediaType: '' }];
  }
  return payload.attachments.map((raw, index) => {
    const record = isRecord(raw) ? raw : {};
    const mediaType =
      typeof record.mediaType === 'string' ? record.mediaType.trim() : '';
    const data = typeof record.data === 'string' ? record.data : undefined;
    return {
      name: attachmentName(record.name, index),
      mediaType,
      data,
      bytes: data === undefined ? undefined : base64Bytes(data),
    };
  });
}

function emptyReading(): DocumentReadingRecord {
  return {
    pages: [],
    ocrUnits: 0,
    ocrMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** The plain sentence for an attachment that could not be read. */
export function unreadableMessage(
  name: string,
  reason: UnreadableReason,
  detail?: string,
  mediaType?: string,
): string {
  switch (reason) {
    case 'unsupported_media_type':
      return `The attachment ${name} is a type Spellguard does not read${mediaType ? ` (${mediaType})` : ''}.`;
    case 'invalid_encoding':
      return `The attachment ${name} is not valid base64, or is not the type it says it is.`;
    case 'unsupported_image_encoding':
      return `The attachment ${name} uses an image format Spellguard cannot read yet${detail ? ` (${detail})` : ''}.`;
    case 'unsupported_pdf_structure':
      return `The attachment ${name} is built in a way Spellguard cannot read yet${detail ? ` (${detail})` : ''}.`;
    case 'image_too_large':
      return `An image in the attachment ${name} is larger than Spellguard reads${detail ? ` (${detail})` : ''}.`;
    case 'ocr_failed':
      return `Spellguard could not read the images in the attachment ${name}${detail ? ` (${detail})` : ''}.`;
    case 'reading_timed_out':
      return `Reading the attachment ${name} took longer than Spellguard allows (${READING_DEADLINE_MS / 1000} s).`;
    case 'encrypted_pdf':
      return `The attachment ${name} is encrypted, so Spellguard cannot read it${detail ? ` (${detail})` : ''}.`;
    case 'no_text':
      return `The attachment ${name} has no text to read.`;
    case 'extraction_failed':
      return `Spellguard could not read the attachment ${name}${detail ? ` (${detail})` : ''}.`;
    case 'no_extractor':
      return `This Verifier does not read attachments, so ${name} was not read.`;
    case 'too_large':
      return `The attachment ${name} is larger than this Verifier reads.`;
  }
}

function blockedRecord(
  entry: Entry,
  reason: DocumentBlockReason,
  message: string,
  extra: Partial<AttachmentAuditRecord> = {},
): AttachmentAuditRecord {
  return {
    name: entry.name,
    mediaType: entry.mediaType,
    ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    status: `blocked:${reason}`,
    message,
    ...extra,
  };
}

/** About how many of this document's pages fit in `chars` of text. */
function pagesThatFit(chars: number, textChars: number, pages: number): number {
  if (pages <= 0 || textChars <= 0) return pages;
  return Math.max(1, Math.floor(chars / (textChars / pages)));
}

function sumUsage(records: Array<DocumentReadingRecord | undefined>) {
  const summary = {
    ocrUnits: 0,
    ocrMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  for (const record of records) {
    if (!record) continue;
    summary.ocrUnits += record.ocrUnits;
    summary.ocrMs += record.ocrMs;
    summary.usage.inputTokens += record.usage.inputTokens;
    summary.usage.outputTokens += record.usage.outputTokens;
  }
  return summary;
}

/**
 * Run the gate over a message's attachments. A message the gate blocks after
 * reading has its documents' page images discarded, since nothing keeps them.
 */
export async function gateAttachments(input: GateInput): Promise<GateOutcome> {
  const read: DocumentReadHandle[] = [];
  const outcome = await runGate(input, read);
  if (outcome.kind === 'block') {
    await Promise.allSettled(read.map((handle) => handle.discardImages?.()));
  }
  return outcome;
}

async function runGate(
  input: GateInput,
  read: DocumentReadHandle[],
): Promise<GateOutcome> {
  const entries = entriesOf(input.payload);
  const choice = chooseReader(input.recipientConfig);
  const baseSummary = (
    records: Array<DocumentReadingRecord | undefined> = [],
  ): ReadingSummary => ({
    ...(choice.reader ? { reader: choice.reader } : {}),
    ...(choice.conflict ? { readerConflict: choice.conflict } : {}),
    ...sumUsage(records),
  });
  const limits = input.limits;
  const pending = (entry: Entry): AttachmentAuditRecord => ({
    name: entry.name,
    mediaType: entry.mediaType,
    ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    status: 'not_read',
  });
  const block = (
    reason: DocumentBlockReason,
    message: string,
    audit: AttachmentAuditRecord[],
    records: Array<DocumentReadingRecord | undefined> = [],
  ): GateOutcome => ({
    kind: 'block',
    reasonCode: 'document-limit-exceeded',
    reason,
    message,
    audit,
    summary: baseSummary(records),
  });

  if (entries.length === 0) {
    return { kind: 'deliver', readings: [], audit: [], summary: baseSummary() };
  }

  // 1. Count.
  if (entries.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    const message = `The message has ${entries.length} attachments; Spellguard reads up to ${MAX_ATTACHMENTS_PER_MESSAGE} per message.`;
    return block(
      'too_many_attachments',
      message,
      entries.map((e) => blockedRecord(e, 'too_many_attachments', message)),
    );
  }

  // 2. Size, from the base64 length, before anything is decoded.
  for (const [index, entry] of entries.entries()) {
    if (entry.bytes !== undefined && entry.bytes > limits.maxBytes) {
      const message = `The attachment ${entry.name} is ${formatMegabytes(entry.bytes)}; this organization reads up to ${formatMegabytes(limits.maxBytes)}.`;
      return block(
        'over_size_limit',
        message,
        entries.map((e, i) =>
          i === index
            ? blockedRecord(e, 'over_size_limit', message)
            : pending(e),
        ),
      );
    }
  }

  // 3. Decode and read each structure. Nothing is spent.
  type Opened =
    | {
        entry: Entry;
        handle: DocumentReadHandle;
        inspection: DocumentInspection;
      }
    | {
        entry: Entry;
        unreadable: UnreadableReason;
        detail?: string;
        pages?: number;
      };
  const opened: Opened[] = [];
  for (const entry of entries) {
    if (entry.data === undefined || entry.mediaType === '') {
      opened.push({ entry, unreadable: 'invalid_encoding' });
      continue;
    }
    if (!input.reader.supports(entry.mediaType)) {
      opened.push({ entry, unreadable: 'unsupported_media_type' });
      continue;
    }
    const bytes = decode(entry.data);
    if (!bytes) {
      opened.push({ entry, unreadable: 'invalid_encoding' });
      continue;
    }
    const handle = input.reader.open({
      name: entry.name,
      mediaType: entry.mediaType,
      bytes,
    });
    let inspection: DocumentInspection;
    try {
      inspection = await handle.inspect({ limits, reader: choice.reader });
    } catch (err) {
      inspection = {
        status: 'unreadable',
        reason: 'extraction_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (inspection.status === 'unreadable') {
      opened.push({
        entry,
        unreadable: inspection.reason,
        detail: inspection.detail,
        pages: inspection.pages,
      });
      continue;
    }
    opened.push({ entry, handle, inspection });
  }

  for (const [index, item] of opened.entries()) {
    if (!('inspection' in item) || item.inspection.status !== 'blocked') {
      continue;
    }
    const { entry, inspection } = item;
    const message =
      inspection.reason === 'over_page_limit'
        ? `The attachment ${entry.name} has ${inspection.pages} pages; this organization reads up to ${limits.maxPages}.`
        : inspection.decodedMegapixels !== undefined
          ? `The attachment ${entry.name} has too many image pixels to read in one document (${inspection.decodedMegapixels} megapixels to decode).`
          : `The attachment ${entry.name} has ${inspection.ocrUnits} images to read; this organization reads up to ${ocrUnitsAllowed(limits.maxPages)} (two per page).`;
    return block(
      inspection.reason,
      message,
      opened.map((o, i) =>
        i === index
          ? blockedRecord(o.entry, inspection.reason, message, {
              pages: inspection.pages,
            })
          : pending(o.entry),
      ),
    );
  }

  const outcome = unreadableOutcome(input.recipientConfig);
  const unreadableRecord = (
    entry: Entry,
    reason: UnreadableReason,
    detail?: string,
    pages?: number,
    reading?: DocumentReadingRecord,
  ): AttachmentAuditRecord => ({
    name: entry.name,
    mediaType: entry.mediaType,
    ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    ...(pages !== undefined ? { pages } : {}),
    status:
      outcome === 'block' && reason !== 'no_text'
        ? `blocked:${reason}`
        : `unreadable:${reason}`,
    message: unreadableMessage(entry.name, reason, detail, entry.mediaType),
    ...(reading ? { reading } : {}),
  });

  // An attachment already unreadable stops the gate here when the
  // recipient's bindings block, before anything is read by OCR.
  const early = opened.find((o) => 'unreadable' in o) as
    | Extract<Opened, { unreadable: UnreadableReason }>
    | undefined;
  if (early && outcome === 'block') {
    return {
      kind: 'block',
      reasonCode: 'document-unreadable',
      reason: early.unreadable,
      message: unreadableMessage(
        early.entry.name,
        early.unreadable,
        early.detail,
        early.entry.mediaType,
      ),
      audit: opened.map((o) =>
        o === early
          ? unreadableRecord(
              o.entry,
              early.unreadable,
              early.detail,
              early.pages,
            )
          : pending(o.entry),
      ),
      summary: baseSummary(),
    };
  }

  // 4. Read every page, every attachment at once.
  const deadlineMs = input.deadlineMs ?? READING_DEADLINE_MS;
  const results: Array<DocumentReadResult | undefined> = await Promise.all(
    opened.map(async (o) => {
      if (!('handle' in o)) return undefined;
      read.push(o.handle);
      try {
        return await o.handle.read({ reader: choice.reader, deadlineMs });
      } catch (err) {
        return {
          status: 'unreadable',
          reason: 'extraction_failed',
          detail: err instanceof Error ? err.message : String(err),
        } satisfies DocumentReadResult;
      }
    }),
  );
  const records = results.map((r) => r?.reading);

  const audit: AttachmentAuditRecord[] = [];
  const readings: AttachmentReading[] = [];
  let firstUnreadable:
    | { entry: Entry; reason: UnreadableReason; detail?: string }
    | undefined;
  const model = choice.model ? getDecisionModel(choice.model) : undefined;
  const capacityChars = model
    ? Math.floor(
        MODEL_CAPACITY_SHARE * stateBudgetChars(model, model.maxImages),
      )
    : undefined;

  for (const [index, o] of opened.entries()) {
    const result = results[index];
    const entry = o.entry;
    if (!result) {
      // Unreadable at inspection.
      const u = o as Extract<Opened, { unreadable: UnreadableReason }>;
      firstUnreadable ??= { entry, reason: u.unreadable, detail: u.detail };
      audit.push(unreadableRecord(entry, u.unreadable, u.detail, u.pages));
      readings.push({
        name: entry.name,
        mediaType: entry.mediaType,
        ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
        unreadable: u.unreadable,
        message: unreadableMessage(entry.name, u.unreadable, u.detail),
      });
      continue;
    }
    if (result.status === 'blocked') {
      // 4. Too much text to keep whole.
      const message = `The text of the attachment ${entry.name} is longer than Spellguard keeps for one document (${MAX_EXTRACTED_TEXT_BYTES / 1024} KB).`;
      return block(
        'over_text_limit',
        message,
        opened.map((x, i) =>
          i === index
            ? blockedRecord(x.entry, 'over_text_limit', message, {
                pages: result.pages,
                reading: result.reading,
              })
            : pending(x.entry),
        ),
        records,
      );
    }
    if (result.status === 'unreadable') {
      // A document that really is empty (no text, nothing to read by OCR)
      // is recorded as today and never blocks.
      if (result.reason !== 'no_text') {
        firstUnreadable ??= {
          entry,
          reason: result.reason,
          detail: result.detail,
        };
      }
      audit.push(
        unreadableRecord(
          entry,
          result.reason,
          result.detail,
          result.pages,
          result.reading,
        ),
      );
      readings.push({
        name: entry.name,
        mediaType: entry.mediaType,
        ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
        ...(result.pages !== undefined ? { pages: result.pages } : {}),
        unreadable: result.reason,
        ...(result.reading ? { reading: result.reading } : {}),
        message: unreadableMessage(entry.name, result.reason, result.detail),
      });
      continue;
    }
    // 5. More text than the bound decision model judges in one call.
    if (
      capacityChars !== undefined &&
      model &&
      result.text.length > capacityChars
    ) {
      const fit = pagesThatFit(capacityChars, result.text.length, result.pages);
      const message = `The attachment ${entry.name} is longer than ${model.label} can read in one check (about ${fit} ${fit === 1 ? 'page' : 'pages'}).`;
      return block(
        'over_model_capacity',
        message,
        opened.map((x, i) =>
          i === index
            ? blockedRecord(x.entry, 'over_model_capacity', message, {
                pages: result.pages,
                reading: result.reading,
                chars: result.text.length,
              })
            : pending(x.entry),
        ),
        records,
      );
    }
    audit.push({
      name: entry.name,
      mediaType: entry.mediaType,
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      pages: result.pages,
      status: 'extracted',
      reading: result.reading,
      ...(result.hidden
        ? {
            hiddenLayer: {
              pages: result.hidden.pages,
              differs: numbersDiffer(result.hidden.text, result.hidden.ocrText),
            },
          }
        : {}),
      chars: result.text.length,
    });
    readings.push({
      name: entry.name,
      mediaType: entry.mediaType,
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      pages: result.pages,
      text: result.text,
      truncated: false,
      reading: result.reading,
      ...(result.hidden ? { hidden: result.hidden } : {}),
      ...keepImagesOf('handle' in o ? o.handle : undefined, result),
    });
  }

  // 6. Unreadable: the recipient's session-family bindings decide.
  if (firstUnreadable && outcome === 'block') {
    return {
      kind: 'block',
      reasonCode: 'document-unreadable',
      reason: firstUnreadable.reason,
      message: unreadableMessage(
        firstUnreadable.entry.name,
        firstUnreadable.reason,
        firstUnreadable.detail,
        firstUnreadable.entry.mediaType,
      ),
      audit,
      summary: baseSummary(records),
    };
  }
  return {
    kind: 'deliver',
    readings,
    audit,
    summary: baseSummary(records),
    ...(firstUnreadable && outcome === 'flag'
      ? {
          flag: {
            message: unreadableMessage(
              firstUnreadable.entry.name,
              firstUnreadable.reason,
              firstUnreadable.detail,
              firstUnreadable.entry.mediaType,
            ),
          },
        }
      : {}),
  };
}
