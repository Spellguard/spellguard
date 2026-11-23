// SPDX-License-Identifier: Apache-2.0
//
// Writes the shared test vectors into scenarios/. Deterministic: running it
// twice produces the same bytes. After running it, format the JSON with the
// repository's formatter (see README.md); string contents are unaffected.
//
//   node packages/audit-verify/testdata/generate.mjs
//
// Each scenario starts from one valid stream and changes one thing, so the
// expected outcome is written down by hand next to the change.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
} from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const BUCKET = 'spellguard-audit-checkpoints-test';
const REGION = 'us-west-2';
const HOST = `${BUCKET}.s3.${REGION}.amazonaws.com`;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-10T00:17:00.000Z');

const uuid = (n) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const GENERATION = uuid(0xa0);
const ORG = uuid(0xb0);
const OTHER_GENERATION = uuid(0xc0);
const OTHER_ORG = uuid(0xb1);
const PREFIX = `audit-checkpoints/${GENERATION}/${ORG}/`;

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const seqName = (seq) => String(seq).padStart(12, '0');
const keyOf = (seq, prefix = PREFIX) => `${prefix}${seqName(seq)}.json`;
const recordId = (i) => uuid(0x1000 + i);

// ── Records ──────────────────────────────────────────────────────────────────

/** jsonb's text form, which Postgres uses for nested values. */
function jsonbText(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** A record in the shape Postgres' json_build_object(...)::text produces. */
function recordText(i, overrides = {}) {
  const at = `${iso(T0 - HOUR + i * 60_000).slice(0, -1)}000Z`;
  const fields = {
    format: 1,
    id: recordId(i),
    organization_id: ORG,
    agent_id: uuid(0x2000 + (i % 3)),
    direction: i % 2 ? 'outbound' : 'inbound',
    message_hash: sha(`message ${i}`),
    sender_id: 'agent-a',
    recipient_id: 'agent-b',
    timestamp: at,
    attestation_level: 'self',
    correlation_id: null,
    policy_checks: [{ policy: 'pii-detection', result: 'pass' }],
    response_level: 'allow',
    severity: 'info',
    verifier_id: 'verifier-test',
    verifier_signature: `sig_${sha(`message ${i}`).slice(0, 16)}`,
    commitment_tx_id: null,
    event_type: 'message',
    archive_ref: null,
    needs_review: false,
    metadata: {},
    created_at: at,
    ...overrides,
  };
  return `{${Object.entries(fields)
    .map(([k, v]) => `${JSON.stringify(k)} : ${jsonbText(v)}`)
    .join(', ')}}`;
}

// ── Verifier keys and signed records ─────────────────────────────────────────

const KEYS_PREFIX = 'audit-checkpoints/keys/';
const shaBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A deterministic Ed25519 key from a label (the seed is its SHA-256). */
function testKey(label) {
  const seed = createHash('sha256').update(label, 'utf8').digest();
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const privateKey = createPrivateKey({
    key: der,
    format: 'der',
    type: 'pkcs8',
  });
  const publicRaw = Buffer.from(
    createPublicKey(privateKey).export({ format: 'jwk' }).x,
    'base64url',
  );
  const keyId = shaBytes(publicRaw).slice(0, 16);
  return {
    privateKey,
    publicKey: publicRaw.toString('hex'),
    keyId,
    objectKey: `${KEYS_PREFIX}${keyId}.json`,
    body: `${JSON.stringify({
      format: 1,
      kind: 'verifier-audit-key',
      algorithm: 'ed25519',
      key_id: keyId,
      public_key: publicRaw.toString('hex'),
    })}\n`,
  };
}

const KEY = testKey('spellguard audit-verify test key 1');
const OTHER_KEY = testKey('spellguard audit-verify test key 2');
/** The key is published two hours before the first checkpoint. */
const KEY_UPLOADED = T0 - 2 * HOUR;
/** Records 7 to 14 are signed by the Verifier; the rest predate signing. */
const SIGNED = new Set([7, 8, 9, 10, 11, 12, 13, 14]);

const recordAt = (i) => T0 - HOUR + i * 60_000;
const POLICY_CHECKS = [
  {
    policyId: 'pii-detection',
    policyName: 'PII detection',
    decision: 'permit',
    responseLevel: 'allow',
    severity: 'info',
    detections: [],
  },
];

/** The values a Verifier signs for record i, in the signed record's order. */
function signedValues(i, key = KEY) {
  return {
    format: 1,
    key_id: key.keyId,
    id: recordId(i),
    agent_id: uuid(0x2000 + (i % 3)),
    direction: i % 2 ? 'outbound' : 'inbound',
    sender_id: 'agent-a',
    recipient_id: 'agent-b',
    timestamp: iso(recordAt(i)),
    message_hash: sha(`message ${i}`),
    attestation_level: 'self',
    correlation_id: null,
    event_type: 'message',
    response_level: 'allow',
    policy_checks: POLICY_CHECKS.map((c) => ({
      policy_id: c.policyId,
      decision: c.decision,
      response_level: c.responseLevel,
      severity: c.severity,
    })),
    archive_ref: `message-${i}`,
    archive_sha256: sha(`archive ${i}`),
    verifier_id: 'verifier-test',
    signed_at: iso(recordAt(i) + 400),
  };
}

/** Signs a signed record's exact text: `ed25519:<key id>:<128 hex>`. */
function signText(text, key = KEY) {
  const signature = cryptoSign(null, Buffer.from(text, 'utf8'), key.privateKey);
  return `ed25519:${key.keyId}:${signature.toString('hex')}`;
}

/**
 * Record i as the Verifier signed it: the signed record, its signature, and
 * the record overrides that make the row hold the signed values.
 */
function signedRecord(i, { changes = {}, key = KEY } = {}) {
  const text = JSON.stringify({ ...signedValues(i, key), ...changes });
  return {
    text,
    signature: signText(text, key),
    // Records 7 to 10 hold their checks as a JSON string, as Spellguard stores
    // most of them; 11 to 14 as an array.
    row: {
      policy_checks: i <= 10 ? JSON.stringify(POLICY_CHECKS) : POLICY_CHECKS,
      archive_ref: `message-${i}`,
    },
  };
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

function checkpointBody(seq, previousSha256, content) {
  const head = {
    format: 1,
    generation: GENERATION,
    stream: ORG,
    seq,
    previous_sha256: previousSha256,
    written_at: iso(T0 + (seq - 1) * HOUR),
    kind: content.kind,
  };
  let body;
  if (content.kind === 'records') {
    body = { ...head, leaves: content.leaves };
  } else if (content.kind === 'disposal') {
    body = {
      ...head,
      reason: content.reason,
      retention_days: content.retention_days,
      leaves: content.leaves,
    };
  } else {
    body = { ...head, leaves: [] };
  }
  return `${JSON.stringify(body)}\n`;
}

const uploadedAt = (seq) => T0 + (seq - 1) * HOUR + 4_000;

/**
 * A stream from a plan. `texts[i]` is record i as it was checkpointed.
 * `tamper(seq, body)` may rewrite an object's parsed body before it is hashed.
 */
function buildStream(plan, texts, tamper = () => {}) {
  const firstSeqOf = new Map();
  const objects = [];
  let previous = null;
  plan.forEach((content, index) => {
    const seq = index + 1;
    let resolved;
    if (content.kind === 'records') {
      resolved = {
        kind: 'records',
        leaves: content.records.map((i) => {
          if (!firstSeqOf.has(i)) firstSeqOf.set(i, seq);
          return { id: recordId(i), sha256: sha(texts[i]) };
        }),
      };
    } else if (content.kind === 'disposal') {
      resolved = {
        kind: 'disposal',
        reason: content.reason,
        retention_days: content.retention_days,
        leaves: content.records.map((i) => ({
          id: recordId(i),
          sha256: content.shaOverride?.[i] ?? sha(texts[i]),
          checkpoint_seq: firstSeqOf.get(i),
        })),
      };
    } else {
      resolved = { kind: 'heartbeat' };
    }
    let body = checkpointBody(seq, previous, resolved);
    const parsed = JSON.parse(body);
    if (tamper(seq, parsed) === true) body = `${JSON.stringify(parsed)}\n`;
    const lastModified = uploadedAt(seq);
    const object = {
      seq,
      kind: resolved.kind,
      body,
      sha256: sha(body),
      leafCount: resolved.kind === 'heartbeat' ? 0 : resolved.leaves.length,
      writtenAt: parsed.written_at,
      key: keyOf(seq),
      versionId: `v${seq}-a`,
      lastModified: iso(lastModified),
      retainUntil: iso(lastModified + 25 * HOUR),
    };
    objects.push(object);
    previous = object.sha256;
  });
  return { objects, firstSeqOf };
}

// ── URLs ─────────────────────────────────────────────────────────────────────

function signature(seed) {
  const amzDate = '20261110T221700Z';
  return [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    `X-Amz-Credential=${encodeURIComponent('AKIAEXAMPLEKEY/20261110/us-west-2/s3/aws4_request')}`,
    `X-Amz-Date=${amzDate}`,
    'X-Amz-Expires=604800',
    'X-Amz-SignedHeaders=host',
    `X-Amz-Signature=${sha(`signature ${seed}`)}`,
  ].join('&');
}

function listingUrl(
  page,
  { prefix = PREFIX, maxKeys = 1000, host = HOST } = {},
) {
  const marker =
    page === 0 ? '' : `&key-marker=${encodeURIComponent(keyOf(page * 500))}`;
  return `https://${host}/?versions=&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}${marker}&${signature(`list ${page}`)}`;
}

function objectUrl(key, host = HOST) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://${host}/${path}?${signature(`get ${key}`)}`;
}

function keysListingUrl({ prefix = KEYS_PREFIX, host = HOST } = {}) {
  return `https://${host}/?versions=&prefix=${encodeURIComponent(prefix)}&max-keys=1000&${signature('list keys')}`;
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const PASS_COUNTS = { ok: 10, pending: 2, deleted: 2, missing: 0, tampered: 0 };

/**
 * The valid stream every scenario starts from:
 *   seq 1  records   r1–r6   (r5 was checkpointed as "block")
 *   seq 2  records   r7–r10
 *   seq 3  disposal  r2, r3  (retention, 30 days)
 *   seq 4  heartbeat
 *   seq 5  records   r11, r12
 * plus r13 and r14, not checkpointed yet. r2 and r3 are gone from the export.
 */
function baseScenario(name) {
  const texts = {};
  const signed = {};
  for (let i = 1; i <= 15; i++) {
    if (SIGNED.has(i)) {
      signed[i] = signedRecord(i);
      texts[i] = recordText(i, {
        ...signed[i].row,
        verifier_signature: signed[i].signature,
      });
    } else {
      texts[i] = recordText(i, i === 5 ? { response_level: 'block' } : {});
    }
  }
  return {
    name,
    texts,
    signed,
    keys: {
      absent: false,
      inManifest: [KEY],
      versionOverrides: {},
      extraVersions: [],
      deleteMarkers: [],
      extraObjects: [],
      urlOverrides: {},
      uploadedAt: KEY_UPLOADED,
    },
    plan: [
      { kind: 'records', records: [1, 2, 3, 4, 5, 6] },
      { kind: 'records', records: [7, 8, 9, 10] },
      {
        kind: 'disposal',
        reason: 'retention',
        retention_days: 30,
        records: [2, 3],
      },
      { kind: 'heartbeat' },
      { kind: 'records', records: [11, 12] },
    ],
    tamper: () => false,
    present: [1, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    pending: [13, 14],
    lineOverrides: {},
    extraLines: [],
    s3: {
      omit: new Set(),
      extraVersions: [],
      deleteMarkers: [],
      versionOverrides: {},
    },
    manifest: {
      omit: new Set(),
      sha256Overrides: {},
      urlOverrides: {},
      listingOverrides: {},
    },
    state: null,
    allowedBuckets: [BUCKET],
    now: null,
    nowOffsetHours: 1,
    expected: { ok: true, counts: { ...PASS_COUNTS }, codes: [] },
  };
}

function render(sc) {
  const { objects, firstSeqOf } = buildStream(sc.plan, sc.texts, sc.tamper);
  const lastSeq = objects.length;

  const versions = [];
  for (const o of objects) {
    if (sc.s3.omit.has(o.seq)) continue;
    versions.push({
      key: o.key,
      version_id: o.versionId,
      last_modified: o.lastModified,
      lock_mode: 'COMPLIANCE',
      retain_until: o.retainUntil,
      body: o.body,
      ...(sc.s3.versionOverrides[o.seq] ?? {}),
    });
  }
  versions.push(...sc.s3.extraVersions.map((make) => make(objects)));
  const deleteMarkers = sc.s3.deleteMarkers.map((make) => make(objects));

  // Archived message objects, for replay scenarios.
  for (const [ref, body] of Object.entries(sc.archives?.objects ?? {})) {
    versions.push({
      key: `spellguard/archive/${ref}.json`,
      version_id: `a-${ref}`,
      last_modified: iso(T0),
      lock_mode: null,
      retain_until: null,
      body,
    });
  }

  // The published Verifier key, unless the scenario removes it.
  if (!sc.keys.absent) {
    versions.push({
      key: KEY.objectKey,
      version_id: 'k1-a',
      last_modified: iso(sc.keys.uploadedAt),
      lock_mode: 'COMPLIANCE',
      retain_until: iso(sc.keys.uploadedAt + 400 * 24 * HOUR),
      body: KEY.body,
      ...sc.keys.versionOverrides,
    });
    versions.push(...sc.keys.extraVersions);
    versions.push(...sc.keys.extraObjects);
    deleteMarkers.push(...sc.keys.deleteMarkers);
  }

  const inManifest = objects.filter(
    (o) =>
      !sc.manifest.omit.has(o.seq) &&
      !(sc.manifest.beyond ?? new Set()).has(o.seq),
  );
  const maxManifestSeq = inManifest.reduce((m, o) => Math.max(m, o.seq), 0);
  const pages = Math.max(1, Math.ceil(maxManifestSeq / 500));
  const listing = [];
  for (let page = 0; page < pages; page++) {
    listing.push(sc.manifest.listingOverrides[page] ?? listingUrl(page));
  }
  const lastUpload = objects.length
    ? Date.parse(objects[objects.length - 1].lastModified)
    : T0;
  const now = sc.now ?? iso(lastUpload + sc.nowOffsetHours * HOUR);
  const exportedAt = iso(Date.parse(now) - 5 * 60_000);
  const manifest = {
    format: 1,
    exported_at: exportedAt,
    bucket: BUCKET,
    region: REGION,
    generation: GENERATION,
    stream: ORG,
    prefix: PREFIX,
    urls_expire_at: iso(Date.parse(exportedAt) + 7 * 24 * HOUR),
    listing,
    checkpoints: inManifest.map((o) => ({
      seq: o.seq,
      kind: o.kind,
      written_at: o.writtenAt,
      leaf_count: o.leafCount,
      sha256: sc.manifest.sha256Overrides[o.seq] ?? o.sha256,
      url: sc.manifest.urlOverrides[o.seq] ?? objectUrl(o.key),
    })),
    records: {
      from_seq: 1,
      to_seq: sc.manifest.unbounded ? null : maxManifestSeq,
      pending: true,
    },
    ...(sc.archives
      ? {
          archives: sc.archives.links.map((ref) => ({
            archive_ref: ref,
            url: objectUrl(`spellguard/archive/${ref}.json`),
          })),
        }
      : {}),
    ...(sc.keys.absent
      ? {}
      : {
          keys: {
            listing: sc.keys.listingOverride ?? keysListingUrl(),
            objects: sc.keys.inManifest.map((key) => ({
              key_id: key.keyId,
              url: sc.keys.urlOverrides[key.keyId] ?? objectUrl(key.objectKey),
            })),
          },
        }),
  };

  const line = (i, checkpointSeq) => {
    const out = {
      id: recordId(i),
      checkpoint_seq: checkpointSeq,
      record: sc.texts[i],
      ...(sc.signed[i] ? { signed_record: sc.signed[i].text } : {}),
      ...(sc.lineOverrides[i] ?? {}),
    };
    for (const [k, v] of Object.entries(out))
      if (v === undefined) delete out[k];
    return out;
  };
  const lines = [];
  for (const i of sc.present) lines.push(line(i, firstSeqOf.get(i) ?? null));
  for (const i of sc.pending) lines.push(line(i, null));
  lines.push(...sc.extraLines);

  const dir = join(OUT, sc.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, 'records.jsonl'),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
  writeFileSync(
    join(dir, 's3.json'),
    `${JSON.stringify({ bucket: BUCKET, versions, delete_markers: deleteMarkers }, null, 2)}\n`,
  );
  if (sc.state) {
    writeFileSync(
      join(dir, 'state.json'),
      `${JSON.stringify(sc.state(objects, now), null, 2)}\n`,
    );
  }
  // Unless a scenario says otherwise, every exported line signed with a
  // ed25519 signature verifies, and every other line is unsigned.
  const signatures = sc.expected.signatures ?? {
    valid: lines.filter((l) =>
      JSON.parse(l.record).verifier_signature?.startsWith?.('ed25519:'),
    ).length,
    unsigned: lines.filter(
      (l) => !JSON.parse(l.record).verifier_signature?.startsWith?.('ed25519:'),
    ).length,
    unverified: 0,
    invalid: 0,
  };
  const expected = {
    now,
    allowed_buckets: sc.allowedBuckets,
    ok: sc.expected.ok,
    counts: sc.expected.counts,
    signatures,
    codes: [...new Set(sc.expected.codes)].sort(),
    ...(sc.expected.diffs ? { diffs: sc.expected.diffs } : {}),
    ...(sc.expected.signedDiffs
      ? { signed_diffs: sc.expected.signedDiffs }
      : {}),
    ...(sc.expected.replay ? { replay: sc.expected.replay } : {}),
  };
  writeFileSync(
    join(dir, 'expected.json'),
    `${JSON.stringify(expected, null, 2)}\n`,
  );
  return lastSeq;
}

const savedStream = (generation, checkpoints, verifiedAt) => ({
  bucket: BUCKET,
  generation,
  stream: ORG,
  checkpoints,
  verified_at: verifiedAt,
});

const scenarios = [];
const add = (name, change) => {
  const sc = baseScenario(name);
  change?.(sc);
  scenarios.push(sc);
};
const fail = (sc, codes, counts = {}) => {
  sc.expected = {
    ok: false,
    counts: { ...PASS_COUNTS, ...counts },
    codes,
  };
};

add('pass');

// An export without a range: every records checkpoint is accounted for.
add('unbounded_range', (sc) => {
  sc.manifest.unbounded = true;
});

// With no upper bound, a record missing from the newest checkpoint is still
// reported.
add('unbounded_range_missing', (sc) => {
  sc.manifest.unbounded = true;
  sc.present = sc.present.filter((i) => i !== 12);
  fail(sc, ['record_missing'], { ok: 9, missing: 1 });
});

add('record_changed', (sc) => {
  sc.lineOverrides[5] = {
    record: recordText(5),
    checkpointed_record: sc.texts[5],
  };
  fail(sc, ['record_changed'], { ok: 9, tampered: 1 });
  sc.expected.diffs = {
    [recordId(5)]: [{ field: 'response_level', now: 'allow', was: 'block' }],
  };
});

add('record_missing', (sc) => {
  sc.present = sc.present.filter((i) => i !== 6);
  fail(sc, ['record_missing'], { ok: 9, missing: 1 });
});

add('record_deleted_unexplained', (sc) => {
  sc.plan.push({
    kind: 'disposal',
    reason: 'unattributed',
    retention_days: null,
    records: [6],
  });
  sc.present = sc.present.filter((i) => i !== 6);
  fail(sc, ['record_deleted_unexplained'], { ok: 9, deleted: 3 });
});

add('disposal_mismatch', (sc) => {
  sc.plan[2].shaOverride = { 3: sha('not the record') };
  fail(sc, ['disposal_mismatch'], { deleted: 1, tampered: 1 });
});

add('disposed_but_present', (sc) => {
  sc.present = [2, ...sc.present];
  fail(sc, ['disposed_but_present'], { deleted: 1, tampered: 1 });
});

add('record_unlisted', (sc) => {
  sc.extraLines.push({
    id: recordId(15),
    checkpoint_seq: 2,
    record: sc.texts[15],
  });
  fail(sc, ['record_unlisted'], { tampered: 1 });
});

add('record_invalid', (sc) => {
  sc.lineOverrides[4] = { record: recordText(4, { id: recordId(99) }) };
  fail(sc, ['record_invalid'], { ok: 9, tampered: 1 });
  // An invalid record has no signature state.
  sc.expected.signatures = { valid: 8, unsigned: 3, unverified: 0, invalid: 0 };
});

add('extra_version', (sc) => {
  // Same bytes, written on top: the lock does not stop a new version, and a
  // plain GET now returns the new one.
  sc.s3.extraVersions.push((objects) => ({
    key: objects[1].key,
    version_id: 'v2-b',
    last_modified: iso(Date.parse(objects[1].lastModified) + 30 * 60_000),
    lock_mode: 'COMPLIANCE',
    retain_until: objects[1].retainUntil,
    body: objects[1].body,
  }));
  fail(sc, ['extra_version', 'version_mismatch']);
});

add('delete_marker', (sc) => {
  sc.s3.deleteMarkers.push((objects) => ({
    key: objects[3].key,
    version_id: 'dm4',
    last_modified: iso(Date.parse(objects[3].lastModified) + 10 * 60_000),
  }));
  fail(sc, ['checkpoint_unreadable', 'delete_marker']);
});

add('chain_broken', (sc) => {
  sc.tamper = (seq, body) => {
    if (seq !== 5) return false;
    body.previous_sha256 = '0'.repeat(64);
    return true;
  };
  fail(sc, ['chain_broken']);
});

add('not_locked', (sc) => {
  sc.s3.versionOverrides[2] = { lock_mode: null, retain_until: null };
  fail(sc, ['not_locked']);
});

add('version_mismatch', (sc) => {
  sc.s3.versionOverrides[2] = { get_version_id: 'v2-other' };
  fail(sc, ['version_mismatch']);
});

add('checkpoint_missing', (sc) => {
  sc.s3.omit.add(4);
  fail(sc, ['checkpoint_missing']);
});

add('checkpoint_not_exported', (sc) => {
  sc.manifest.omit.add(4);
  fail(sc, ['checkpoint_not_exported']);
});

add('checkpoint_unreadable', (sc) => {
  // Records whose checkpoint cannot be read are reported as unlisted.
  sc.s3.versionOverrides[2] = { get_status: 500 };
  fail(sc, ['checkpoint_unreadable', 'record_unlisted'], {
    ok: 6,
    tampered: 4,
  });
});

add('ledger_mismatch', (sc) => {
  sc.manifest.sha256Overrides[2] = sha('a forged ledger entry');
  fail(sc, ['ledger_mismatch']);
});

add('duplicate_leaf', (sc) => {
  sc.plan[4] = { kind: 'records', records: [11, 12, 7] };
  fail(sc, ['duplicate_leaf']);
});

const zero = { ok: 0, pending: 0, deleted: 0, missing: 0, tampered: 0 };
const zeroSignatures = { valid: 0, unsigned: 0, unverified: 0, invalid: 0 };

add('url_mismatch', (sc) => {
  sc.manifest.urlOverrides[2] = objectUrl(keyOf(2), 'evil.example.com');
  sc.expected = {
    ok: false,
    counts: zero,
    signatures: zeroSignatures,
    codes: ['url_mismatch'],
  };
});

add('url_mismatch_prefix', (sc) => {
  sc.manifest.listingOverrides[0] = listingUrl(0, {
    prefix: `audit-checkpoints/${GENERATION}/${OTHER_ORG}/`,
  });
  sc.expected = {
    ok: false,
    counts: zero,
    signatures: zeroSignatures,
    codes: ['url_mismatch'],
  };
});

add('bucket_not_allowed', (sc) => {
  sc.allowedBuckets = ['spellguard-audit-checkpoints-production'];
  sc.expected = {
    ok: false,
    counts: zero,
    signatures: zeroSignatures,
    codes: ['bucket_not_allowed'],
  };
});

add('listing_incomplete', (sc) => {
  // The only page stops after three versions, so seqs 4 and 5 are never seen.
  sc.manifest.listingOverrides[0] = listingUrl(0, { maxKeys: 3 });
  fail(sc, ['checkpoint_missing', 'listing_incomplete'], {
    ok: 8,
    pending: 4,
  });
});

add('multipage', (sc) => {
  sc.plan = [{ kind: 'records', records: [1, 2, 3] }];
  for (let i = 0; i < 1000; i++) sc.plan.push({ kind: 'heartbeat' });
  sc.present = [1, 2, 3];
  sc.pending = [];
  sc.expected = {
    ok: true,
    counts: { ...zero, ok: 3 },
    codes: [],
  };
});

add('checkpoints_beyond_export', (sc) => {
  sc.plan.push({ kind: 'heartbeat' });
  sc.manifest.beyond = new Set([6]);
  sc.expected = {
    ok: true,
    counts: { ...PASS_COUNTS },
    codes: ['checkpoints_beyond_export'],
  };
});

add('stream_stale', (sc) => {
  sc.nowOffsetHours = 30;
  sc.expected = {
    ok: true,
    counts: { ...PASS_COUNTS },
    codes: ['stream_stale'],
  };
});

add('saved_checkpoint_changed', (sc) => {
  sc.state = (objects, now) => ({
    format: 1,
    streams: {
      [`${BUCKET}/${GENERATION}/${ORG}`]: savedStream(
        GENERATION,
        { 1: objects[0].sha256, 2: sha('what checkpoint 2 used to be') },
        iso(Date.parse(now) - 24 * HOUR),
      ),
    },
  });
  fail(sc, ['saved_checkpoint_changed']);
});

add('saved_checkpoint_gone', (sc) => {
  sc.state = (objects, now) => ({
    format: 1,
    streams: {
      [`${BUCKET}/${GENERATION}/${ORG}`]: savedStream(
        GENERATION,
        { 1: objects[0].sha256, 7: sha('checkpoint 7') },
        iso(Date.parse(now) - 24 * HOUR),
      ),
    },
  });
  fail(sc, ['saved_checkpoint_gone']);
});

add('stream_generation_changed', (sc) => {
  sc.state = (_objects, now) => ({
    format: 1,
    streams: {
      [`${BUCKET}/${OTHER_GENERATION}/${ORG}`]: savedStream(
        OTHER_GENERATION,
        { 1: sha('an earlier database') },
        iso(Date.parse(now) - 24 * HOUR),
      ),
    },
  });
  sc.expected = {
    ok: true,
    counts: { ...PASS_COUNTS },
    codes: ['stream_generation_changed'],
  };
});

// ── Signed records ───────────────────────────────────────────────────────────

const BASE_SIGNATURES = { valid: 8, unsigned: 4, unverified: 0, invalid: 0 };
const resign = (sc, i, rowChanges = {}) => {
  sc.texts[i] = recordText(i, {
    ...sc.signed[i].row,
    verifier_signature: sc.signed[i].signature,
    ...rowChanges,
  });
};

// Changed before its first checkpoint, so the checkpoint hashes the changed
// record and only the signature catches it: r8 was signed as "block".
add('signed_field_changed_before_checkpoint', (sc) => {
  sc.signed[8] = signedRecord(8, { changes: { response_level: 'block' } });
  resign(sc, 8);
  fail(sc, ['signed_field_mismatch'], { ok: 9, tampered: 1 });
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 7, invalid: 1 };
  sc.expected.signedDiffs = {
    [recordId(8)]: [{ field: 'response_level', now: 'allow', was: 'block' }],
  };
});

// A pending record changed after it was signed.
add('signed_field_changed_pending', (sc) => {
  resign(sc, 13, { response_level: 'block' });
  fail(sc, ['signed_field_mismatch'], { pending: 1, tampered: 1 });
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 7, invalid: 1 };
  sc.expected.signedDiffs = {
    [recordId(13)]: [{ field: 'response_level', now: 'block', was: 'allow' }],
  };
});

// A policy check's decision changed, with the top-level decision left alone.
add('signed_policy_check_changed', (sc) => {
  resign(sc, 12, {
    policy_checks: [{ ...POLICY_CHECKS[0], decision: 'deny' }],
  });
  fail(sc, ['signed_field_mismatch'], { ok: 9, tampered: 1 });
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 7, invalid: 1 };
});

