// SPDX-License-Identifier: Apache-2.0
/**
 * Verifies a Spellguard audit export against its checkpoints in S3 Object
 * Lock. The format and every check are described in ../../SPEC.md; this file
 * follows it section by section.
 *
 * Runs unchanged in a browser and in Node 20+: it uses only the global
 * `fetch`, `crypto.subtle` and `TextEncoder`/`TextDecoder`.
 */

export const FORMAT = 1;
export const PRODUCTION_BUCKET = 'spellguard-audit-checkpoints-production';
/** Each listing page starts after the key of seq `page × LIST_PAGE_SEQS`. */
export const LIST_PAGE_SEQS = 500;
/** Where Verifier audit signing keys are published. */
export const KEYS_PREFIX = 'audit-checkpoints/keys/';
const STALE_AFTER_MS = 25 * 3_600_000;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
const DEFAULT_STORAGE_KEY = 'spellguard.audit-verify.state';

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckpointKind = 'records' | 'disposal' | 'heartbeat';
export type DisposalReason =
  | 'retention'
  | 'owner_purge'
  | 'organization_deletion'
  | 'unattributed';

export interface ManifestCheckpoint {
  seq: number;
  kind: string;
  written_at: string;
  leaf_count: number;
  sha256: string;
  url: string;
}

export interface ManifestRecordsRange {
  from_seq: number;
  /** null: no upper bound, every `records` checkpoint from `from_seq` on. */
  to_seq: number | null;
  pending: boolean;
}

export interface Manifest {
  format: number;
  exported_at: string;
  bucket: string;
  region: string;
  generation: string;
  stream: string;
  prefix: string;
  urls_expire_at: string;
  listing: string[];
  checkpoints: ManifestCheckpoint[];
  /** Absent means every checkpoint in `checkpoints`, plus pending records. */
  records?: ManifestRecordsRange;
  /** The Verifier keys; absent in exports made before records were signed. */
  keys?: ManifestKeys;
  /** Links to archived message objects, for replaying a session. */
  archives?: ManifestArchive[];
}

export interface ManifestArchive {
  archive_ref: string;
  url: string;
}

export interface ManifestKey {
  key_id: string;
  url: string;
}

export interface ManifestKeys {
  /** A presigned ListObjectVersions URL for `KEYS_PREFIX`. */
  listing: string;
  objects: ManifestKey[];
}

export interface ExportedRecord {
  id: string;
  checkpoint_seq: number | null;
  record: string;
  checkpointed_record?: string;
  /** The exact text the Verifier signed, for signed records. */
  signed_record?: string;
}

export interface Bundle {
  manifest: Manifest;
  records: ExportedRecord[];
}

export interface SavedStream {
  bucket: string;
  generation: string;
  stream: string;
  /** seq (as a decimal string) → SHA-256 of the checkpoint object. */
  checkpoints: Record<string, string>;
  verified_at: string;
}

export interface StateStore {
  load(key: string): Promise<SavedStream | null>;
  save(key: string, stream: SavedStream): Promise<void>;
  all(): Promise<Record<string, SavedStream>>;
}

export type FindingCode =
  | 'bucket_not_allowed'
  | 'url_mismatch'
  | 'listing_incomplete'
  | 'unexpected_key'
  | 'delete_marker'
  | 'extra_version'
  | 'checkpoint_missing'
  | 'checkpoint_not_exported'
  | 'checkpoint_unreadable'
  | 'version_mismatch'
  | 'not_locked'
  | 'checkpoint_invalid'
  | 'chain_broken'
  | 'ledger_mismatch'
  | 'duplicate_leaf'
  | 'checkpoints_beyond_export'
  | 'stream_stale'
  | 'saved_checkpoint_changed'
  | 'saved_checkpoint_gone'
  | 'stream_generation_changed'
  | 'state_not_saved'
  | 'record_invalid'
  | 'record_changed'
  | 'record_unlisted'
  | 'disposed_but_present'
  | 'record_deleted_unexplained'
  | 'disposal_mismatch'
  | 'record_missing'
  | 'key_invalid'
  | 'signed_record_missing'
  | 'signature_invalid'
  | 'signed_field_mismatch'
  | 'signature_key_unknown'
  | 'signature_predates_key'
  | 'archive_unavailable'
  | 'archive_changed';

export type SignatureState = 'valid' | 'unsigned' | 'unverified' | 'invalid';

export type Severity = 'fail' | 'warning' | 'info';
export type RecordStatus =
  | 'ok'
  | 'pending'
  | 'deleted'
  | 'missing'
  | 'tampered';

export interface Finding {
  code: FindingCode;
  fails: boolean;
  severity: Severity;
  seq: number | null;
  record_id: string | null;
  /** The Verifier key a key finding is about. */
  key_id?: string;
  message: string;
}

export interface FieldDiff {
  field: string;
  now: unknown;
  was: unknown;
}

export interface RecordResult {
  id: string;
  status: RecordStatus;
  seq: number | null;
  uploaded_at: string | null;
  record?: Record<string, unknown>;
  reason?: string;
  diff?: FieldDiff[];
  /** Absent for deleted, missing and invalid records. */
  signature?: SignatureState;
  /** The key id of a signed record. */
  signed_by?: string;
  /** Signed fields whose value differs: `now` the record's, `was` the signed. */
  signed_diff?: FieldDiff[];
  codes: FindingCode[];
}

export interface Report {
  ok: boolean;
  stream: {
    bucket: string;
    region: string;
    generation: string;
    organization: string;
  };
  checkpoints: {
    count: number;
    first_uploaded_at: string | null;
    last_uploaded_at: string | null;
    earliest_lock_expiry: string | null;
    by_kind: { records: number; disposal: number; heartbeat: number };
  };
  counts: Record<RecordStatus, number>;
  signatures: Record<SignatureState, number>;
  records: RecordResult[];
  findings: Finding[];
}

export interface VerifyOptions {
  allowedBuckets: string[];
  now?: Date;
  fetch?: typeof fetch;
  state?: StateStore;
  concurrency?: number;
}

const WARNINGS: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'stream_stale',
  'stream_generation_changed',
  'state_not_saved',
  'signature_key_unknown',
  'signature_predates_key',
  'archive_unavailable',
]);
const INFOS: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'checkpoints_beyond_export',
]);
/** Findings about a checkpoint object itself; such an object is never saved. */
const CHECKPOINT_PROBLEMS: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'delete_marker',
  'extra_version',
  'version_mismatch',
  'not_locked',
  'checkpoint_invalid',
  'chain_broken',
  'ledger_mismatch',
  'saved_checkpoint_changed',
]);

function severityOf(code: FindingCode): Severity {
  if (WARNINGS.has(code)) return 'warning';
  if (INFOS.has(code)) return 'info';
  return 'fail';
}

// ── Small helpers ────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const SEQ_FILE = /^(\d{12})\.json$/;

/** The 12-digit object name for a seq. */
export function seqName(seq: number): string {
  return String(seq).padStart(12, '0');
}

export function checkpointKey(prefix: string, seq: number): string {
  return `${prefix}${seqName(seq)}.json`;
}

/** The key the verifier expects for a stream. */
export function streamPrefix(generation: string, stream: string): string {
  return `audit-checkpoints/${generation}/${stream}/`;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

function compactJson(value: unknown): string {
  return value === undefined ? 'null' : JSON.stringify(value);
}

async function pool<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await run(item);
      }
    },
  );
  await Promise.all(workers);
}

// ── Bundle parsing ───────────────────────────────────────────────────────────

/** Parses `records.jsonl`. Throws on a malformed line, naming it. */
export function parseRecordsJsonl(text: string): ExportedRecord[] {
  const out: ExportedRecord[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`records.jsonl line ${index + 1} is not JSON`);
    }
    if (
      !isObject(value) ||
      typeof value.id !== 'string' ||
      typeof value.record !== 'string' ||
      !(value.checkpoint_seq === null || isPositiveInt(value.checkpoint_seq)) ||
      !(
        value.checkpointed_record === undefined ||
        typeof value.checkpointed_record === 'string'
      ) ||
      !(
        value.signed_record === undefined ||
        typeof value.signed_record === 'string'
      )
    ) {
      throw new Error(
        `records.jsonl line ${index + 1} is not an exported record`,
      );
    }
    const record: ExportedRecord = {
      id: value.id,
      checkpoint_seq: value.checkpoint_seq as number | null,
      record: value.record,
    };
    if (typeof value.checkpointed_record === 'string') {
      record.checkpointed_record = value.checkpointed_record;
    }
    if (typeof value.signed_record === 'string') {
      record.signed_record = value.signed_record;
    }
    out.push(record);
  });
  return out;
}

