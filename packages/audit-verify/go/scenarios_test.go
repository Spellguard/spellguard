// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

const scenarioDir = "../testdata/scenarios"

type expectedOutcome struct {
	Now            string                     `json:"now"`
	AllowedBuckets []string                   `json:"allowed_buckets"`
	OK             bool                       `json:"ok"`
	Counts         Counts                     `json:"counts"`
	Signatures     SignatureCounts            `json:"signatures"`
	Codes          []string                   `json:"codes"`
	Diffs          map[string]json.RawMessage `json:"diffs"`
	SignedDiffs    map[string]json.RawMessage `json:"signed_diffs"`
	Replay         *expectedReplay            `json:"replay"`
}

type expectedReplay struct {
	Session  string            `json:"session"`
	OK       bool              `json:"ok"`
	Codes    []string          `json:"codes"`
	Archives map[string]string `json:"archives"`
	Order    []string          `json:"order"`
}

func checkReplay(t *testing.T, sc scenario) {
	t.Helper()
	want := sc.expected.Replay
	report, err := Replay(context.Background(), sc.bundle, want.Session, sc.options(t, MemoryState(sc.state)))
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	codes := []string{}
	seen := map[string]bool{}
	for _, f := range report.Findings {
		if !seen[f.Code] {
			seen[f.Code] = true
			codes = append(codes, f.Code)
		}
	}
	sort.Strings(codes)
	if want.Codes == nil {
		want.Codes = []string{}
	}
	order := []string{}
	archives := map[string]string{}
	for _, r := range report.Records {
		order = append(order, r.ID)
		archives[r.ID] = r.Archive
	}
	if report.OK != want.OK || !reflect.DeepEqual(codes, want.Codes) || !reflect.DeepEqual(order, want.Order) || !reflect.DeepEqual(archives, want.Archives) {
		t.Fatalf("replay: got ok=%v codes=%v order=%v archives=%v\nwant %+v", report.OK, codes, order, archives, *want)
	}
}

type scenario struct {
	bundle   *Bundle
	s3       *fakeS3
	state    map[string]*SavedStream
	expected expectedOutcome
}

func loadScenario(t *testing.T, name string) scenario {
	t.Helper()
	dir := filepath.Join(scenarioDir, name)
	bundle, err := LoadBundle(dir)
	if err != nil {
		t.Fatalf("LoadBundle: %v", err)
	}
	s3, err := loadFakeS3(filepath.Join(dir, "s3.json"))
	if err != nil {
		t.Fatalf("s3.json: %v", err)
	}
	var sc scenario
	sc.bundle, sc.s3 = bundle, s3
	raw, err := os.ReadFile(filepath.Join(dir, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &sc.expected); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "state.json")); err == nil {
		var file stateFile
		if err := json.Unmarshal(raw, &file); err != nil {
			t.Fatal(err)
		}
		sc.state = file.Streams
	}
	return sc
}

func (sc scenario) options(t *testing.T, state StateStore) Options {
	t.Helper()
	now, err := time.Parse(time.RFC3339Nano, sc.expected.Now)
	if err != nil {
		t.Fatal(err)
	}
	return Options{
		AllowedBuckets: sc.expected.AllowedBuckets,
		Now:            now,
		HTTPClient:     &http.Client{Transport: sc.s3},
		State:          state,
	}
}

func scenarioNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(scenarioDir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

func normalize(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSharedScenarios(t *testing.T) {
	names := scenarioNames(t)
	if len(names) < 29 {
		t.Fatalf("found %d scenarios, want at least 29", len(names))
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			sc := loadScenario(t, name)
			report, err := Verify(context.Background(), sc.bundle, sc.options(t, MemoryState(sc.state)))
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			codes := []string{}
			seen := map[string]bool{}
			for _, f := range report.Findings {
				if !seen[f.Code] {
					seen[f.Code] = true
					codes = append(codes, f.Code)
				}
			}
			sort.Strings(codes)
			want := sc.expected.Codes
			if want == nil {
				want = []string{}
			}
			if report.OK != sc.expected.OK || report.Counts != sc.expected.Counts || report.Signatures != sc.expected.Signatures || !reflect.DeepEqual(codes, want) {
				t.Fatalf("got ok=%v counts=%+v signatures=%+v codes=%v\nwant ok=%v counts=%+v signatures=%+v codes=%v\nfindings: %+v",
					report.OK, report.Counts, report.Signatures, codes, sc.expected.OK, sc.expected.Counts, sc.expected.Signatures, want, report.Findings)
			}
			checkDiffs := func(expected map[string]json.RawMessage, pick func(RecordResult) []FieldDiff) {
				for id, diff := range expected {
					var got []FieldDiff
					for _, r := range report.Records {
						if r.ID == id {
							got = pick(r)
						}
					}
					var wantDiff any
					if err := json.Unmarshal(diff, &wantDiff); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(normalize(t, got), wantDiff) {
						t.Fatalf("diff for %s: got %s", id, normalize(t, got))
					}
				}
			}
			checkDiffs(sc.expected.SignedDiffs, func(r RecordResult) []FieldDiff { return r.SignedDiff })
			if sc.expected.Replay != nil {
				checkReplay(t, sc)
			}
			for id, diff := range sc.expected.Diffs {
				var got []FieldDiff
				for _, r := range report.Records {
					if r.ID == id {
						got = r.Diff
					}
				}
				var wantDiff any
				if err := json.Unmarshal(diff, &wantDiff); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(normalize(t, got), wantDiff) {
					t.Fatalf("diff for %s: got %s", id, normalize(t, got))
				}
			}
		})
	}
}

func TestSavesVerifiedCheckpointsOnce(t *testing.T) {
	sc := loadScenario(t, "pass")
	state := MemoryState(nil)
	for run := 0; run < 2; run++ {
		report, err := Verify(context.Background(), sc.bundle, sc.options(t, state))
		if err != nil || !report.OK {
			t.Fatalf("run %d: ok=%v err=%v findings=%+v", run, report != nil && report.OK, err, report)
		}
	}
	saved, _ := state.Load(StateKey(sc.bundle.Manifest.Bucket, sc.bundle.Manifest.Generation, sc.bundle.Manifest.Stream))
	if len(saved.Checkpoints) != 5 || saved.Checkpoints["2"] != sc.bundle.Manifest.Checkpoints[1].SHA256 {
		t.Fatalf("saved %+v", saved.Checkpoints)
	}
}

func TestDoesNotSaveAFailedCheckpoint(t *testing.T) {
	sc := loadScenario(t, "chain_broken")
	state := MemoryState(nil)
	if _, err := Verify(context.Background(), sc.bundle, sc.options(t, state)); err != nil {
		t.Fatal(err)
	}
	saved, _ := state.Load(StateKey(sc.bundle.Manifest.Bucket, sc.bundle.Manifest.Generation, sc.bundle.Manifest.Stream))
	if _, ok := saved.Checkpoints["5"]; ok || len(saved.Checkpoints) != 4 {
		t.Fatalf("saved %+v", saved.Checkpoints)
	}
}

func TestFileStateRoundTrip(t *testing.T) {
	sc := loadScenario(t, "pass")
	path := filepath.Join(t.TempDir(), "nested", "state.json")
	if _, err := Verify(context.Background(), sc.bundle, sc.options(t, FileState(path))); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode %v", info.Mode().Perm())
	}
	var file stateFile
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &file); err != nil || file.Format != 1 || len(file.Streams) != 1 {
		t.Fatalf("state file %s", raw)
	}
	// A rewritten checkpoint is caught against the saved file on the next run.
	changed := loadScenario(t, "pass")
	for i := range changed.s3.entries {
		if strings.HasSuffix(changed.s3.entries[i].Key, "000000000002.json") {
			changed.s3.entries[i].Body = strings.Replace(changed.s3.entries[i].Body, `"kind":"records"`, `"kind":"records" `, 1)
		}
	}
	report, err := Verify(context.Background(), changed.bundle, changed.options(t, FileState(path)))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range report.Findings {
		found = found || f.Code == CodeSavedCheckpointChanged
	}
	if !found || report.OK {
		t.Fatalf("want saved_checkpoint_changed, got %+v", report.Findings)
	}
}