// The same, in a record whose checks are stored as a JSON string.
add('signed_policy_check_changed_text', (sc) => {
  resign(sc, 9, {
    policy_checks: JSON.stringify([{ ...POLICY_CHECKS[0], decision: 'deny' }]),
  });
  fail(sc, ['signed_field_mismatch'], { ok: 9, tampered: 1 });
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 7, invalid: 1 };
});

// r9's signature is not the Verifier's: its last byte differs.
add('signature_invalid', (sc) => {
  const s = sc.signed[9].signature;
  resign(sc, 9, {
    verifier_signature: `${s.slice(0, -2)}${s.endsWith('00') ? '01' : '00'}`,
  });
  fail(sc, ['signature_invalid'], { ok: 9, tampered: 1 });
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 7, invalid: 1 };
});

// The row and its signed record were both changed to "block" before the
// checkpoint; the signature no longer covers the signed record.
add('signed_record_altered', (sc) => {
  sc.signed[10] = {
    ...sc.signed[10],
    text: JSON.stringify({ ...signedValues(10), response_level: 'block' }),
  };
  resign(sc, 10, { response_level: 'block' });
  fail(sc, ['signature_invalid'], { ok: 9, tampered: 1 });
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 7, invalid: 1 };
});

add('signed_record_missing', (sc) => {
  sc.lineOverrides[11] = { signed_record: undefined };
  fail(sc, ['signed_record_missing'], { ok: 9, tampered: 1 });
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 7, invalid: 1 };
});