/** Throws when the manifest is too malformed to verify at all. */
export function validateManifest(
  manifest: unknown,
): asserts manifest is Manifest {
  const bad = (why: string): never => {
    throw new Error(`manifest.json: ${why}`);
  };
  if (!isObject(manifest)) bad('not a JSON object');
  const m = manifest as Record<string, unknown>;
  if (m.format !== FORMAT)
    bad(`unsupported format ${JSON.stringify(m.format)}`);
  for (const field of ['bucket', 'region', 'generation', 'stream', 'prefix']) {
    if (typeof m[field] !== 'string' || m[field] === '')
      bad(`missing ${field}`);
  }
  if (!Array.isArray(m.listing) || m.listing.length === 0)
    bad('no listing URLs');
  if (!(m.listing as unknown[]).every((u) => typeof u === 'string')) {
    bad('listing URLs must be strings');
  }
  if (!Array.isArray(m.checkpoints)) bad('missing checkpoints');
  const seen = new Set<number>();
  for (const c of m.checkpoints as unknown[]) {
    if (
      !isObject(c) ||
      !isPositiveInt(c.seq) ||
      typeof c.url !== 'string' ||
      typeof c.sha256 !== 'string' ||
      typeof c.kind !== 'string' ||
      typeof c.leaf_count !== 'number'
    ) {
      bad('a checkpoint entry is malformed');
    }
    const seq = (c as { seq: number }).seq;
    if (seen.has(seq)) bad(`checkpoint ${seq} is listed twice`);
    seen.add(seq);
  }
  if (m.records !== undefined) {
    const r = m.records;
    if (
      !isObject(r) ||
      typeof r.from_seq !== 'number' ||
      !(r.to_seq === null || typeof r.to_seq === 'number') ||
      typeof r.pending !== 'boolean'
    ) {
      bad('records range is malformed');
    }
  }
  if (m.keys !== undefined) {
    const k = m.keys;
    if (!isObject(k) || typeof k.listing !== 'string' || k.listing === '') {
      bad('the keys have no listing URL');
    }
    if (!Array.isArray((k as Record<string, unknown>).objects)) {
      bad('the keys have no objects');
    }
    const keys = new Set<string>();
    for (const entry of (k as { objects: unknown[] }).objects) {
      if (
        !isObject(entry) ||
        typeof entry.key_id !== 'string' ||
        entry.key_id === '' ||
        typeof entry.url !== 'string' ||
        entry.url === ''
      ) {
        bad('a key entry is malformed');
      }
      const id = (entry as { key_id: string }).key_id;
      if (keys.has(id)) bad(`key ${id} is listed twice`);
      keys.add(id);
    }
  }
}

// ── S3 listing XML ───────────────────────────────────────────────────────────

export interface ListingEntry {
  key: string;
  versionId: string;
  lastModified: string;
  deleteMarker: boolean;
}

export interface ListingPage {
  isTruncated: boolean;
  prefix: string;
  keyMarker: string;
  nextKeyMarker: string | null;
  entries: ListingEntry[];
}

function decodeXml(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (_, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return String.fromCodePoint(
            entity[1] === 'x'
              ? Number.parseInt(entity.slice(2), 16)
              : Number.parseInt(entity.slice(1), 10),
          );
      }
    },
  );
}

// The listing is untrusted input, so the element scans below use indexOf, not
// a lazy `<x>([\s\S]*?)</x>` regex: that regex retries from every unclosed
// opening tag and is quadratic on a document full of them.

function xmlField(source: string, name: string): string | null {
  if (new RegExp(`<${name}\\s*/>`).test(source)) return '';
  const open = `<${name}>`;
  const start = source.indexOf(open);
  if (start === -1) return null;
  // No closing tag after the first opening tag means none after a later one.
  const end = source.indexOf(`</${name}>`, start + open.length);
  return end === -1 ? null : decodeXml(source.slice(start + open.length, end));
}

interface XmlBlock {
  name: string;
  inner: string;
  start: number;
  end: number;
}

/**
 * Every `<name>…</name>` block for the given element names, left to right,
 * each closed by the first matching closing tag: what
 * `/<(A|B)>([\s\S]*?)<\/\1>/g` matches, in linear time.
 */
function xmlBlocks(xml: string, names: readonly string[]): XmlBlock[] {
  const blocks: XmlBlock[] = [];
  // Per name: the next opening tag at or after `pos`, and whether a closing
  // tag can still occur. Both only move forward, so each is scanned once.
  const nextOpen = names.map((name) => xml.indexOf(`<${name}>`));
  const closable = names.map(() => true);
  let pos = 0;
  for (;;) {
    let pick = -1;
    for (let i = 0; i < names.length; i++) {
      if (nextOpen[i] !== -1 && nextOpen[i] < pos) {
        nextOpen[i] = xml.indexOf(`<${names[i]}>`, pos);
      }
      if (
        nextOpen[i] !== -1 &&
        closable[i] &&
        (pick === -1 || nextOpen[i] < nextOpen[pick])
      ) {
        pick = i;
      }
    }
    if (pick === -1) return blocks;
    const name = names[pick];
    const start = nextOpen[pick];
    const innerStart = start + name.length + 2;
    const close = xml.indexOf(`</${name}>`, innerStart);
    if (close === -1) {
      // Unclosed, and so is every later opening tag of this name.
      closable[pick] = false;
      continue;
    }
    const end = close + name.length + 3;
    blocks.push({ name, inner: xml.slice(innerStart, close), start, end });
    pos = end;
  }
}

/** Parses an S3 `ListVersionsResult` document. Throws if it is not one. */
export function parseListVersions(xml: string): ListingPage {
  if (!/<ListVersionsResult[\s>]/.test(xml)) {
    throw new Error('not a ListVersionsResult document');
  }
  const blocks = xmlBlocks(xml, ['Version', 'DeleteMarker']);
  const entries: ListingEntry[] = [];
  for (const block of blocks) {
    const key = xmlField(block.inner, 'Key');
    const versionId = xmlField(block.inner, 'VersionId');
    const lastModified = xmlField(block.inner, 'LastModified');
    if (key === null || versionId === null || lastModified === null) {
      throw new Error(
        `a ${block.name} entry is missing Key, VersionId or LastModified`,
      );
    }
    entries.push({
      key,
      versionId,
      lastModified,
      deleteMarker: block.name === 'DeleteMarker',
    });
  }
  let top = '';
  let cursor = 0;
  for (const block of blocks) {
    top += xml.slice(cursor, block.start);
    cursor = block.end;
  }
  top += xml.slice(cursor);
  const truncated = xmlField(top, 'IsTruncated');
  if (truncated !== 'true' && truncated !== 'false') {
    throw new Error('IsTruncated is missing');
  }
  return {
    isTruncated: truncated === 'true',
    prefix: xmlField(top, 'Prefix') ?? '',
    keyMarker: xmlField(top, 'KeyMarker') ?? '',
    nextKeyMarker: xmlField(top, 'NextKeyMarker'),
    entries,
  };
}

// ── URL checks (SPEC step 1) ─────────────────────────────────────────────────

/** Why a URL does not go where the stream requires, or null when it does. */
export function checkListingUrl(
  raw: string,
  page: number,
  manifest: Pick<Manifest, 'bucket' | 'region' | 'prefix'>,
): string | null {
  const base = checkHost(raw, manifest);
  if (typeof base === 'string') return base;
  const url = base;
  if (url.pathname !== '/') return `path is ${url.pathname}, not /`;
  const params = url.searchParams;
  if (!params.has('versions')) return 'it is not a version listing';
  for (const forbidden of ['delimiter', 'version-id-marker', 'encoding-type']) {
    if (params.has(forbidden)) return `it sets ${forbidden}`;
  }
  const prefixes = params.getAll('prefix');
  if (prefixes.length !== 1 || prefixes[0] !== manifest.prefix) {
    return `it lists ${JSON.stringify(prefixes.join(','))}, not the stream ${JSON.stringify(manifest.prefix)}`;
  }
  const markers = params.getAll('key-marker');
  const expected =
    page === 0 ? null : checkpointKey(manifest.prefix, page * LIST_PAGE_SEQS);
  if (
    expected === null
      ? markers.length !== 0
      : markers.length !== 1 || markers[0] !== expected
  ) {
    return `page ${page + 1} starts at ${JSON.stringify(markers.join(',') || '(the beginning)')}, not ${JSON.stringify(expected ?? '(the beginning)')}`;
  }
  return null;
}

export function checkObjectUrl(
  raw: string,
  seq: number,
  manifest: Pick<Manifest, 'bucket' | 'region' | 'prefix'>,
): string | null {
  const base = checkHost(raw, manifest);
  if (typeof base === 'string') return base;
  const expected = checkpointKey(manifest.prefix, seq);
  let key: string;
  try {
    key = base.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
  } catch {
    return 'its path is not valid percent-encoding';
  }
  if (!base.pathname.startsWith('/') || key !== expected) {
    return `it reads ${JSON.stringify(key)}, not ${JSON.stringify(expected)}`;
  }
  return null;
}

