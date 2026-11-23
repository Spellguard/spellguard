# Spellguard audit verifier

Checks a Spellguard audit export against its checkpoints, on your own machine,
without trusting Spellguard.

## What it proves

Spellguard writes an hourly checkpoint for your organization: a list of the
SHA-256 of every new audit record, chained to the previous checkpoint. The
checkpoints are stored in Amazon S3 with Object Lock in compliance mode, which
nobody, including Spellguard and the AWS account's root user, can remove or
shorten.

The verifier reads those checkpoints straight from S3 and checks every record
in your export against them. Any change to a record after its checkpoint, or
any deletion that was not announced, is reported, even one Spellguard made.

Records a Spellguard Verifier reported also carry its Ed25519 signature, made
before the record reached Spellguard's database, over the values that matter
(the decision, the policy checks, who sent what to whom, and when). Each
Verifier's public key is published in the same locked bucket, and the verifier
checks every signature against it, so a change to a signed value is caught even
if it was made before the first checkpoint.

It does not prove:

- that a record was true when it was written: a Verifier signs what it saw;
- anything about an unsigned record before its first checkpoint, up to about an
  hour after it was written, or a deletion in that hour;
- anything about records you did not export.

[SPEC.md](SPEC.md) describes the formats and every check, so you can write your
own verifier instead.

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

`ts/` is the same verifier for browsers and Node 20+, with no dependencies:

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
