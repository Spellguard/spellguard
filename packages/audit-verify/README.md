# Spellguard audit checker

Checks a Spellguard audit export against its checkpoints, on your own machine,
without trusting Spellguard.

The audit checker is not the Spellguard Verifier. The Verifier is the service
that checks agent traffic against policy and signs the audit records it reports;
the audit checker checks those records afterwards.

## What it proves

Spellguard writes an hourly checkpoint for your organization: a list of the
SHA-256 of every new audit record, chained to the previous checkpoint. The
checkpoints are stored in Amazon S3 with Object Lock in compliance mode, which
nobody, including Spellguard and the AWS account's root user, can remove or
shorten.

The audit checker reads those checkpoints straight from S3 and checks every record
in your export against them. Any change to a record after its checkpoint, or
any deletion that was not announced, is reported, even one Spellguard made.

Records a Spellguard Verifier reported also carry its Ed25519 signature, made
before the record reached Spellguard's database, over the values that matter
(the decision, the policy checks, who sent what to whom, and when). Each
Verifier's public key is published in the same locked bucket, and the audit checker
checks every signature against it, so a change to a signed value is caught even
if it was made before the first checkpoint.

It does not prove:

- that a record was true when it was written: a Verifier signs what it saw;
- anything about an unsigned record before its first checkpoint, up to about an
  hour after it was written, or a deletion in that hour;
- anything about records you did not export.

[SPEC.md](SPEC.md) describes the formats and every check, so you can write your
own audit checker instead.

## How a check works

The export gives you the records. The checkpoints and Verifier keys they are
checked against come straight from Amazon S3, so Spellguard can't substitute
its own.

<img src="docs/inputs-and-output.svg" width="100%" alt="The audit checker takes records and links from a Spellguard export, reads checkpoints and Verifier public keys directly from the locked S3 bucket, optionally compares with checkpoints saved on your machine, runs six checks, and reports pass or fail, records by status, findings and an exit code.">

The audit checker runs six checks, in order:

1. **Links.** Every link in the export must point at an allowed checkpoint
   bucket. Otherwise the check stops, so nobody can point it at a copy they
   control.
2. **Checkpoints.** Each must be the original version, still under its
   compliance lock, and must carry the SHA-256 of the one before it.
   Spellguard's own list of checkpoints must agree with the bucket.
3. **Saved checkpoints.** Every checkpoint this machine verified before must
   still be there, unchanged.
4. **Records.** Each record's SHA-256 must equal the one its checkpoint holds.
5. **Signatures.** Each signed record's signature must verify against its
   Verifier's published key, and the signed values must equal the record's.
6. **Gaps.** Each record a checkpoint lists must be in the export, or its
   deletion must be announced in a later checkpoint.

<img src="docs/one-record.svg" width="100%" alt="An unchanged record hashes to the SHA-256 stored in its locked checkpoint, so it is OK. The same record with its decision changed from block to allow hashes to a different value, so it is Tampered, and the report names the field and both values.">

Change one character of a record and its SHA-256 comes out completely
different. The checkpoint still holds the original, and nobody can edit it, so
the change shows.

Each record gets one status:

| Status | Result | Meaning |
|---|---|---|
| OK | passes | Matches its checkpoint, and its signature holds if it has one |
| Pending | passes | Written since the last hourly checkpoint; a signature, if it has one, already protects it |
| Deleted | passes | Removed, and a later checkpoint announced why: retention, an owner purge, or the organization's deletion. A deletion announced as unexplained **fails** |
| Missing | **fails** | Listed in a checkpoint, missing from the export, and no deletion announced. A deletion in the last hour shows here until the next checkpoint announces it |
| Tampered | **fails** | No longer matches its checkpoint, a signed value changed, or the signature is broken |

A problem with the checkpoints themselves (one missing, unlocked, replaced, out
of the chain, or different from the copy you saved) also **fails**. Every
finding and its wording is in [SPEC.md](SPEC.md#verifying).

## Run it (Go)

You need Go 1.26 or later. From this directory:

```sh
cd go
go run ./cmd/spellguard-audit-verify /path/to/export
```

`/path/to/export` is the directory an export produced, holding `manifest.json`
and `records.jsonl`. The command prints a report and exits with 0 when
verification passes, 1 when it fails, and 2 when it could not run (for example,
when the export's S3 links have expired: export again).

Options:

- `--allow-bucket NAME` also trusts another checkpoint bucket. Only
  `spellguard-audit-checkpoints-production` is trusted by default.
- `--state FILE` keeps the checkpoints you have verified in `FILE` (default: a
  file in your user config directory). Each run compares the stream with what
  you saw before, so a rewritten stream is caught even if the bucket itself
  were gone. `--no-state` turns this off.
- `--json` prints the report as JSON.

## Use it from TypeScript

`ts/` is the same audit checker for browsers and Node 20+, with no dependencies:

```ts
import { memoryState, parseRecordsJsonl, verify } from '@spellguard/audit-verify';

const report = await verify(
  { manifest, records: parseRecordsJsonl(recordsText) },
  {
    allowedBuckets: ['spellguard-audit-checkpoints-production'],
    state: memoryState(),
  },
);
console.log(report.ok, report.counts, report.findings);
```

In a browser, `storageState(localStorage)` keeps verified checkpoints between
visits.

## Tests

Both implementations run the same test vectors in [`testdata/`](testdata):

```sh
cd go && go test ./...
```