// The export holds no key for the signatures, so none can be checked.
add('signature_key_unknown', (sc) => {
  sc.keys.inManifest = [];
  sc.expected = {
    ok: true,
    counts: { ...PASS_COUNTS },
    signatures: { ...BASE_SIGNATURES, valid: 0, unverified: 8 },
    codes: ['signature_key_unknown'],
  };
});

// An export from before records were signed has no keys at all.
add('keys_absent', (sc) => {
  sc.keys.absent = true;
  sc.expected = {
    ok: true,
    counts: { ...PASS_COUNTS },
    signatures: { ...BASE_SIGNATURES, valid: 0, unverified: 8 },
    codes: ['signature_key_unknown'],
  };
});

// The key was published after r7 to r9 were written: it cannot vouch for them.
add('signature_predates_key', (sc) => {
  sc.keys.uploadedAt = recordAt(10) - 30_000;
  sc.expected = {
    ok: true,
    counts: { ...PASS_COUNTS },
    signatures: { ...BASE_SIGNATURES, valid: 5, unverified: 3 },
    codes: ['signature_predates_key'],
  };
});

const untrustedKey = (sc) => {
  fail(sc, ['key_invalid', 'signature_key_unknown']);
  sc.expected.signatures = { ...BASE_SIGNATURES, valid: 0, unverified: 8 };
};

