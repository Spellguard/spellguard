# Test vectors

Shared by the Go and TypeScript verifiers, so both agree with every outcome.

## `scenarios/`

Each directory is one case, built from the same valid stream with one thing
changed (the generator says what):

| File | What it is |
|---|---|
| `manifest.json`, `records.jsonl` | The export bundle, as SPEC.md describes it |
| `s3.json` | The bucket the verifier reads: every object version (key, version id, last-modified time, lock mode, retain-until date, body) and every delete marker. `get_status` and `get_version_id` make a read fail or answer with another version id |
| `state.json` | Optional: checkpoints saved by an earlier run, in the state file's shape |
| `expected.json` | `now`, the `allowed_buckets`, and the expected `ok`, `counts` and sorted, de-duplicated finding `codes`; `diffs` where a changed record's fields are checked |

A test serves `s3.json` from a fake S3 that answers like the real one: an XML
declaration line, then a namespaced single-line `ListVersionsResult`, keys
listed strictly after `key-marker`, at most `max-keys` entries, and GET
responses with `x-amz-version-id`, `x-amz-object-lock-mode` and
`x-amz-object-lock-retain-until-date`.

The vectors are generated. To change them, edit `generate.mjs`, then run it and
format the JSON (string contents are unaffected):

```sh
node packages/audit-verify/testdata/generate.mjs
pnpm exec biome format --write packages/audit-verify/testdata
```

Running both again produces the same bytes.

## `s3-xml/`

Two real `ListObjectVersions` responses from an S3 Object Lock bucket, with the
bucket renamed and the owner id zeroed:

- `real-list.xml`: one version, no start key.
- `real-list-after-marker.xml`: the same prefix listed after the key of seq 1,
  which returns nothing. S3 lists keys strictly after `key-marker`.