const KEY_ID = /^[0-9a-f]{16}$/;

/** Why a URL does not list the Verifier keys, or null when it does. */
export function checkKeysListingUrl(
  raw: string,
  manifest: Pick<Manifest, 'bucket' | 'region'>,
): string | null {
  const base = checkHost(raw, manifest);
  if (typeof base === 'string') return base;
  if (base.pathname !== '/') return `path is ${base.pathname}, not /`;
  const params = base.searchParams;
  if (!params.has('versions')) return 'it is not a version listing';
  for (const forbidden of [
    'delimiter',
    'version-id-marker',
    'encoding-type',
    'key-marker',
  ]) {
    if (params.has(forbidden)) return `it sets ${forbidden}`;
  }
  const prefixes = params.getAll('prefix');
  if (prefixes.length !== 1 || prefixes[0] !== KEYS_PREFIX) {
    return `it lists ${JSON.stringify(prefixes.join(','))}, not the keys ${JSON.stringify(KEYS_PREFIX)}`;
  }
  return null;
}

/** Why a URL does not read the named key object, or null when it does. */
export function checkKeyUrl(
  raw: string,
  keyId: string,
  manifest: Pick<Manifest, 'bucket' | 'region'>,
): string | null {
  if (!KEY_ID.test(keyId)) return `${JSON.stringify(keyId)} is not a key id`;
  const base = checkHost(raw, manifest);
  if (typeof base === 'string') return base;
  const expected = `${KEYS_PREFIX}${keyId}.json`;
  let key: string;
  try {
    key = base.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
  } catch {
    return 'its path is not valid percent-encoding';
  }
  if (!base.pathname.startsWith('/') || key !== expected) {
    return `it reads ${JSON.stringify(key)}, not ${JSON.stringify(expected)}`;
  }
  return null;
}

function checkHost(
  raw: string,
  manifest: Pick<Manifest, 'bucket' | 'region'>,
): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'it is not a URL';
  }
  const host = `${manifest.bucket}.s3.${manifest.region}.amazonaws.com`;
  if (url.protocol !== 'https:') return `it uses ${url.protocol}, not https`;
  if (url.username !== '' || url.password !== '')
    return 'it carries credentials';
  if (url.hostname !== host) return `it goes to ${url.hostname}, not ${host}`;
  if (url.port !== '' && url.port !== '443') return `it uses port ${url.port}`;
  return url;
}

// ── Checkpoint bodies (SPEC step 3) ──────────────────────────────────────────

interface RecordLeaf {
  id: string;
  sha256: string;
}
interface DisposalLeaf extends RecordLeaf {
  checkpoint_seq: number;
}
type ParsedCheckpoint =
  | { kind: 'records'; previous: string | null; leaves: RecordLeaf[] }
  | {
      kind: 'disposal';
      previous: string | null;
      reason: DisposalReason;
      retentionDays: number | null;
      leaves: DisposalLeaf[];
    }
  | { kind: 'heartbeat'; previous: string | null; leaves: [] };

const REASONS: ReadonlySet<string> = new Set([
  'retention',
  'owner_purge',
  'organization_deletion',
  'unattributed',
]);

function parseCheckpoint(
  text: string,
  manifest: Manifest,
  seq: number,
): ParsedCheckpoint | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'it is not JSON';
  }
  if (!isObject(value)) return 'it is not a JSON object';
  if (value.format !== FORMAT)
    return `format is ${JSON.stringify(value.format)}`;
  if (value.generation !== manifest.generation)
    return 'it names another generation';
  if (value.stream !== manifest.stream) return 'it names another stream';
  if (value.seq !== seq) return `it says seq ${JSON.stringify(value.seq)}`;
  const previous = value.previous_sha256;
  if (
    seq === 1
      ? previous !== null
      : typeof previous !== 'string' || !HEX64.test(previous)
  ) {
    return 'previous_sha256 is malformed';
  }
  if (parseTime(value.written_at) === null) return 'written_at is malformed';
  if (!Array.isArray(value.leaves)) return 'leaves is missing';
  const leaves = value.leaves as unknown[];
  const prev = previous as string | null;
  switch (value.kind) {
    case 'records': {
      const out: RecordLeaf[] = [];
      for (const leaf of leaves) {
        if (
          !isObject(leaf) ||
          typeof leaf.id !== 'string' ||
          leaf.id === '' ||
          typeof leaf.sha256 !== 'string' ||
          !HEX64.test(leaf.sha256)
        ) {
          return 'a leaf is malformed';
        }
        out.push({ id: leaf.id, sha256: leaf.sha256 });
      }
      return { kind: 'records', previous: prev, leaves: out };
    }
    case 'disposal': {
      const reason = value.reason;
      const days = value.retention_days;
      if (typeof reason !== 'string' || !REASONS.has(reason))
        return 'reason is malformed';
      if (!(days === null || isPositiveInt(days)))
        return 'retention_days is malformed';
      if ((reason === 'retention') !== (days !== null)) {
        return 'retention_days does not match the reason';
      }
      const out: DisposalLeaf[] = [];
      for (const leaf of leaves) {
        if (
          !isObject(leaf) ||
          typeof leaf.id !== 'string' ||
          leaf.id === '' ||
          typeof leaf.sha256 !== 'string' ||
          !HEX64.test(leaf.sha256) ||
          !isPositiveInt(leaf.checkpoint_seq) ||
          leaf.checkpoint_seq >= seq
        ) {
          return 'a leaf is malformed';
        }
        out.push({
          id: leaf.id,
          sha256: leaf.sha256,
          checkpoint_seq: leaf.checkpoint_seq,
        });
      }
      return {
        kind: 'disposal',
        previous: prev,
        reason: reason as DisposalReason,
        retentionDays: days as number | null,
        leaves: out,
      };
    }
    case 'heartbeat':
      if (leaves.length !== 0) return 'a heartbeat has leaves';
      return { kind: 'heartbeat', previous: prev, leaves: [] };
    default:
      return `kind is ${JSON.stringify(value.kind)}`;
  }
}

// ── State ────────────────────────────────────────────────────────────────────

interface StateFile {
  format: 1;
  streams: Record<string, SavedStream>;
}

function cloneStream(stream: SavedStream): SavedStream {
  return { ...stream, checkpoints: { ...stream.checkpoints } };
}

/** Saved checkpoints held in memory; `initial` is a state file's `streams`. */
export function memoryState(
  initial: Record<string, SavedStream> = {},
): StateStore {
  const streams: Record<string, SavedStream> = {};
  for (const [key, s] of Object.entries(initial)) streams[key] = cloneStream(s);
  return {
    async load(key) {
      return streams[key] ? cloneStream(streams[key]) : null;
    },
    async save(key, stream) {
      streams[key] = cloneStream(stream);
    },
    async all() {
      const out: Record<string, SavedStream> = {};
      for (const [key, s] of Object.entries(streams)) out[key] = cloneStream(s);
      return out;
    },
  };
}

/**
 * Saved checkpoints in browser storage (one JSON value under `storageKey`, in
 * the same shape as the Go command's state file). Storage can be missing or
 * full; every access is guarded, so verification still runs without it.
 */
export function storageState(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  storageKey: string = DEFAULT_STORAGE_KEY,
): StateStore {
  const read = (): StateFile => {
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return { format: 1, streams: {} };
      const parsed = JSON.parse(raw) as unknown;
      if (isObject(parsed) && isObject(parsed.streams)) {
        return {
          format: 1,
          streams: parsed.streams as Record<string, SavedStream>,
        };
      }
    } catch {
      // Unreadable storage is treated as empty.
    }
    return { format: 1, streams: {} };
  };
  return {
    async load(key) {
      const s = read().streams[key];
      return s ? cloneStream(s) : null;
    },
    async save(key, stream) {
      const file = read();
      file.streams[key] = cloneStream(stream);
      try {
        storage.setItem(storageKey, JSON.stringify(file));
      } catch {
        throw new Error('browser storage refused the saved checkpoints');
      }
    },
    async all() {
      return read().streams;
    },
  };
}

export function stateKey(
  bucket: string,
  generation: string,
  stream: string,
): string {
  return `${bucket}/${generation}/${stream}`;
}

// ── Verification ─────────────────────────────────────────────────────────────

interface Fetched {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

async function fetchLimited(
  fetchImpl: typeof fetch,
  url: string,
  limit: number,
): Promise<Fetched> {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
  });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(`response is larger than ${limit} bytes`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit)
    throw new Error(`response is larger than ${limit} bytes`);
  return { status: response.status, headers: response.headers, bytes };
}

class Findings {
  private readonly list: Finding[] = [];
  private readonly seen = new Set<string>();