// Another public key written on top of the locked key object.
add('key_extra_version', (sc) => {
  sc.keys.extraVersions.push({
    key: KEY.objectKey,
    version_id: 'k1-b',
    last_modified: iso(KEY_UPLOADED + HOUR),
    lock_mode: 'COMPLIANCE',
    retain_until: iso(KEY_UPLOADED + 400 * 24 * HOUR),
    body: KEY.body,
  });
  untrustedKey(sc);
});

add('key_delete_marker', (sc) => {
  sc.keys.deleteMarkers.push({
    key: KEY.objectKey,
    version_id: 'k1-dm',
    last_modified: iso(KEY_UPLOADED + HOUR),
  });
  untrustedKey(sc);
});

add('key_not_locked', (sc) => {
  sc.keys.versionOverrides = { lock_mode: null, retain_until: null };
  untrustedKey(sc);
});

// The object is named for one key but holds another's public key.
add('key_mismatch', (sc) => {
  const forged = JSON.parse(KEY.body);
  forged.public_key = OTHER_KEY.publicKey;
  sc.keys.versionOverrides = { body: `${JSON.stringify(forged)}\n` };
  untrustedKey(sc);
});

add('key_url_mismatch', (sc) => {
  sc.keys.urlOverrides[KEY.keyId] = objectUrl(OTHER_KEY.objectKey);
  sc.expected = {
    ok: false,
    counts: zero,
    signatures: zeroSignatures,
    codes: ['url_mismatch'],
  };
});