func TestReportShape(t *testing.T) {
	sc := loadScenario(t, "record_changed")
	report, err := Verify(context.Background(), sc.bundle, sc.options(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	c := report.Checkpoints
	if c.Count != 5 || *c.FirstUploadedAt != "2026-11-10T00:17:04.000Z" || *c.LastUploadedAt != "2026-11-10T04:17:04.000Z" ||
		*c.EarliestLockExpiry != "2026-11-11T01:17:04.000Z" || c.ByKind != (KindCounts{Records: 3, Disposal: 1, Heartbeat: 1}) {
		t.Fatalf("checkpoints %+v", c)
	}
	var buf bytes.Buffer
	if err := report.WriteText(&buf); err != nil {
		t.Fatal(err)
	}
	text := buf.String()
	for _, want := range []string{
		`response_level is "allow", was checkpointed as "block"`,
		"TAMPERED", "FAILED: 1 problem.",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("report text lacks %q:\n%s", want, text)
		}
	}
	// The JSON matches the TypeScript report's field names.
	var decoded map[string]any
	raw, _ := json.Marshal(report)
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"ok", "stream", "checkpoints", "counts", "records", "findings"} {
		if _, ok := decoded[field]; !ok {
			t.Fatalf("report JSON lacks %q", field)
		}
	}
	records := decoded["records"].([]any)
	first := records[0].(map[string]any)
	for _, field := range []string{"id", "status", "seq", "uploaded_at", "record", "codes"} {
		if _, ok := first[field]; !ok {
			t.Fatalf("record JSON lacks %q: %v", field, first)
		}
	}
	finding := decoded["findings"].([]any)[0].(map[string]any)
	for _, field := range []string{"code", "fails", "severity", "seq", "record_id", "message"} {
		if _, ok := finding[field]; !ok {
			t.Fatalf("finding JSON lacks %q", field)
		}
	}
}

func TestMissingRecordExplainsTheAnnouncementDelay(t *testing.T) {
	sc := loadScenario(t, "record_missing")
	report, err := Verify(context.Background(), sc.bundle, sc.options(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	_ = report.WriteText(&buf)
	if !strings.Contains(buf.String(), "first hourly checkpoint after it") {
		t.Fatalf("no announcement note:\n%s", buf.String())
	}
}

func TestExpiredLinksStopVerification(t *testing.T) {
	sc := loadScenario(t, "pass")
	opts := sc.options(t, nil)
	opts.HTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return respond(req, http.StatusForbidden, nil, "<Error><Code>AccessDenied</Code></Error>"), nil
	})}
	_, err := Verify(context.Background(), sc.bundle, opts)
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") || !strings.Contains(err.Error(), "expire") {
		t.Fatalf("err = %v", err)
	}
}

func TestRedirectsAreRefused(t *testing.T) {
	sc := loadScenario(t, "pass")
	opts := sc.options(t, nil)
	listing := sc.s3
	opts.HTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/" {
			return listing.RoundTrip(req)
		}
		h := http.Header{}
		h.Set("Location", "https://evil.example.com/x")
		return respond(req, http.StatusFound, h, ""), nil
	})}
	report, err := Verify(context.Background(), sc.bundle, opts)
	if err != nil {
		t.Fatal(err)
	}
	if report.OK {
		t.Fatal("a redirected checkpoint read passed")
	}
	// A redirected key read leaves the key untrusted, so its signatures go
	// unchecked rather than counting.
	allowed := map[string]bool{
		CodeCheckpointUnreadable: true, CodeRecordUnlisted: true,
		CodeKeyInvalid: true, CodeSignatureKeyUnknown: true,
	}
	for _, f := range report.Findings {
		if !allowed[f.Code] {
			t.Fatalf("unexpected finding %+v", f)
		}
	}
	if report.Signatures.Valid != 0 {
		t.Fatalf("signatures counted with a redirected key read: %+v", report.Signatures)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
