# Spellguard audit checkpoints: format and verification

**Format version 1.** This document is enough to write your own audit checker. The
Go and TypeScript implementations in this package follow it and are tested
against the same examples in `testdata/`.

**Terms.** An *audit checker* is any program that checks an export against its
checkpoints, such as the two in this package. A *Verifier* is the Spellguard
service that checks agent traffic against policy and signs the audit records it
reports (see [Signed records](#signed-records)). They are different things.

## What it proves

Any change to, or deletion of, an audit record after its checkpoint is detected,
even one Spellguard makes. You check this yourself, reading the checkpoints
directly from AWS S3. Records signed by a Verifier are also protected from the
moment they were written: a change to a signed field is detected even if it was
made before the first checkpoint.

What it does not prove:

- That a record was true when it was written. A Verifier signs what it saw; a
  compromised Verifier could sign something false.
- Anything about an unsigned record before its first checkpoint. Checkpoints are
  written hourly, so such a record can be changed undetected for up to about an
  hour after it is written, and any record can be deleted undetected in that
  hour.
- Anything about records in an organization stream you did not export.

## How it works

Every hour, Spellguard writes one or more **checkpoint objects** for each
organization that has new audit records. Each object lists the SHA-256 of every
record it covers, and the SHA-256 of the previous object, so the objects form a
chain.

The objects are stored in an Amazon S3 bucket with **Object Lock in compliance
mode**. A compliance lock cannot be removed or shortened by anyone, including
the AWS account's root user, until it expires. Spellguard cannot rewrite a
checkpoint after it is written, only add new ones.

To verify, you export your records and a set of short-lived, read-only S3 links
to your stream (presigned URLs). The audit checker fetches the checkpoints from S3
itself, so Spellguard cannot substitute them, and checks every record against
them.

## Checkpoint objects

Object keys:

```
audit-checkpoints/<generation>/<organization id>/<seq>.json
```

- `generation` is a UUID that identifies one Spellguard database. A database
  that is rebuilt from scratch starts a new generation, and so new streams.
- `seq` is the object's position in the stream, starting at 1, written as 12
  decimal digits with leading zeros (`000000000001.json`).

Each object is one line of JSON, UTF-8, ending in `\n`. The SHA-256 of an object
is the SHA-256 of its exact bytes, newline included, written as 64 lowercase hex
characters.

Fields, in this order:

| Field | Type | Meaning |
|---|---|---|
| `format` | number | Always `1` |
| `generation` | string | Same as in the key |
| `stream` | string | The organization id, same as in the key |
| `seq` | number | Same as in the key |
| `previous_sha256` | string or null | SHA-256 of object `seq - 1`; `null` only when `seq` is 1 |
| `written_at` | string | When Spellguard created the object (ISO 8601, UTC). Claimed by Spellguard; the S3 upload time is the trusted time |
| `kind` | string | `records`, `disposal` or `heartbeat` |
| `reason` | string | `disposal` only: why the records were deleted |
| `retention_days` | number or null | `disposal` only: the retention period, when `reason` is `retention` |
| `leaves` | array | See below |

**`records`** objects list records being checkpointed for the first time:

```json
{"format":1,"generation":"…","stream":"…","seq":7,"previous_sha256":"…","written_at":"2026-11-10T22:17:03.120Z","kind":"records","leaves":[{"id":"…","sha256":"…"}]}
```

A record appears in exactly one `records` object, ever.

**`disposal`** objects announce records that were deleted after they were
checkpointed. Each leaf names the record, its SHA-256, and the `records` object
that listed it:

```json
{"format":1,…,"kind":"disposal","reason":"retention","retention_days":30,"leaves":[{"id":"…","sha256":"…","checkpoint_seq":7}]}
```

`reason` is one of:

| Reason | Meaning |
|---|---|
| `retention` | Removed by the organization's retention policy |
| `owner_purge` | Purged at the organization owner's request |
| `organization_deletion` | The organization was deleted |
| `unattributed` | Deleted outside any of those paths. Spellguard records every deletion as it happens, including ones made directly in the database, and announces those with this reason |

A deletion is announced in the first hourly run after it happens.

**`heartbeat`** objects have no leaves. A stream with nothing new for 23 hours
gets one, so a stream that stopped is visible rather than looking quiet.

## Records

A checkpointed record is one line of JSON text. Its SHA-256 is the SHA-256 of
that exact UTF-8 text, with no trailing newline. Verifiers never rebuild the
text; they hash what the export gives them and parse it only to display it.

Fields (format 1): `format`, `id`, `organization_id`, `agent_id`, `direction`,
`message_hash`, `sender_id`, `recipient_id`, `timestamp`, `attestation_level`,
`correlation_id`, `policy_checks`, `response_level`, `severity`, `verifier_id`,
`verifier_signature`, `commitment_tx_id`, `event_type`, `archive_ref`,
`needs_review`, `metadata`, `created_at`.

`verifier_signature` holds the Verifier's signature when the record is signed
(see [Signed records](#signed-records)). Any other value is not a signature:
records written before signing began hold a placeholder such as `sig_…`, and
records written by Spellguard's control plane hold an empty string. Do not treat
those as signatures.

## Signed records

A Spellguard **Verifier** (the service that checks agent traffic against policy)
signs each record it reports, before the record reaches Spellguard's database,
with its own Ed25519 **audit signing key**. A signature therefore covers a
record from the moment it was written, including the hour before its first
checkpoint, and a change to a signed field is detected whenever it was made.
Records that Spellguard's control plane writes itself carry no signature.

### `verifier_signature`

In a signed record, `verifier_signature` is:

```
ed25519:<key id>:<signature>
```

- `key id`: the first 16 hex characters of the SHA-256 of the key's 32-byte
  public key, lowercase.
- `signature`: the 64-byte Ed25519 signature, as 128 lowercase hex characters.

### The signed record

The signature is over the exact UTF-8 bytes of the **signed record**: one line
of JSON with these fields, in this order. The export carries it beside the
record (`signed_record`, below). An audit checker checks the signature on those bytes,
then compares the signed values with the record's own.

| Field | Type | Compared with the record's |
|---|---|---|
| `format` | number | Always `1` |
| `key_id` | string | the key id in `verifier_signature` |
| `id` | string | `id` |
| `agent_id` | string | `agent_id` |
| `direction` | string | `direction` |
| `sender_id` | string | `sender_id` |
| `recipient_id` | string | `recipient_id` |
| `timestamp` | string (ISO 8601) | `timestamp`, as an instant, to the millisecond |
| `message_hash` | string (hex) | `message_hash`, ignoring case |
| `attestation_level` | string | `attestation_level` |
| `correlation_id` | string or null | `correlation_id` |
| `event_type` | string | `event_type` |
| `response_level` | string | `response_level` |
| `policy_checks` | array | `policy_checks`: the same number of checks, in the same order, each with the same `policyId`, `decision`, `responseLevel` and `severity` (signed as `policy_id`, `decision`, `response_level` and `severity`; `null` when absent). Spellguard stores most records' checks as a JSON string holding the array, so a string is parsed first |
| `archive_ref` | string or null | `archive_ref` |
| `archive_sha256` | string or null | not compared: the SHA-256 of the archived message object the Verifier wrote, when it wrote one. A replay of the session compares it with the archive |
| `verifier_id` | string | `verifier_id` |
| `signed_at` | string (ISO 8601) | not compared: when the Verifier signed |

Strings compare exactly unless the table says otherwise; `null` equals only
`null`. Fields of the record that are not signed (`severity`, `needs_review`,
`metadata`, `created_at`, the rest of each policy check) are covered by the
checkpoint only.

### Verifier keys

Each Verifier audit signing key is published once in the same locked bucket,
before records signed with it count:

```
audit-checkpoints/keys/<key id>.json
```

The object is one line of JSON, UTF-8, ending in `\n`, with these fields in
this order:

```json
{"format":1,"kind":"verifier-audit-key","algorithm":"ed25519","key_id":"…","public_key":"<64 hex characters>"}
```

It is locked in compliance mode like a checkpoint. Its **upload time**, the
`LastModified` of its oldest version, is the time from which the key vouches for
records: a key cannot vouch for a record dated before it was published, so a
key stolen later cannot be used to sign records into the past.

## The export bundle

An export is a directory with two files.

### `manifest.json`

```json
{
  "format": 1,
  "exported_at": "2026-11-10T22:40:00.000Z",
  "bucket": "spellguard-audit-checkpoints-production",
  "region": "us-west-2",
  "generation": "…",
  "stream": "…",
  "prefix": "audit-checkpoints/<generation>/<stream>/",
  "urls_expire_at": "2026-11-17T22:40:00.000Z",
  "listing": ["https://…", "https://…"],
  "checkpoints": [
    {"seq": 1, "kind": "records", "written_at": "…", "leaf_count": 5000, "sha256": "…", "url": "https://…"}
  ],
  "records": {"from_seq": 1, "to_seq": 57, "pending": true},
  "keys": {
    "listing": "https://…",
    "objects": [{"key_id": "…", "url": "https://…"}]
  }
}
```

- `listing` holds presigned `ListObjectVersions` URLs for the stream's prefix,
  in order. Page `i` (from 0) starts after the key of seq `i × 500`; page 0 has
  no start key. Each asks for up to 1,000 versions. The last page has no end, so
  it also reveals objects newer than the export.
- `checkpoints` lists every uploaded object Spellguard knows of, oldest first,
  with a presigned `GetObject` URL for each. `sha256`, `kind`, `written_at` and
  `leaf_count` are Spellguard's claims; the audit checker checks them against S3.
- `records` says which records the bundle holds: every record listed by a
  `records` object with `from_seq ≤ seq ≤ to_seq`, plus, when `pending` is
  true, records not yet checkpointed. `to_seq` may be `null`, meaning no upper
  bound: every `records` object from `from_seq` on. Every such record that still
  exists is in `records.jsonl`; a deleted one is accounted for by a disposal
  announcement. When `records` is absent, the range is every checkpoint in
  `checkpoints`, plus pending records.
- `keys` holds the Verifier keys: a presigned `ListObjectVersions` URL for
  the prefix `audit-checkpoints/keys/` (one page, no start key), and a
  presigned `GetObject` URL for each published key. Absent in exports made
  before records were signed; then no signature can be checked.

Nothing in the manifest is trusted except the URLs' destination, which the
audit checker checks (below). A manifest too malformed to read (another `format`, a
missing field, a seq listed twice) stops verification with an error rather than
a finding.

### `records.jsonl`

One JSON object per line:

```json
{"id": "…", "checkpoint_seq": 7, "record": "<record text>", "checkpointed_record": "<record text>", "signed_record": "<signed record text>"}
```

- `record` is the record as it is in Spellguard's database now.
- `signed_record` is present when the record was signed: the exact text its
  Verifier signed.
- `checkpoint_seq` is the checkpoint Spellguard says lists it, or `null` when
  it is not checkpointed yet.
- `checkpointed_record` is optional: the text Spellguard stored when it
  checkpointed the record, sent only when it differs from `record`. An audit checker
  uses it only if its SHA-256 matches the checkpoint, to show what changed.

## Verifying

An audit checker is given the bundle, a list of **allowed buckets**, the current time,
and optionally the checkpoint hashes it saved on earlier runs. Fetching uses
only the URLs in the manifest. It reports each finding below with its code.
Findings marked **fails** make the verification fail.

### 1. Check where the URLs go

The bucket must be in the allowed list; otherwise `bucket_not_allowed`
(**fails**, and verification stops). `prefix` must be
`audit-checkpoints/<generation>/<stream>/`. Every URL must be `https`, with host
exactly `<bucket>.s3.<region>.amazonaws.com`, port 443 or none, and no user
name or password. Listing URLs must have path `/`, the parameter `versions`,
exactly one `prefix` equal to `prefix`, and `key-marker` as described above
(none on page 0); they must not set `delimiter`, `version-id-marker` or
`encoding-type`. Other parameters (`max-keys`, the `X-Amz-*` signature
parameters, including `X-Amz-Security-Token`) are allowed. Checkpoint URLs must
have a path that, percent-decoded, is `/<prefix><seq as 12 digits>.json`. The
keys listing URL follows the listing rules with `prefix` exactly
`audit-checkpoints/keys/` and no `key-marker`; each key URL must have the path
`/audit-checkpoints/keys/<key id>.json`, where the key id is 16 lowercase hex
characters and equals the entry's `key_id`. Any other URL is `url_mismatch`
(**fails**, and verification stops).

The production bucket is `spellguard-audit-checkpoints-production` in
`us-west-2`. An audit checker allows only that bucket unless told otherwise.

### 2. List the stream

Fetch every listing page. A page that cannot be fetched, or answers with
anything but HTTP 200 (an expired link answers 403), stops verification with an
error. `key-marker` lists keys strictly after the marker. Collect each `Version`
and `DeleteMarker` (key, version id, last-modified time). Then:

- Coverage: each page except the last must be complete up to the next page's
  start key (`IsTruncated` false, or `NextKeyMarker` strictly past the next
  page's start: a page cut off at that very key may have left some of its
  versions unlisted, and the next page starts after it). The last page must not
  be truncated. Otherwise `listing_incomplete` (**fails**).
- Every key must be `<prefix><12 digits>.json`; otherwise `unexpected_key`
  (**fails**).
- Any delete marker: `delete_marker` (**fails**).
- Any key with more than one version: `extra_version` (**fails**). Compliance
  locks protect each version but do not stop someone adding a version on top.
- Seqs must run from 1 to the highest listed seq with no gap; each missing seq
  is `checkpoint_missing` (**fails**).

The **original version** of a checkpoint is its oldest listed version, and its
**upload time** is that version's `LastModified`. It comes from S3, and is the
time from which the checkpoint vouches for its records.

### 2b. Read the Verifier keys

Skip this step when the manifest has no `keys`. Otherwise fetch the keys
listing; failing that, or anything but HTTP 200, stops verification with an
error, as for the stream. A truncated keys listing is `listing_incomplete`
(**fails**), and any object under the prefix whose name is not
`<16 lowercase hex>.json` is `unexpected_key` (**fails**).

For each key in the manifest, the key is **trusted** only if all of these hold;
otherwise report `key_invalid` (**fails**) saying which:

- The listing shows its object with exactly one version and no delete marker.
- Reading it answers HTTP 200 with that version's `x-amz-version-id`, and
  `x-amz-object-lock-mode` `COMPLIANCE` with a retain-until date.
- The body is the key object described above, its `key_id` equals the name,
  and `key_id` is the first 16 hex characters of the SHA-256 of `public_key`
  (32 bytes, 64 hex characters).

A trusted key vouches for records from its upload time on.

### 3. Read and chain the checkpoints

For every listed seq up to the highest seq in the manifest's `checkpoints`:

- No URL in the manifest for a listed seq: `checkpoint_not_exported`
  (**fails**). A seq in the manifest that S3 does not list is
  `checkpoint_missing` (**fails**).
- Fetch it. A failed fetch is `checkpoint_unreadable` (**fails**).
- The response's `x-amz-version-id` must equal the original version:
  `version_mismatch` (**fails**). A link without a `versionId` reads the newest
  version, so a version added on top also shows up here.
- `x-amz-object-lock-mode` must be `COMPLIANCE` and
  `x-amz-object-lock-retain-until-date` present: otherwise `not_locked`
  (**fails**).
- The body must parse and match the format above, with `generation`, `stream`
  and `seq` equal to the key's: otherwise `checkpoint_invalid` (**fails**).
- `previous_sha256` must equal the SHA-256 of the previous object (`null` for
  seq 1): otherwise `chain_broken` (**fails**).
- The manifest's `sha256`, `kind` and `leaf_count` must match the object:
  otherwise `ledger_mismatch` (**fails**; Spellguard's own record of its
  checkpoints has been changed).
- A record id in more than one `records` object: `duplicate_leaf` (**fails**).

Listed seqs above the manifest's highest are reported as
`checkpoints_beyond_export` (information only: export again to include them).

If the newest upload time is more than 25 hours before now, report
`stream_stale` (warning: checkpoints have stopped, so newer records are not
protected; existing ones still are).

Every `disposal` leaf must match the `records` leaf it names: the same SHA-256,
and `checkpoint_seq` equal to the seq that lists the record. A leaf that does
not, or that names a `records` checkpoint which does not list the record, is
`disposal_mismatch` (**fails**), whichever records the bundle holds.

### 4. Compare with saved checkpoints

An audit checker should save the SHA-256 of every checkpoint it has verified, keyed by
bucket, generation and stream (`<bucket>/<generation>/<stream>`), and never
overwrite a saved hash. It saves only checkpoints with no finding of their own
(`delete_marker`, `extra_version`, `version_mismatch`, `not_locked`,
`checkpoint_invalid`, `chain_broken`, `ledger_mismatch`,
`saved_checkpoint_changed`). If saving fails, report `state_not_saved`
(warning).

- A saved seq whose object now has a different SHA-256:
  `saved_checkpoint_changed` (**fails**).
- A saved seq that is no longer listed: `saved_checkpoint_gone` (**fails**).
- Saved hashes for the same bucket and organization under a different
  generation: `stream_generation_changed` (warning). Expected after a database
  rebuild; otherwise treat it as a rewrite.

### 5. Check the records

Build a map of record id to (seq, SHA-256, upload time) from every `records`
object, and a map of record id to its disposal leaf from every `disposal`
object.

For each line of `records.jsonl`:

| Situation | Status | Code |
|---|---|---|
| `record` is not a JSON object whose `id` equals the line's `id` (no other check applies) | tampered | `record_invalid` (**fails**) |
| Listed in a checkpoint, and the SHA-256 of `record` matches | ok | |
| Listed in a checkpoint, and it does not match | tampered | `record_changed` (**fails**) |
| Not listed, and `checkpoint_seq` is null or above the highest uploaded seq | pending | |
| Not listed, and `checkpoint_seq` names an uploaded checkpoint (including one the audit checker could not read) | tampered | `record_unlisted` (**fails**) |
| Also announced as deleted | tampered | `disposed_but_present` (**fails**) |

For `record_changed`, if `checkpointed_record` is present and its SHA-256
matches the checkpoint, show which top-level fields differ, with both values.

Then check each exported record's signature, pending ones included (skip a
`record_invalid` one). Its **signature state** is the first that applies:

| Situation | Signature | Status | Code |
|---|---|---|---|
| `verifier_signature` is not of the form `ed25519:<16 lowercase hex>:<128 lowercase hex>` | `unsigned` | unchanged | |
| No `signed_record` in the export | `invalid` | tampered | `signed_record_missing` (**fails**) |
| `signed_record` is not a JSON object with every field above, of the right type, and `format` 1, or its `key_id` differs from the one in `verifier_signature` | `invalid` | tampered | `signature_invalid` (**fails**) |
| The key is not in the manifest's `keys`, or is not trusted | `unverified` | unchanged | `signature_key_unknown` (warning) |
| The signature does not verify with the key | `invalid` | tampered | `signature_invalid` (**fails**) |
| A signed value differs from the record's | `invalid` | tampered | `signed_field_mismatch` (**fails**) |
| The signed `timestamp` is before the key's upload time | `unverified` | unchanged | `signature_predates_key` (warning) |
| Otherwise | `valid` | unchanged | |

For `signed_field_mismatch`, name each differing field with both values, the
record's first, as in `response_level is "allow", was signed as "block"`. A
record whose key is unknown cannot have its signature checked, so its signed
values are not compared either.

Then, for every leaf of every `records` object with `from_seq ≤ seq ≤ to_seq`
(or `from_seq ≤ seq` when `to_seq` is null) whose id has no line in
`records.jsonl`:

| Situation | Status | Code |
|---|---|---|
| Announced by a disposal leaf with the same SHA-256 and `checkpoint_seq` | deleted | (none; `record_deleted_unexplained`, **fails**, when the reason is `unattributed`) |
| Announced, but the SHA-256 or `checkpoint_seq` differs | tampered | `disposal_mismatch` (**fails**) |
| Not announced | missing | `record_missing` (**fails**) |

A deletion is announced in the first hourly run after it, so a record deleted in
the last hour shows as missing until then. Say so in the report, and suggest
verifying again after the next checkpoint. A record still missing then was
removed without notice.

### 6. Report

Report the stream (bucket, generation, organization), the checkpoints (count,
first and last upload time, earliest lock expiry), the count of records in each
status, the count of exported records by signature state, each record's
signature state, and every finding. Verification passes when no finding
**fails**.

A record whose signature is `valid` was reported by that Verifier with the
signed values; the claim is "signed by the Verifier and unchanged since". An
`unsigned` record makes no claim about who wrote it.

For records that existed before checkpoints began, the claim is "unchanged since
its checkpoint was uploaded", and the report should give that time.

## Replaying a session

A **session** is the records sharing one `correlation_id`. A replay walks a
session's exported records in order and shows, for each, what was decided and
what can be checked about it. It does not re-run any policy: many policies ask
a model, so a different verdict would not prove tampering, nor the same verdict
integrity.

### Archive links

To check archived messages, an export made for a session carries presigned
links to each archived message object in the manifest:

```json
"archives": [{"archive_ref": "…", "url": "https://…"}]
```

The bytes need no trusted source: a signed record names the SHA-256 of its
archived object, so any bytes with that hash are the archived ones. An audit checker
fetches only `https` links, refuses redirects, and treats a link it cannot read
as unavailable.

### Steps

1. Verify the bundle as above.
2. Take every exported record whose `correlation_id` equals the session's, in
   order of `timestamp` (as an instant), then `id`.
3. For each, report its time, agent, direction, sender and recipient, event
   type, `response_level`, its status and codes from verification, its
   signature state, and the checkpoint that lists it (seq and upload time).
4. Its **archive state** is the first that applies:

| Situation | Archive | Code |
|---|---|---|
| No `archive_ref` | `none` | |
| The signature is not `valid`, or its signed `archive_sha256` is `null` | `not_signed` | |
| No link for the `archive_ref`, or the link cannot be read (not HTTP 200) | `unavailable` | `archive_unavailable` (warning) |
| The object's SHA-256 equals the signed `archive_sha256` | `matches` | |
| Otherwise | `changed` | `archive_changed` (**fails**) |

An archived object may be gone because the organization's retention removed
it; `unavailable` says no more than that it could not be read. A replay passes
when the verification passes and no archive is `changed`.

## Test vectors

`testdata/scenarios/` holds example bundles with the S3 state an audit checker
would read and the expected outcome of each; `testdata/s3-xml/` holds real
`ListObjectVersions` responses from an Object Lock bucket. See
`testdata/README.md`.