add('key_unexpected_object', (sc) => {
  sc.keys.extraObjects.push({
    key: `${KEYS_PREFIX}notes.txt`,
    version_id: 'n1',
    last_modified: iso(KEY_UPLOADED),
    lock_mode: 'COMPLIANCE',
    retain_until: iso(KEY_UPLOADED + HOUR),
    body: 'notes\n',
  });
  fail(sc, ['unexpected_key']);
});

// ── Replaying a session ──────────────────────────────────────────────────────

// Session "session-1": signed r11 and r12 (checkpointed) and r13 (pending), and
// unsigned r6, whose archive was never signed. Each signed record's archive
// object holds the bytes whose hash the Verifier signed.
const replayScenario = (sc) => {
  for (const i of [11, 12, 13]) {
    sc.signed[i] = signedRecord(i, {
      changes: { correlation_id: 'session-1' },
    });
    resign(sc, i, { correlation_id: 'session-1' });
  }
  sc.texts[6] = recordText(6, {
    correlation_id: 'session-1',
    archive_ref: 'message-6',
  });
  sc.archives = {
    links: ['message-6', 'message-11', 'message-12', 'message-13'],
    objects: {
      'message-6': 'archive 6',
      'message-11': 'archive 11',
      'message-12': 'archive 12',
      'message-13': 'archive 13',
    },
  };
  sc.expected.replay = {
    session: 'session-1',
    ok: true,
    codes: [],
    archives: {
      [recordId(6)]: 'not_signed',
      [recordId(11)]: 'matches',
      [recordId(12)]: 'matches',
      [recordId(13)]: 'matches',
    },
    order: [6, 11, 12, 13].map(recordId),
  };
};

add('replay_pass', (sc) => {
  replayScenario(sc);
});

// The archived message for r12 was replaced after the Verifier signed its hash.
add('replay_archive_changed', (sc) => {
  replayScenario(sc);
  sc.archives.objects['message-12'] = 'a different message';
  sc.expected.replay.ok = false;
  sc.expected.replay.codes = ['archive_changed'];
  sc.expected.replay.archives[recordId(12)] = 'changed';
});

// No link for r11's archive: unavailable, which does not fail the replay.
add('replay_archive_unavailable', (sc) => {
  replayScenario(sc);
  sc.archives.links = sc.archives.links.filter((r) => r !== 'message-11');
  sc.expected.replay.codes = ['archive_unavailable'];
  sc.expected.replay.archives[recordId(11)] = 'unavailable';
});

add('empty', (sc) => {
  sc.plan = [];
  sc.present = [];
  sc.now = iso(T0);
  sc.expected = { ok: true, counts: { ...zero, pending: 2 }, codes: [] };
});

// ── Write ────────────────────────────────────────────────────────────────────

rmSync(OUT, { recursive: true, force: true });
for (const sc of scenarios) render(sc);
console.log(`wrote ${scenarios.length} scenarios to ${OUT}`);
