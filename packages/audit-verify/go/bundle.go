// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// LoadBundle reads manifest.json and records.jsonl from an export directory.
func LoadBundle(dir string) (*Bundle, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, fmt.Errorf("reading the export: %w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("manifest.json: %w", err)
	}
	if err := ValidateManifest(&manifest); err != nil {
		return nil, err
	}
	f, err := os.Open(filepath.Join(dir, "records.jsonl"))
	if err != nil {
		return nil, fmt.Errorf("reading the export: %w", err)
	}
	defer f.Close()
	records, err := ParseRecordsJSONL(f)
	if err != nil {
		return nil, err
	}
	return &Bundle{Manifest: manifest, Records: records}, nil
}

// ParseRecordsJSONL parses records.jsonl. It fails on a malformed line and
// names it.
func ParseRecordsJSONL(r io.Reader) ([]ExportedRecord, error) {
	reader := bufio.NewReader(r)
	var out []ExportedRecord
	for n := 1; ; n++ {
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			record, perr := parseRecordLine(line)
			if perr != nil {
				return nil, fmt.Errorf("records.jsonl line %d %s", n, perr.Error())
			}
			out = append(out, record)
		}
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, fmt.Errorf("reading records.jsonl: %w", err)
		}
	}
}

func parseRecordLine(line []byte) (ExportedRecord, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(line, &fields); err != nil || fields == nil {
		return ExportedRecord{}, errors.New("is not JSON")
	}
	bad := errors.New("is not an exported record")
	var rec ExportedRecord
	if json.Unmarshal(fields["id"], &rec.ID) != nil || fields["id"] == nil {
		return rec, bad
	}
	if json.Unmarshal(fields["record"], &rec.Record) != nil || fields["record"] == nil {
		return rec, bad
	}
	seq, ok := fields["checkpoint_seq"]
	if !ok {
		return rec, bad
	}
	if string(bytes.TrimSpace(seq)) != "null" {
		var v any
		if json.Unmarshal(seq, &v) != nil {
			return rec, bad
		}
		n, ok := positiveInt(v)
		if !ok {
			return rec, bad
		}
		rec.CheckpointSeq = &n
	}
	if cr, ok := fields["checkpointed_record"]; ok {
		var text string
		if json.Unmarshal(cr, &text) != nil {
			return rec, bad
		}
		rec.CheckpointedRecord = &text
	}
	if sr, ok := fields["signed_record"]; ok {
		var text string
		if json.Unmarshal(sr, &text) != nil {
			return rec, bad
		}
		rec.SignedRecord = &text
	}
	return rec, nil
}

// ValidateManifest fails when the manifest is too malformed to verify at all.
func ValidateManifest(m *Manifest) error {
	bad := func(why string) error { return fmt.Errorf("manifest.json: %s", why) }
	if m.Format != Format {
		return bad(fmt.Sprintf("unsupported format %d", m.Format))
	}
	for name, value := range map[string]string{
		"bucket": m.Bucket, "region": m.Region, "generation": m.Generation,
		"stream": m.Stream, "prefix": m.Prefix,
	} {
		if value == "" {
			return bad("missing " + name)
		}
	}
	if len(m.Listing) == 0 {
		return bad("no listing URLs")
	}
	seen := map[int64]bool{}
	for _, c := range m.Checkpoints {
		if c.Seq < 1 || c.URL == "" || c.SHA256 == "" || c.Kind == "" {
			return bad("a checkpoint entry is malformed")
		}
		if seen[c.Seq] {
			return bad(fmt.Sprintf("checkpoint %d is listed twice", c.Seq))
		}
		seen[c.Seq] = true
	}
	if m.Keys != nil {
		if m.Keys.Listing == "" {
			return bad("the keys have no listing URL")
		}
		keys := map[string]bool{}
		for _, k := range m.Keys.Objects {
			if k.KeyID == "" || k.URL == "" {
				return bad("a key entry is malformed")
			}
			if keys[k.KeyID] {
				return bad(fmt.Sprintf("key %s is listed twice", k.KeyID))
			}
			keys[k.KeyID] = true
		}
	}
	return nil
}

// positiveInt accepts a JSON number that is a whole number of at least 1, as
// JavaScript's Number.isInteger does.
func positiveInt(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || f < 1 || f != float64(int64(f)) {
		return 0, false
	}
	return int64(f), true
}
