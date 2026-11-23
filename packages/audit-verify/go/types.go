// SPDX-License-Identifier: Apache-2.0

// Package auditverify verifies a Spellguard audit export against its
// checkpoints in S3 Object Lock. The format and every check are described in
// SPEC.md at the root of this package's directory; this code follows it
// section by section, as does the TypeScript implementation beside it.
package auditverify

import "encoding/json"

// Format is the only checkpoint, record and bundle format this package reads.
const Format = 1

// ProductionBucket is the only bucket a verifier allows unless told otherwise.
const ProductionBucket = "spellguard-audit-checkpoints-production"

// ListPageSeqs is the stride of the listing pages: page i starts after the key
// of seq i × ListPageSeqs.
const ListPageSeqs = 500

// KeysPrefix is where Verifier audit signing keys are published.
const KeysPrefix = "audit-checkpoints/keys/"

// ManifestKey is one published Verifier key, with a presigned link to read it.
type ManifestKey struct {
	KeyID string `json:"key_id"`
	URL   string `json:"url"`
}

// ManifestKeys lists the Verifier keys: a listing of KeysPrefix and a link to
// each key object.
type ManifestKeys struct {
	Listing string        `json:"listing"`
	Objects []ManifestKey `json:"objects"`
}

// ManifestCheckpoint is Spellguard's claim about one uploaded checkpoint, with
// a presigned link to read it.
type ManifestCheckpoint struct {
	Seq       int64  `json:"seq"`
	Kind      string `json:"kind"`
	WrittenAt string `json:"written_at"`
	LeafCount int64  `json:"leaf_count"`
	SHA256    string `json:"sha256"`
	URL       string `json:"url"`
}

// RecordsRange says which records a bundle holds. A nil ToSeq means no upper
// bound.
type RecordsRange struct {
	FromSeq int64  `json:"from_seq"`
	ToSeq   *int64 `json:"to_seq"`
	Pending bool   `json:"pending"`
}

// Manifest is manifest.json.
type Manifest struct {
	Format       int                  `json:"format"`
	ExportedAt   string               `json:"exported_at"`
	Bucket       string               `json:"bucket"`
	Region       string               `json:"region"`
	Generation   string               `json:"generation"`
	Stream       string               `json:"stream"`
	Prefix       string               `json:"prefix"`
	URLsExpireAt string               `json:"urls_expire_at"`
	Listing      []string             `json:"listing"`
	Checkpoints  []ManifestCheckpoint `json:"checkpoints"`
	// Records is absent in older bundles: every checkpoint in Checkpoints,
	// plus pending records.
	Records *RecordsRange `json:"records,omitempty"`
	// Keys is absent in bundles exported before records were signed.
	Keys *ManifestKeys `json:"keys,omitempty"`
	// Archives links archived message objects, for replaying a session.
	Archives []ManifestArchive `json:"archives,omitempty"`
}

// ManifestArchive is a link to one archived message object.
type ManifestArchive struct {
	ArchiveRef string `json:"archive_ref"`
	URL        string `json:"url"`
}

// ExportedRecord is one line of records.jsonl.
type ExportedRecord struct {
	ID                 string  `json:"id"`
	CheckpointSeq      *int64  `json:"checkpoint_seq"`
	Record             string  `json:"record"`
	CheckpointedRecord *string `json:"checkpointed_record,omitempty"`
	// SignedRecord is the exact text the Verifier signed, for signed records.
	SignedRecord *string `json:"signed_record,omitempty"`
}

// Bundle is an export: the manifest and the records.
type Bundle struct {
	Manifest Manifest
	Records  []ExportedRecord
}

// SavedStream is what a verifier remembers about a stream between runs.
type SavedStream struct {
	Bucket     string `json:"bucket"`
	Generation string `json:"generation"`
	Stream     string `json:"stream"`
	// Checkpoints maps seq, as a decimal string, to the object's SHA-256.
	Checkpoints map[string]string `json:"checkpoints"`
	VerifiedAt  string            `json:"verified_at"`
}

