// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

type recordLeaf struct {
	ID     string
	SHA256 string
}

type disposalLeaf struct {
	ID            string
	SHA256        string
	CheckpointSeq int64
}

type parsedCheckpoint struct {
	Kind          string
	Previous      *string
	Reason        string
	RetentionDays *int64
	Records       []recordLeaf
	Disposals     []disposalLeaf
}

func (p *parsedCheckpoint) leafCount() int64 {
	return int64(len(p.Records) + len(p.Disposals))
}

var reasons = map[string]bool{
	"retention": true, "owner_purge": true, "organization_deletion": true, "unattributed": true,
}

func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// isoTime formats a time as JavaScript's toISOString does.
func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000") + "Z"
}

func isoPtr(t time.Time, ok bool) *string {
	if !ok {
		return nil
	}
	s := isoTime(t)
	return &s
}

func stringField(fields map[string]any, name string) (string, bool) {
	s, ok := fields[name].(string)
	return s, ok
}

// parseCheckpoint checks an object body against the format, returning why it
// is not a valid checkpoint when it is not.
func parseCheckpoint(data []byte, m *Manifest, seq int64) (*parsedCheckpoint, string) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&value); err != nil {
		return nil, "it is not JSON"
	}
	if decoder.More() {
		return nil, "it is not JSON"
	}
	fields, ok := value.(map[string]any)
	if !ok {
		return nil, "it is not a JSON object"
	}
	if f, ok := fields["format"].(float64); !ok || f != Format {
		return nil, fmt.Sprintf("format is %s", compactValue(fields["format"]))
	}
	if g, _ := stringField(fields, "generation"); g != m.Generation {
		return nil, "it names another generation"
	}
	if s, _ := stringField(fields, "stream"); s != m.Stream {
		return nil, "it names another stream"
	}
	if s, ok := fields["seq"].(float64); !ok || s != float64(seq) {
		return nil, fmt.Sprintf("it says seq %s", compactValue(fields["seq"]))
	}
	out := &parsedCheckpoint{}
	previous, present := fields["previous_sha256"]
	if seq == 1 {
		if !present || previous != nil {
			return nil, "previous_sha256 is malformed"
		}
	} else {
		p, ok := previous.(string)
		if !ok || !hex64.MatchString(p) {
			return nil, "previous_sha256 is malformed"
		}
		out.Previous = &p
	}
	if w, _ := stringField(fields, "written_at"); !validWrittenAt(w) {
		return nil, "written_at is malformed"
	}
	leaves, ok := fields["leaves"].([]any)
	if !ok {
		return nil, "leaves is missing"
	}
	kind, _ := stringField(fields, "kind")
	out.Kind = kind
	switch kind {
	case "records":
		for _, l := range leaves {
			leaf, ok := l.(map[string]any)
			id, idOK := stringField(leaf, "id")
			sum, sumOK := stringField(leaf, "sha256")
			if !ok || !idOK || id == "" || !sumOK || !hex64.MatchString(sum) {
				return nil, "a leaf is malformed"
			}
			out.Records = append(out.Records, recordLeaf{ID: id, SHA256: sum})
		}
	case "disposal":
		reason, ok := stringField(fields, "reason")
		if !ok || !reasons[reason] {
			return nil, "reason is malformed"
		}
		out.Reason = reason
		if days := fields["retention_days"]; days != nil {
			n, ok := positiveInt(days)
			if !ok {
				return nil, "retention_days is malformed"
			}
			out.RetentionDays = &n
		} else if _, present := fields["retention_days"]; !present {
			return nil, "retention_days is malformed"
		}
		if (reason == "retention") != (out.RetentionDays != nil) {
			return nil, "retention_days does not match the reason"
		}
		for _, l := range leaves {
			leaf, ok := l.(map[string]any)
			id, idOK := stringField(leaf, "id")
			sum, sumOK := stringField(leaf, "sha256")
			from, fromOK := positiveInt(leaf["checkpoint_seq"])
			if !ok || !idOK || id == "" || !sumOK || !hex64.MatchString(sum) || !fromOK || from >= seq {
				return nil, "a leaf is malformed"
			}
			out.Disposals = append(out.Disposals, disposalLeaf{ID: id, SHA256: sum, CheckpointSeq: from})
		}
	case "heartbeat":
		if len(leaves) != 0 {
			return nil, "a heartbeat has leaves"
		}
	default:
		return nil, fmt.Sprintf("kind is %s", compactValue(fields["kind"]))
	}
	return out, ""
}

// validWrittenAt accepts the timestamps checkpoints carry (ISO 8601, UTC).
func validWrittenAt(s string) bool {
	_, ok := parseTime(s)
	return ok
}

func compactValue(v any) string {
	if v == nil {
		return "null"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}