  add(
    code: FindingCode,
    message: string,
    seq: number | null = null,
    recordId: string | null = null,
    keyId: string | null = null,
  ): void {
    const id = `${code}|${seq ?? ''}|${recordId ?? ''}|${keyId ?? ''}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const severity = severityOf(code);
    const finding: Finding = {
      code,
      fails: severity === 'fail',
      severity,
      seq,
      record_id: recordId,
      message,
    };
    if (keyId !== null) finding.key_id = keyId;
    this.list.push(finding);
  }

  /** A finding about one Verifier key. */
  addKey(code: FindingCode, message: string, keyId: string): void {
    this.add(code, message, null, null, keyId);
  }

  has(code: FindingCode): boolean {
    return this.list.some((f) => f.code === code);
  }

  problemAt(seq: number): boolean {
    return this.list.some(
      (f) => f.seq === seq && CHECKPOINT_PROBLEMS.has(f.code),
    );
  }

  /** Failures first, then by seq, record id and code (byte order, as in Go). */
  sorted(): Finding[] {
    const rank: Record<Severity, number> = { fail: 0, warning: 1, info: 2 };
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...this.list].sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        (a.seq ?? 0) - (b.seq ?? 0) ||
        cmp(a.record_id ?? '', b.record_id ?? '') ||
        cmp(a.key_id ?? '', b.key_id ?? '') ||
        cmp(a.code, b.code),
    );
  }
}

interface Listed {
  versionId: string;
  uploadedMs: number;
}

interface ReadCheckpoint {
  sha256: string;
  parsed: ParsedCheckpoint | null;
  lockExpiryMs: number | null;
}

function emptyReport(manifest: Manifest): Report {
  return {
    ok: false,
    stream: {
      bucket: manifest.bucket,
      region: manifest.region,
      generation: manifest.generation,
      organization: manifest.stream,
    },
    checkpoints: {
      count: 0,
      first_uploaded_at: null,
      last_uploaded_at: null,
      earliest_lock_expiry: null,
      by_kind: { records: 0, disposal: 0, heartbeat: 0 },
    },
    counts: { ok: 0, pending: 0, deleted: 0, missing: 0, tampered: 0 },
    signatures: { valid: 0, unsigned: 0, unverified: 0, invalid: 0 },
    records: [],
    findings: [],
  };
}

function finish(report: Report, findings: Findings): Report {
  report.findings = findings.sorted();
  report.ok = !report.findings.some((f) => f.fails);
  for (const r of report.records) {
    report.counts[r.status] += 1;
    if (r.signature) report.signatures[r.signature] += 1;
  }
  return report;
}

function diffRecords(nowText: string, wasText: string): FieldDiff[] | null {
  let now: unknown;
  let was: unknown;
  try {
    now = JSON.parse(nowText);
    was = JSON.parse(wasText);
  } catch {
    return null;
  }
  if (!isObject(now) || !isObject(was)) return null;
  const fields = [
    ...Object.keys(was),
    ...Object.keys(now).filter((k) => !Object.hasOwn(was, k)),
  ];
  const out: FieldDiff[] = [];
  for (const field of fields) {
    const a = Object.hasOwn(now, field) ? now[field] : null;
    const b = Object.hasOwn(was, field) ? was[field] : null;
    if (!deepEqual(a, b)) out.push({ field, now: a, was: b });
  }
  return out;
}

/** Describes a diff the way the reports print it. */
export function describeDiff(diff: FieldDiff[]): string {
  return diff
    .map(
      (d) =>
        `${d.field} is ${compactJson(d.now)}, was checkpointed as ${compactJson(d.was)}`,
    )
    .join('; ');
}

// ── Verifier keys and signatures (SPEC "Signed records", step 2b) ───────────

const KEY_FILE = /^[0-9a-f]{16}\.json$/;
const SIGNATURE = /^ed25519:([0-9a-f]{16}):([0-9a-f]{128})$/;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

/**
 * A Verifier key's id: the first 16 hex characters of the SHA-256 of its
 * 32-byte public key.
 */
export async function keyId(publicKey: Uint8Array): Promise<string> {
  return (await sha256Hex(publicKey)).slice(0, 16);
}

interface TrustedKey {
  publicKey: CryptoKey;
  uploadedMs: number;
}

/**
 * Reads the Verifier keys the manifest names and returns the trusted ones by
 * key id. Throws only when the keys listing cannot be fetched or parsed.
 */
async function readKeys(
  fetchImpl: typeof fetch,
  m: Manifest,
  findings: Findings,
): Promise<Map<string, TrustedKey>> {
  const trusted = new Map<string, TrustedKey>();
  if (!m.keys) return trusted;
  let fetched: Fetched;
  try {
    fetched = await fetchLimited(fetchImpl, m.keys.listing, MAX_LISTING_BYTES);
  } catch (error) {
    throw new Error(
      `the keys listing could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (fetched.status !== 200) {
    const hint =
      fetched.status === 403
        ? ` (the export's links expire at ${m.urls_expire_at}; export again if they have expired)`
        : '';
    throw new Error(`the keys listing returned HTTP ${fetched.status}${hint}`);
  }
  let listing: ListingPage;
  try {
    listing = parseListVersions(new TextDecoder().decode(fetched.bytes));
  } catch (error) {
    throw new Error(
      `the keys listing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (listing.isTruncated) {
    findings.add(
      'listing_incomplete',
      'The keys listing was cut off, so some key objects were not seen.',
    );
  }
  const byKey = new Map<
    string,
    { versions: ListingEntry[]; markers: ListingEntry[] }
  >();
  const unexpected = new Set<string>();
  for (const entry of listing.entries) {
    const name = entry.key.startsWith(KEYS_PREFIX)
      ? entry.key.slice(KEYS_PREFIX.length)
      : null;
    if (name === null || !KEY_FILE.test(name)) {
      unexpected.add(entry.key);
      continue;
    }
    let slot = byKey.get(entry.key);
    if (!slot) {
      slot = { versions: [], markers: [] };
      byKey.set(entry.key, slot);
    }
    (entry.deleteMarker ? slot.markers : slot.versions).push(entry);
  }
  for (const key of [...unexpected].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    findings.add(
      'unexpected_key',
      `The keys folder holds an object that is not a key: ${key}.`,
    );
  }

  for (const k of m.keys.objects) {
    const invalid = (why: string) =>
      findings.addKey(
        'key_invalid',
        `Verifier key ${k.key_id} cannot be trusted: ${why}.`,
        k.key_id,
      );
    const slot = byKey.get(`${KEYS_PREFIX}${k.key_id}.json`);
    if (!slot || slot.versions.length === 0) {
      invalid('it is not in the bucket');
      continue;
    }
    if (slot.markers.length > 0) {
      invalid('it has a delete marker on top of it');
      continue;
    }
    if (slot.versions.length > 1) {
      invalid(
        `it has ${slot.versions.length} versions, and a key is written once`,
      );
      continue;
    }
    const version = slot.versions[0];
    const uploadedMs = parseTime(version.lastModified);
    if (uploadedMs === null) {
      invalid('its upload time cannot be read');
      continue;
    }
    let got: Fetched;
    try {
      got = await fetchLimited(fetchImpl, k.url, MAX_OBJECT_BYTES);
    } catch (error) {
      invalid(
        `it could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (got.status !== 200) {
      invalid(`it could not be read (HTTP ${got.status})`);
      continue;
    }
    if (got.headers.get('x-amz-version-id') !== version.versionId) {
      invalid('it was read as a version other than its original');
      continue;
    }
    if (
      got.headers.get('x-amz-object-lock-mode') !== 'COMPLIANCE' ||
      parseTime(got.headers.get('x-amz-object-lock-retain-until-date')) === null
    ) {
      invalid('it has no compliance lock');
      continue;
    }
    const publicKey = await parseKeyObject(got.bytes, k.key_id);
    if (typeof publicKey === 'string') {
      invalid(publicKey);
      continue;
    }
    trusted.set(k.key_id, { publicKey, uploadedMs });
  }
  return trusted;
}

/** Reads a key object; a string says why it is not one for `name`. */
async function parseKeyObject(
  bytes: Uint8Array,
  name: string,
): Promise<CryptoKey | string> {
  let fields: unknown;
  try {
    fields = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return 'it is not a key object';
  }
  if (!isObject(fields)) return 'it is not a key object';
  if (
    fields.format !== FORMAT ||
    fields.kind !== 'verifier-audit-key' ||
    fields.algorithm !== 'ed25519'
  ) {
    return 'it is not a format 1 Ed25519 key object';
  }
  if (fields.key_id !== name) {
    return `it names key ${JSON.stringify(typeof fields.key_id === 'string' ? fields.key_id : '')}`;
  }
  if (typeof fields.public_key !== 'string' || !HEX64.test(fields.public_key)) {
    return 'its public key is not 64 lowercase hex characters';
  }
  const raw = fromHex(fields.public_key);
  if ((await keyId(raw)) !== name) {
    return 'its public key does not match its key id';
  }
  try {
    return await crypto.subtle.importKey(
      'raw',
      raw as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    return 'its public key is not an Ed25519 key';
  }
}

/** The signed record's fields in order, with their JSON types. */
const SIGNED_FIELDS: ReadonlyArray<[string, 'n' | 's' | 's?' | 'a']> = [
  ['format', 'n'],
  ['key_id', 's'],
  ['id', 's'],
  ['agent_id', 's'],
  ['direction', 's'],
  ['sender_id', 's'],
  ['recipient_id', 's'],
  ['timestamp', 's'],
  ['message_hash', 's'],
  ['attestation_level', 's'],
  ['correlation_id', 's?'],
  ['event_type', 's'],
  ['response_level', 's'],
  ['policy_checks', 'a'],
  ['archive_ref', 's?'],
  ['archive_sha256', 's?'],
  ['verifier_id', 's'],
  ['signed_at', 's'],
];

/** Signed fields compared exactly with the record's. */
const COMPARED_STRINGS: ReadonlySet<string> = new Set([
  'id',
  'agent_id',
  'direction',
  'sender_id',
  'recipient_id',
  'attestation_level',
  'correlation_id',
  'event_type',
  'response_level',
  'archive_ref',
  'verifier_id',
]);

interface SignedPolicyCheck {
  policy_id: string | null;
  decision: string | null;
  response_level: string | null;
  severity: string | null;
}

function signedChecks(value: unknown): SignedPolicyCheck[] | null {
  if (!Array.isArray(value)) return null;
  const out: SignedPolicyCheck[] = [];
  for (const item of value) {
    if (!isObject(item)) return null;
    const check: Record<string, string | null> = {};
    for (const name of [
      'policy_id',
      'decision',
      'response_level',
      'severity',
    ]) {
      if (!Object.hasOwn(item, name)) return null;
      const v = item[name];
      if (typeof v !== 'string' && v !== null) return null;
      check[name] = v;
    }
    out.push(check as unknown as SignedPolicyCheck);
  }
  return out;
}

/**
 * The record's policy checks projected onto the signed fields. Spellguard
 * stores most records' checks as a JSON string holding the array, so a string
 * is parsed first.
 */
function recordChecks(stored: unknown): SignedPolicyCheck[] | null {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || !value.every(isObject)) return null;
  const str = (item: Record<string, unknown>, name: string) =>
    typeof item[name] === 'string' ? (item[name] as string) : null;
  return (value as Record<string, unknown>[]).map((item) => ({
    policy_id: str(item, 'policyId'),
    decision: str(item, 'decision'),
    response_level: str(item, 'responseLevel'),
    severity: str(item, 'severity'),
  }));
}

function parseSignedRecord(text: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'it is not a JSON object';
  }
  if (!isObject(value)) return 'it is not a JSON object';
  for (const [name, kind] of SIGNED_FIELDS) {
    if (!Object.hasOwn(value, name)) return `it has no ${name}`;
    const v = value[name];
    if (kind === 'n' && v !== FORMAT) return 'it is not format 1';
    if (kind === 's' && typeof v !== 'string') return `${name} is not a string`;
    if (kind === 's?' && typeof v !== 'string' && v !== null) {
      return `${name} is not a string or null`;
    }
    if (kind === 'a' && signedChecks(v) === null) {
      return 'policy_checks is not a list of signed policy checks';
    }
  }
  return value;
}

/** Each signed field whose value differs from the record's, in order. */
function compareSigned(
  record: Record<string, unknown>,
  signed: Record<string, unknown>,
): FieldDiff[] {
  const value = (o: Record<string, unknown>, name: string) =>
    Object.hasOwn(o, name) ? o[name] : null;
  const optString = (v: unknown): { ok: boolean; s: string | null } =>
    typeof v === 'string'
      ? { ok: true, s: v }
      : v === null
        ? { ok: true, s: null }
        : { ok: false, s: null };
  const diff: FieldDiff[] = [];
  for (const [name] of SIGNED_FIELDS) {
    const a = Object.hasOwn(record, name)
      ? optString(record[name])
      : { ok: false, s: null };
    const b = optString(signed[name]);
    if (COMPARED_STRINGS.has(name)) {
      if (!a.ok || a.s !== b.s) {
        diff.push({ field: name, now: value(record, name), was: signed[name] });
      }
    } else if (name === 'message_hash') {
      if (
        !a.ok ||
        a.s === null ||
        b.s === null ||
        a.s.toLowerCase() !== b.s.toLowerCase()
      ) {
        diff.push({ field: name, now: value(record, name), was: signed[name] });
      }
    } else if (name === 'timestamp') {
      const x = a.ok ? parseTime(a.s) : null;
      const y = parseTime(b.s);
      if (x === null || y === null || x !== y) {
        diff.push({ field: name, now: value(record, name), was: signed[name] });
      }
    } else if (name === 'policy_checks') {
      const was = signedChecks(signed[name]) ?? [];
      const now = recordChecks(record[name]);
      const same =
        now !== null &&
        now.length === was.length &&
        now.every(
          (c, i) =>
            c.policy_id === was[i].policy_id &&
            c.decision === was[i].decision &&
            c.response_level === was[i].response_level &&
            c.severity === was[i].severity,
        );
      if (!same) {
        diff.push({
          field: name,
          now: now ?? value(record, name),
          was,
        });
      }
    }
  }
  return diff;
}

/** Describes a signed-field diff the way the reports print it. */
export function describeSignedDiff(diff: FieldDiff[]): string {
  return diff
    .map(
      (d) =>
        `${d.field} is ${compactJson(d.now)}, was signed as ${compactJson(d.was)}`,
    )
    .join('; ');
}

interface SignatureOutcome {
  state: SignatureState;
  keyId?: string;
  code?: FindingCode;
  message?: string;
  diff?: FieldDiff[];
}

/** Applies SPEC.md's signature table to one exported record. */
async function checkSignature(
  record: Record<string, unknown>,
  signedText: string | undefined,
  keys: Map<string, TrustedKey>,
): Promise<SignatureOutcome> {
  const signature = record.verifier_signature;
  const match =
    typeof signature === 'string' ? SIGNATURE.exec(signature) : null;
  if (!match) return { state: 'unsigned' };
  const id = match[1];
  const invalid = (code: FindingCode, message: string): SignatureOutcome => ({
    state: 'invalid',
    keyId: id,
    code,
    message,
  });
  if (signedText === undefined) {
    return invalid(
      'signed_record_missing',
      `Signed with Verifier key ${id}, but the export does not include what was signed.`,
    );
  }
  const signed = parseSignedRecord(signedText);
  if (typeof signed === 'string') {
    return invalid(
      'signature_invalid',
      `The signed record is not valid: ${signed}.`,
    );
  }
  if (signed.key_id !== id) {
    return invalid(
      'signature_invalid',
      `The signature names key ${id}, but the signed record names key ${signed.key_id}.`,
    );
  }
  const key = keys.get(id);
  if (!key) {
    return {
      state: 'unverified',
      keyId: id,
      code: 'signature_key_unknown',
      message: `Signed with Verifier key ${id}, which the export does not hold or which cannot be trusted, so the signature was not checked.`,
    };
  }
  const verified = await crypto.subtle.verify(
    'Ed25519',
    key.publicKey,
    fromHex(match[2]) as BufferSource,
    new TextEncoder().encode(signedText) as BufferSource,
  );
  if (!verified) {
    return invalid(
      'signature_invalid',
      'The signature does not match the signed record: one of them was changed after signing.',
    );
  }
  const diff = compareSigned(record, signed);
  if (diff.length > 0) {
    return {
      ...invalid(
        'signed_field_mismatch',
        `Changed after the Verifier signed it: ${describeSignedDiff(diff)}.`,
      ),
      diff,
    };
  }
  const at = parseTime(signed.timestamp);
  if (at === null || at < key.uploadedMs) {
    return {
      state: 'unverified',
      keyId: id,
      code: 'signature_predates_key',
      message: `Signed with Verifier key ${id}, published ${new Date(key.uploadedMs).toISOString()}, after this record's time ${String(signed.timestamp)}, so the key cannot vouch for it.`,
    };
  }
  return { state: 'valid', keyId: id };
}

/** Verifies an export. Throws only when the bundle cannot be verified at all. */
export async function verify(
  bundle: Bundle,
  opts: VerifyOptions,
): Promise<Report> {
  validateManifest(bundle.manifest);
  const m = bundle.manifest;
  const now = (opts.now ?? new Date()).getTime();
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const concurrency =
    opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 8;
  const report = emptyReport(m);
  const findings = new Findings();
  const host = `${m.bucket}.s3.${m.region}.amazonaws.com`;

  // 1. Where the URLs go.
  if (!opts.allowedBuckets.includes(m.bucket)) {
    findings.add(
      'bucket_not_allowed',
      `The export points at bucket ${JSON.stringify(m.bucket)}, which is not an allowed bucket (${opts.allowedBuckets.join(', ') || 'none'}). Allow it only if you know it holds Spellguard's checkpoints for your environment.`,
    );
    return finish(report, findings);
  }
  if (!/^[a-z0-9-]+$/.test(m.region)) {
    findings.add(
      'url_mismatch',
      `The export names region ${JSON.stringify(m.region)}, which is not an AWS region.`,
    );
    return finish(report, findings);
  }
  const expectedPrefix = streamPrefix(m.generation, m.stream);
  if (m.prefix !== expectedPrefix) {
    findings.add(
      'url_mismatch',
      `The export's prefix ${JSON.stringify(m.prefix)} is not this stream's (${JSON.stringify(expectedPrefix)}).`,
    );
    return finish(report, findings);
  }
  m.listing.forEach((url, page) => {
    const why = checkListingUrl(url, page, m);
    if (why)
      findings.add(
        'url_mismatch',
        `Listing page ${page + 1} does not list this stream at ${host}: ${why}.`,
      );
  });
  for (const c of m.checkpoints) {
    const why = checkObjectUrl(c.url, c.seq, m);
    if (why)
      findings.add(
        'url_mismatch',
        `The link for checkpoint ${c.seq} does not read it from ${host}: ${why}.`,
        c.seq,
      );
  }
  if (m.keys) {
    const why = checkKeysListingUrl(m.keys.listing, m);
    if (why) {
      findings.add(
        'url_mismatch',
        `The keys listing does not list the Verifier keys at ${host}: ${why}.`,
      );
    }
    for (const k of m.keys.objects) {
      const keyWhy = checkKeyUrl(k.url, k.key_id, m);
      if (keyWhy) {
        findings.addKey(
          'url_mismatch',
          `The link for Verifier key ${k.key_id} does not read it from ${host}: ${keyWhy}.`,
          k.key_id,
        );
      }
    }
  }
  if (findings.has('url_mismatch')) return finish(report, findings);

  // 2. List the stream.
  const entries = new Map<string, ListingEntry>();
  const pages: ListingPage[] = [];
  for (let page = 0; page < m.listing.length; page++) {
    let fetched: Fetched;
    try {
      fetched = await fetchLimited(
        fetchImpl,
        m.listing[page],
        MAX_LISTING_BYTES,
      );
    } catch (error) {
      throw new Error(
        `listing page ${page + 1} could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (fetched.status !== 200) {
      const hint =
        fetched.status === 403
          ? ` (the export's links expire at ${m.urls_expire_at}; export again if they have expired)`
          : '';
      throw new Error(
        `listing page ${page + 1} returned HTTP ${fetched.status}${hint}`,
      );
    }
    const listing = parseListVersions(new TextDecoder().decode(fetched.bytes));
    pages.push(listing);
    for (const entry of listing.entries) {
      entries.set(
        `${entry.deleteMarker ? 'D' : 'V'}|${entry.key}|${entry.versionId}`,
        entry,
      );
    }
  }
  pages.forEach((listing, page) => {
    if (!listing.isTruncated) return;
    const last = page === pages.length - 1;
    const nextStart = last
      ? null
      : checkpointKey(m.prefix, (page + 1) * LIST_PAGE_SEQS);
    if (
      last ||
      listing.nextKeyMarker === null ||
      !(listing.nextKeyMarker > (nextStart as string))
    ) {
      findings.add(
        'listing_incomplete',
        last
          ? 'The last listing page was cut off, so some objects in the stream were not seen. A stream holds one version per checkpoint; more than the page can hold means objects were added.'
          : `Listing page ${page + 1} stopped before page ${page + 2} begins, so some versions were not seen. A stream holds one version per checkpoint; more than the page can hold means versions were added.`,
      );
    }
  });

  const byKey = new Map<
    string,
    { versions: ListingEntry[]; markers: ListingEntry[] }
  >();
  for (const entry of entries.values()) {
    let slot = byKey.get(entry.key);
    if (!slot) {
      slot = { versions: [], markers: [] };
      byKey.set(entry.key, slot);
    }
    (entry.deleteMarker ? slot.markers : slot.versions).push(entry);
  }
  const listed = new Map<number, Listed>();
  for (const [key, slot] of [...byKey.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const name = key.startsWith(m.prefix)
      ? SEQ_FILE.exec(key.slice(m.prefix.length))
      : null;
    const seq = name ? Number(name[1]) : 0;
    if (seq < 1) {
      findings.add(
        'unexpected_key',
        `The stream's folder holds an object that is not a checkpoint: ${key}.`,
      );
      continue;
    }
    if (slot.markers.length > 0) {
      findings.add(
        'delete_marker',
        `Checkpoint ${seq} has a delete marker on top of it. A locked version cannot be deleted, so this hides it rather than removing it.`,
        seq,
      );
    }
    if (slot.versions.length > 1) {
      findings.add(
        'extra_version',
        `Checkpoint ${seq} has ${slot.versions.length} versions. A checkpoint is written once; any other version was added on top of the locked original.`,
        seq,
      );
    }
    let oldest: ListingEntry | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const v of slot.versions) {
      const ms = parseTime(v.lastModified) ?? Number.POSITIVE_INFINITY;
      if (oldest === null || ms < oldestMs) {
        oldest = v;
        oldestMs = ms;
      }
    }
    if (oldest)
      listed.set(seq, { versionId: oldest.versionId, uploadedMs: oldestMs });
  }
  const listedSeqs = [...listed.keys()].sort((a, b) => a - b);
  const maxListed = listedSeqs.length ? listedSeqs[listedSeqs.length - 1] : 0;
  for (let seq = 1; seq <= maxListed; seq++) {
    if (!listed.has(seq))
      findings.add(
        'checkpoint_missing',
        `Checkpoint ${seq} is not in the bucket.`,
        seq,
      );
  }

  // 2b. The Verifier keys.
  const verifierKeys = await readKeys(fetchImpl, m, findings);

  // 3. Read and chain the checkpoints.
  const manifestBySeq = new Map(m.checkpoints.map((c) => [c.seq, c]));
  const maxManifest = m.checkpoints.reduce((max, c) => Math.max(max, c.seq), 0);
  for (const c of m.checkpoints) {
    if (!listed.has(c.seq))
      findings.add(
        'checkpoint_missing',
        `Checkpoint ${c.seq} is not in the bucket.`,
        c.seq,
      );
  }
  const toRead: number[] = [];
  for (const seq of listedSeqs) {
    if (seq > maxManifest) continue;
    if (manifestBySeq.has(seq)) toRead.push(seq);
    else {
      findings.add(
        'checkpoint_not_exported',
        `Checkpoint ${seq} is in the bucket, but the export has no link to read it.`,
        seq,
      );
    }
  }
  const beyond = listedSeqs.filter((seq) => seq > maxManifest);
  if (beyond.length > 0) {
    findings.add(
      'checkpoints_beyond_export',
      `${beyond.length} newer checkpoint${beyond.length === 1 ? ' was' : 's were'} uploaded after this export (from ${beyond[0]}). Export again to include ${beyond.length === 1 ? 'it' : 'them'}.`,
      beyond[0],
    );
  }

  const responses = new Map<number, Fetched | Error>();
  await pool(toRead, concurrency, async (seq) => {
    try {
      responses.set(
        seq,
        await fetchLimited(
          fetchImpl,
          (manifestBySeq.get(seq) as ManifestCheckpoint).url,
          MAX_OBJECT_BYTES,
        ),
      );
    } catch (error) {
      responses.set(
        seq,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });

  const read = new Map<number, ReadCheckpoint>();
  for (const seq of toRead) {
    const response = responses.get(seq) as Fetched | Error;
    const entry = manifestBySeq.get(seq) as ManifestCheckpoint;
    const was = listed.get(seq) as Listed;
    if (response instanceof Error) {
      findings.add(
        'checkpoint_unreadable',
        `Checkpoint ${seq} could not be read (${response.message}).`,
        seq,
      );
      continue;
    }
    if (response.status !== 200) {
      findings.add(
        'checkpoint_unreadable',
        `Checkpoint ${seq} could not be read (HTTP ${response.status}).`,
        seq,
      );
      continue;
    }
    const sha256 = await sha256Hex(response.bytes);
    const versionId = response.headers.get('x-amz-version-id');
    if (versionId !== was.versionId) {
      findings.add(
        'version_mismatch',
        `Checkpoint ${seq} was read as version ${versionId ?? '(none)'}, but its original version is ${was.versionId}.`,
        seq,
      );
    }
    const lockMode = response.headers.get('x-amz-object-lock-mode');
    const retainUntil = parseTime(
      response.headers.get('x-amz-object-lock-retain-until-date'),
    );
    let lockExpiryMs: number | null = null;
    if (lockMode !== 'COMPLIANCE' || retainUntil === null) {
      findings.add(
        'not_locked',
        `Checkpoint ${seq} has no compliance lock.`,
        seq,
      );
    } else {
      lockExpiryMs = retainUntil;
    }
    let text: string | null = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
    } catch {
      findings.add(
        'checkpoint_invalid',
        `Checkpoint ${seq} is not valid UTF-8.`,
        seq,
      );
    }
    let parsed: ParsedCheckpoint | null = null;
    if (text !== null) {
      const result = parseCheckpoint(text, m, seq);
      if (typeof result === 'string') {
        findings.add(
          'checkpoint_invalid',
          `Checkpoint ${seq} is not a valid checkpoint: ${result}.`,
          seq,
        );
      } else {
        parsed = result;
      }
    }
    const ledgerProblems: string[] = [];
    if (entry.sha256 !== sha256)
      ledgerProblems.push(`it hashes to ${sha256}, not ${entry.sha256}`);
    if (parsed && entry.kind !== parsed.kind)
      ledgerProblems.push(`it is a ${parsed.kind}, not a ${entry.kind}`);
    if (parsed && entry.leaf_count !== parsed.leaves.length) {
      ledgerProblems.push(
        `it lists ${parsed.leaves.length} records, not ${entry.leaf_count}`,
      );
    }
    if (ledgerProblems.length > 0) {
      findings.add(
        'ledger_mismatch',
        `Spellguard's own record of checkpoint ${seq} disagrees with the bucket: ${ledgerProblems.join('; ')}.`,
        seq,
      );
    }
    read.set(seq, { sha256, parsed, lockExpiryMs });
  }

  for (const [seq, checkpoint] of read) {
    if (!checkpoint.parsed || seq === 1) continue;
    const previous = read.get(seq - 1);
    if (previous && checkpoint.parsed.previous !== previous.sha256) {
      findings.add(
        'chain_broken',
        `Checkpoint ${seq} does not link to checkpoint ${seq - 1}: it names ${checkpoint.parsed.previous}, but checkpoint ${seq - 1} hashes to ${previous.sha256}.`,
        seq,
      );
    }
  }

  // Summary of the stream.
  let first: number | null = null;
  let last: number | null = null;
  for (const l of listed.values()) {
    if (!Number.isFinite(l.uploadedMs)) continue;
    first = first === null ? l.uploadedMs : Math.min(first, l.uploadedMs);
    last = last === null ? l.uploadedMs : Math.max(last, l.uploadedMs);
  }
  let earliestLock: number | null = null;
  for (const c of read.values()) {
    if (c.lockExpiryMs !== null)
      earliestLock =
        earliestLock === null
          ? c.lockExpiryMs
          : Math.min(earliestLock, c.lockExpiryMs);
    if (c.parsed) report.checkpoints.by_kind[c.parsed.kind] += 1;
  }
  report.checkpoints.count = listed.size;
  report.checkpoints.first_uploaded_at = isoOrNull(first);
  report.checkpoints.last_uploaded_at = isoOrNull(last);
  report.checkpoints.earliest_lock_expiry = isoOrNull(earliestLock);
  if (last !== null && now - last > STALE_AFTER_MS) {
    const hours = Math.floor((now - last) / 3_600_000);
    findings.add(
      'stream_stale',
      `The newest checkpoint was uploaded ${hours} hours ago. Checkpoints have stopped, so records since then are not protected; older ones still are.`,
    );
  }

  // 4. Saved checkpoints.
  const key = stateKey(m.bucket, m.generation, m.stream);
  let saved: SavedStream | null = null;
  if (opts.state) {
    saved = await opts.state.load(key);
    if (saved) {
      const entriesSaved = Object.entries(saved.checkpoints).sort(
        ([a], [b]) => Number(a) - Number(b),
      );
      for (const [seqText, hash] of entriesSaved) {
        const seq = Number(seqText);
        if (!listed.has(seq)) {
          findings.add(
            'saved_checkpoint_gone',
            `Checkpoint ${seq}, which you verified on ${saved.verified_at}, is no longer in the bucket.`,
            seq,
          );
          continue;
        }
        const now = read.get(seq);
        if (now && now.sha256 !== hash) {
          findings.add(
            'saved_checkpoint_changed',
            `Checkpoint ${seq} no longer matches the copy you verified on ${saved.verified_at}.`,
            seq,
          );
        }
      }
    }
    const everything = await opts.state.all();
    for (const [otherKey, other] of Object.entries(everything)) {
      if (
        otherKey !== key &&
        other.bucket === m.bucket &&
        other.stream === m.stream &&
        other.generation !== m.generation
      ) {
        findings.add(
          'stream_generation_changed',
          `You verified this organization before under database generation ${other.generation}; this export is generation ${m.generation}. That is expected after Spellguard rebuilds a database; otherwise treat it as a rewrite.`,
        );
      }
    }
  }

  // 5. Records.
  const leafById = new Map<
    string,
    { seq: number; sha256: string; uploadedMs: number }
  >();
  const disposalById = new Map<
    string,
    { seq: number; leaf: DisposalLeaf; reason: DisposalReason }
  >();
  const readSeqs = [...read.keys()].sort((a, b) => a - b);
  for (const seq of readSeqs) {
    const parsed = (read.get(seq) as ReadCheckpoint).parsed;
    const uploadedMs = (listed.get(seq) as Listed).uploadedMs;
    if (parsed?.kind === 'records') {
      for (const leaf of parsed.leaves) {
        if (leafById.has(leaf.id)) {
          findings.add(
            'duplicate_leaf',
            `Record ${leaf.id} is listed again in checkpoint ${seq}; a record is checkpointed once.`,
            seq,
            leaf.id,
          );
          continue;
        }
        leafById.set(leaf.id, { seq, sha256: leaf.sha256, uploadedMs });
      }
    } else if (parsed?.kind === 'disposal') {
      for (const leaf of parsed.leaves) {
        if (!disposalById.has(leaf.id))
          disposalById.set(leaf.id, { seq, leaf, reason: parsed.reason });
      }
    }
  }
  for (const [id, d] of disposalById) {
    const leaf = leafById.get(id);
    const named = read.get(d.leaf.checkpoint_seq)?.parsed;
    const mismatch = leaf
      ? leaf.sha256 !== d.leaf.sha256 || leaf.seq !== d.leaf.checkpoint_seq
      : named?.kind === 'records';
    if (mismatch) {
      findings.add(
        'disposal_mismatch',
        `The deletion of ${id} announced in checkpoint ${d.seq} does not match the record checkpoint ${d.leaf.checkpoint_seq} listed.`,
        d.seq,
        id,
      );
    }
  }

  const exported = new Set<string>();
  for (const line of bundle.records) {
    exported.add(line.id);
    const result: RecordResult = {
      id: line.id,
      status: 'ok',
      seq: null,
      uploaded_at: null,
      codes: [],
    };
    const tamper = (code: FindingCode, message: string, seq: number | null) => {
      result.status = 'tampered';
      if (!result.codes.includes(code)) result.codes.push(code);
      findings.add(code, message, seq, line.id);
    };
    let parsedRecord: unknown;
    try {
      parsedRecord = JSON.parse(line.record);
    } catch {
      parsedRecord = undefined;
    }
    const leaf = leafById.get(line.id);
    if (leaf) {
      result.seq = leaf.seq;
      result.uploaded_at = isoOrNull(
        Number.isFinite(leaf.uploadedMs) ? leaf.uploadedMs : null,
      );
    } else {
      result.seq = line.checkpoint_seq;
    }
    if (!isObject(parsedRecord) || parsedRecord.id !== line.id) {
      tamper(
        'record_invalid',
        `The exported record is not a valid record with id ${line.id}.`,
        result.seq,
      );
    } else {
      result.record = parsedRecord;
      if (leaf) {
        if ((await sha256Hex(line.record)) !== leaf.sha256) {
          let detail = '';
          if (
            line.checkpointed_record !== undefined &&
            (await sha256Hex(line.checkpointed_record)) === leaf.sha256
          ) {
            const diff = diffRecords(line.record, line.checkpointed_record);
            if (diff && diff.length > 0) {
              result.diff = diff;
              detail = `: ${describeDiff(diff)}`;
            }
          }
          tamper(
            'record_changed',
            `Changed after checkpoint ${leaf.seq}${detail}.`,
            leaf.seq,
          );
        }
      } else if (
        line.checkpoint_seq === null ||
        line.checkpoint_seq > maxListed
      ) {
        result.status = 'pending';
      } else {
        tamper(
          'record_unlisted',
          `Spellguard says checkpoint ${line.checkpoint_seq} lists this record, but no checkpoint the verifier read does.`,
          line.checkpoint_seq,
        );
      }
      // The signature, pending records included.
      const sig = await checkSignature(
        parsedRecord,
        line.signed_record,
        verifierKeys,
      );
      result.signature = sig.state;
      if (sig.keyId) result.signed_by = sig.keyId;
      if (sig.code && sig.message) {
        if (sig.state === 'invalid') {
          if (sig.diff) result.signed_diff = sig.diff;
          tamper(sig.code, sig.message, result.seq);
        } else {
          if (!result.codes.includes(sig.code)) result.codes.push(sig.code);
          findings.add(sig.code, sig.message, result.seq, line.id);
        }
      }
    }
    const disposal = disposalById.get(line.id);
    if (disposal) {
      tamper(
        'disposed_but_present',
        `Announced as deleted in checkpoint ${disposal.seq}, but still in the export.`,
        disposal.seq,
      );
    }
    report.records.push(result);
  }

  const range = m.records ?? {
    from_seq: 1,
    to_seq: maxManifest,
    pending: true,
  };
  for (const seq of readSeqs) {
    if (seq < range.from_seq || (range.to_seq !== null && seq > range.to_seq))
      continue;
    const parsed = (read.get(seq) as ReadCheckpoint).parsed;
    if (parsed?.kind !== 'records') continue;
    for (const leafEntry of parsed.leaves) {
      const leaf = leafById.get(leafEntry.id);
      if (exported.has(leafEntry.id) || !leaf || leaf.seq !== seq) continue;
      exported.add(leafEntry.id);
      const result: RecordResult = {
        id: leafEntry.id,
        status: 'missing',
        seq,
        uploaded_at: isoOrNull(
          Number.isFinite(leaf.uploadedMs) ? leaf.uploadedMs : null,
        ),
        codes: [],
      };
      const d = disposalById.get(leafEntry.id);
      if (d && d.leaf.sha256 === leaf.sha256 && d.leaf.checkpoint_seq === seq) {
        result.status = 'deleted';
        result.reason = d.reason;
        if (d.reason === 'unattributed') {
          result.codes.push('record_deleted_unexplained');
          findings.add(
            'record_deleted_unexplained',
            `Deleted outside any retention or purge path; checkpoint ${d.seq} announced it as unattributed.`,
            d.seq,
            leafEntry.id,
          );
        }
      } else if (d) {
        result.status = 'tampered';
        result.codes.push('disposal_mismatch');
        findings.add(
          'disposal_mismatch',
          `The deletion of ${leafEntry.id} announced in checkpoint ${d.seq} does not match the record checkpoint ${d.leaf.checkpoint_seq} listed.`,
          d.seq,
          leafEntry.id,
        );
      } else {
        result.codes.push('record_missing');
        findings.add(
          'record_missing',
          `Listed in checkpoint ${seq} but missing from the export, with no deletion announced.`,
          seq,
          leafEntry.id,
        );
      }
      report.records.push(result);
    }
  }

  // Save what verified cleanly. A saved hash is never overwritten.
  if (opts.state) {
    const next: SavedStream = saved
      ? cloneStream(saved)
      : {
          bucket: m.bucket,
          generation: m.generation,
          stream: m.stream,
          checkpoints: {},
          verified_at: '',
        };
    for (const seq of readSeqs) {
      if (findings.problemAt(seq)) continue;
      const id = String(seq);
      if (!Object.hasOwn(next.checkpoints, id))
        next.checkpoints[id] = (read.get(seq) as ReadCheckpoint).sha256;
    }
    next.verified_at = new Date(now).toISOString();
    try {
      await opts.state.save(key, next);
    } catch (error) {
      findings.add(
        'state_not_saved',
        `The checkpoints verified this time were not saved (${error instanceof Error ? error.message : String(error)}), so a later run cannot compare against them.`,
      );
    }
  }

  return finish(report, findings);
}

// ── Replaying a session (SPEC "Replaying a session") ─────────────────────────

export type ArchiveState =
  | 'none'
  | 'not_signed'
  | 'unavailable'
  | 'matches'
  | 'changed';

export interface ReplayRecord {
  id: string;
  timestamp: string;
  agent_id: string;
  direction: string;
  sender_id: string;
  recipient_id: string;
  event_type: string;
  response_level: string;
  status: RecordStatus;
  codes: FindingCode[];
  signature: SignatureState | undefined;
  seq: number | null;
  uploaded_at: string | null;
  archive_ref: string | null;
  archive: ArchiveState;
}

export interface ReplayReport {
  ok: boolean;
  session: string;
  /** Whether the whole export verified. */
  verification_ok: boolean;
  records: ReplayRecord[];
  /** The replay's own, then the verification's about the stream or a record of the session. */
  findings: Finding[];
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * Verifies the bundle and walks one session's records in order. Throws only
 * when the bundle cannot be verified at all.
 */
export async function replay(
  bundle: Bundle,
  session: string,
  opts: VerifyOptions,
): Promise<ReplayReport> {
  const verification = await verify(bundle, opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const results = new Map(verification.records.map((r) => [r.id, r]));

  const lines: Array<{
    line: ExportedRecord;
    fields: Record<string, unknown>;
    at: number;
  }> = [];
  for (const line of bundle.records) {
    let fields: unknown;
    try {
      fields = JSON.parse(line.record);
    } catch {
      continue;
    }
    if (
      !isObject(fields) ||
      session === '' ||
      fields.correlation_id !== session
    )
      continue;
    lines.push({ line, fields, at: parseTime(fields.timestamp) ?? 0 });
  }
  lines.sort(
    (a, b) =>
      a.at - b.at ||
      (a.line.id < b.line.id ? -1 : a.line.id > b.line.id ? 1 : 0),
  );

  const links = new Map<string, string>();
  for (const a of bundle.manifest.archives ?? []) {
    if (
      isObject(a) &&
      typeof a.archive_ref === 'string' &&
      typeof a.url === 'string'
    )
      links.set(a.archive_ref, a.url);
  }

  const findings = new Findings();
  const inSession = new Set<string>();
  const records: ReplayRecord[] = [];
  for (const { line, fields } of lines) {
    inSession.add(line.id);
    const result = results.get(line.id);
    const archiveRef = str(fields.archive_ref) || null;
    const rec: ReplayRecord = {
      id: line.id,
      timestamp: str(fields.timestamp),
      agent_id: str(fields.agent_id),
      direction: str(fields.direction),
      sender_id: str(fields.sender_id),
      recipient_id: str(fields.recipient_id),
      event_type: str(fields.event_type),
      response_level: str(fields.response_level),
      status: result?.status ?? 'ok',
      codes: [...(result?.codes ?? [])],
      signature: result?.signature,
      seq: result?.seq ?? null,
      uploaded_at: result?.uploaded_at ?? null,
      archive_ref: archiveRef,
      archive: 'none',
    };
    rec.archive = await archiveState(fetchImpl, rec, line, links, findings);
    records.push(rec);
  }

  const changed = findings.has('archive_changed');
  for (const f of verification.findings) {
    if (f.record_id === null || inSession.has(f.record_id)) {
      findings.add(f.code, f.message, f.seq, f.record_id, f.key_id ?? null);
    }
  }
  return {
    ok: verification.ok && !changed,
    session,
    verification_ok: verification.ok,
    records,
    findings: findings.sorted(),
  };
}

async function archiveState(
  fetchImpl: typeof fetch,
  rec: ReplayRecord,
  line: ExportedRecord,
  links: Map<string, string>,
  findings: Findings,
): Promise<ArchiveState> {
  if (rec.archive_ref === null) return 'none';
  let want = '';
  if (rec.signature === 'valid' && line.signed_record !== undefined) {
    try {
      const signed = JSON.parse(line.signed_record);
      if (isObject(signed)) want = str(signed.archive_sha256);
    } catch {
      want = '';
    }
  }
  if (want === '') return 'not_signed';
  const ref = rec.archive_ref;
  const unavailable = (why: string): ArchiveState => {
    findings.add(
      'archive_unavailable',
      `The archived message ${ref} could not be read (${why}), so it was not checked.`,
      null,
      rec.id,
    );
    return 'unavailable';
  };
  const link = links.get(ref);
  if (link === undefined) return unavailable('the export has no link for it');
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return unavailable('its link is not an https URL');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return unavailable('its link is not an https URL');
  }
  let fetched: Fetched;
  try {
    fetched = await fetchLimited(fetchImpl, link, MAX_OBJECT_BYTES);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  if (fetched.status !== 200) return unavailable(`HTTP ${fetched.status}`);
  const got = await sha256Hex(fetched.bytes);
  if (got !== want.toLowerCase()) {
    findings.add(
      'archive_changed',
      `The archived message ${ref} hashes to ${got}, but the Verifier signed ${want}: it was changed or replaced.`,
      null,
      rec.id,
    );
    return 'changed';
  }
  return 'matches';
}