// Finding codes, exactly as named in SPEC.md.
const (
	CodeBucketNotAllowed         = "bucket_not_allowed"
	CodeURLMismatch              = "url_mismatch"
	CodeListingIncomplete        = "listing_incomplete"
	CodeUnexpectedKey            = "unexpected_key"
	CodeDeleteMarker             = "delete_marker"
	CodeExtraVersion             = "extra_version"
	CodeCheckpointMissing        = "checkpoint_missing"
	CodeCheckpointNotExported    = "checkpoint_not_exported"
	CodeCheckpointUnreadable     = "checkpoint_unreadable"
	CodeVersionMismatch          = "version_mismatch"
	CodeNotLocked                = "not_locked"
	CodeCheckpointInvalid        = "checkpoint_invalid"
	CodeChainBroken              = "chain_broken"
	CodeLedgerMismatch           = "ledger_mismatch"
	CodeDuplicateLeaf            = "duplicate_leaf"
	CodeCheckpointsBeyondExport  = "checkpoints_beyond_export"
	CodeStreamStale              = "stream_stale"
	CodeSavedCheckpointChanged   = "saved_checkpoint_changed"
	CodeSavedCheckpointGone      = "saved_checkpoint_gone"
	CodeStreamGenerationChanged  = "stream_generation_changed"
	CodeStateNotSaved            = "state_not_saved"
	CodeRecordInvalid            = "record_invalid"
	CodeRecordChanged            = "record_changed"
	CodeRecordUnlisted           = "record_unlisted"
	CodeDisposedButPresent       = "disposed_but_present"
	CodeRecordDeletedUnexplained = "record_deleted_unexplained"
	CodeDisposalMismatch         = "disposal_mismatch"
	CodeRecordMissing            = "record_missing"
	CodeKeyInvalid               = "key_invalid"
	CodeSignedRecordMissing      = "signed_record_missing"
	CodeSignatureInvalid         = "signature_invalid"
	CodeSignedFieldMismatch      = "signed_field_mismatch"
	CodeSignatureKeyUnknown      = "signature_key_unknown"
	CodeSignaturePredatesKey     = "signature_predates_key"
	CodeArchiveUnavailable       = "archive_unavailable"
	CodeArchiveChanged           = "archive_changed"
)

// Signature states of an exported record.
const (
	SignatureValid      = "valid"
	SignatureUnsigned   = "unsigned"
	SignatureUnverified = "unverified"
	SignatureInvalid    = "invalid"
)

// Severities.
const (
	SeverityFail    = "fail"
	SeverityWarning = "warning"
	SeverityInfo    = "info"
)

// Record statuses.
const (
	StatusOK       = "ok"
	StatusPending  = "pending"
	StatusDeleted  = "deleted"
	StatusMissing  = "missing"
	StatusTampered = "tampered"
)

// Finding is one result of a check. Verification passes when no finding fails.
type Finding struct {
	Code     string  `json:"code"`
	Fails    bool    `json:"fails"`
	Severity string  `json:"severity"`
	Seq      *int64  `json:"seq"`
	RecordID *string `json:"record_id"`
	// KeyID names the Verifier key a key finding is about.
	KeyID   *string `json:"key_id,omitempty"`
	Message string  `json:"message"`
}

// FieldDiff is one top-level field that changed after its checkpoint.
type FieldDiff struct {
	Field string          `json:"field"`
	Now   json.RawMessage `json:"now"`
	Was   json.RawMessage `json:"was"`
}

// RecordResult is the outcome for one record.
type RecordResult struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"`
	Seq        *int64  `json:"seq"`
	UploadedAt *string `json:"uploaded_at"`
	// Record is the exported record text; absent for deleted and missing ones.
	Record json.RawMessage `json:"record,omitempty"`
	Reason string          `json:"reason,omitempty"`
	Diff   []FieldDiff     `json:"diff,omitempty"`
	// Signature is the record's signature state; empty for deleted, missing
	// and invalid records.
	Signature string `json:"signature,omitempty"`
	// SignedBy is the key id of a signed record.
	SignedBy *string `json:"signed_by,omitempty"`
	// SignedDiff lists signed fields whose value differs from the record's:
	// Now is the record's value, Was the signed one.
	SignedDiff []FieldDiff `json:"signed_diff,omitempty"`
	Codes      []string    `json:"codes"`
}

// ReportStream names the stream that was verified.
type ReportStream struct {
	Bucket       string `json:"bucket"`
	Region       string `json:"region"`
	Generation   string `json:"generation"`
	Organization string `json:"organization"`
}

// KindCounts counts the checkpoints read, by kind.
type KindCounts struct {
	Records   int `json:"records"`
	Disposal  int `json:"disposal"`
	Heartbeat int `json:"heartbeat"`
}

// CheckpointSummary describes the stream's checkpoints. Times come from S3.
type CheckpointSummary struct {
	Count              int        `json:"count"`
	FirstUploadedAt    *string    `json:"first_uploaded_at"`
	LastUploadedAt     *string    `json:"last_uploaded_at"`
	EarliestLockExpiry *string    `json:"earliest_lock_expiry"`
	ByKind             KindCounts `json:"by_kind"`
}

// Counts counts records by status.
type Counts struct {
	OK       int `json:"ok"`
	Pending  int `json:"pending"`
	Deleted  int `json:"deleted"`
	Missing  int `json:"missing"`
	Tampered int `json:"tampered"`
}

// SignatureCounts counts exported records by signature state.
type SignatureCounts struct {
	Valid      int `json:"valid"`
	Unsigned   int `json:"unsigned"`
	Unverified int `json:"unverified"`
	Invalid    int `json:"invalid"`
}

// Report is the result of Verify. It marshals to the same JSON as the
// TypeScript implementation's report.
type Report struct {
	OK          bool              `json:"ok"`
	Stream      ReportStream      `json:"stream"`
	Checkpoints CheckpointSummary `json:"checkpoints"`
	Counts      Counts            `json:"counts"`
	Signatures  SignatureCounts   `json:"signatures"`
	Records     []RecordResult    `json:"records"`
	Findings    []Finding         `json:"findings"`
}
