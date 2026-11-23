// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Archive states of a replayed record (SPEC.md, "Replaying a session").
const (
	ArchiveNone        = "none"
	ArchiveNotSigned   = "not_signed"
	ArchiveUnavailable = "unavailable"
	ArchiveMatches     = "matches"
	ArchiveChanged     = "changed"
)

// ReplayRecord is one record of a replayed session.
type ReplayRecord struct {
	ID            string   `json:"id"`
	Timestamp     string   `json:"timestamp"`
	AgentID       string   `json:"agent_id"`
	Direction     string   `json:"direction"`
	SenderID      string   `json:"sender_id"`
	RecipientID   string   `json:"recipient_id"`
	EventType     string   `json:"event_type"`
	ResponseLevel string   `json:"response_level"`
	Status        string   `json:"status"`
	Codes         []string `json:"codes"`
	Signature     string   `json:"signature"`
	Seq           *int64   `json:"seq"`
	UploadedAt    *string  `json:"uploaded_at"`
	ArchiveRef    *string  `json:"archive_ref"`
	Archive       string   `json:"archive"`
}

// ReplayReport is the result of Replay.
type ReplayReport struct {
	OK      bool   `json:"ok"`
	Session string `json:"session"`
	// VerificationOK is whether the whole export verified.
	VerificationOK bool           `json:"verification_ok"`
	Records        []ReplayRecord `json:"records"`
	// Findings are the replay's own, then the verification's findings about
	// the stream or about one of the session's records.
	Findings []Finding `json:"findings"`
}

type replayLine struct {
	line   ExportedRecord
	fields map[string]json.RawMessage
	at     time.Time
}

func rawString(fields map[string]json.RawMessage, name string) string {
	var s string
	_ = json.Unmarshal(fields[name], &s)
	return s
}

// Replay verifies the bundle and walks one session's records in order, as
// SPEC.md's "Replaying a session" describes. It returns an error only when the
// bundle cannot be verified at all.
func Replay(ctx context.Context, b *Bundle, session string, opts Options) (*ReplayReport, error) {
	verification, err := Verify(ctx, b, opts)
	if err != nil {
		return nil, err
	}
	results := map[string]RecordResult{}
	for _, r := range verification.Records {
		results[r.ID] = r
	}

	var lines []replayLine
	for _, line := range b.Records {
		_, fields, err := objectFields(line.Record)
		if err != nil || rawString(fields, "correlation_id") != session || session == "" {
			continue
		}
		at, _ := parseTime(rawString(fields, "timestamp"))
		lines = append(lines, replayLine{line: line, fields: fields, at: at})
	}
	sort.SliceStable(lines, func(i, j int) bool {
		if !lines[i].at.Equal(lines[j].at) {
			return lines[i].at.Before(lines[j].at)
		}
		return lines[i].line.ID < lines[j].line.ID
	})

	links := map[string]string{}
	for _, a := range b.Manifest.Archives {
		links[a.ArchiveRef] = a.URL
	}
	client := &http.Client{Timeout: defaultTimeout}
	if opts.HTTPClient != nil {
		c := *opts.HTTPClient
		client = &c
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	findings := &findingSet{seen: map[string]bool{}}
	inSession := map[string]bool{}
	report := &ReplayReport{Session: session, VerificationOK: verification.OK, Records: []ReplayRecord{}}
	for _, l := range lines {
		id := l.line.ID
		inSession[id] = true
		result := results[id]
		rec := ReplayRecord{
			ID: id, Timestamp: rawString(l.fields, "timestamp"), AgentID: rawString(l.fields, "agent_id"),
			Direction: rawString(l.fields, "direction"), SenderID: rawString(l.fields, "sender_id"),
			RecipientID: rawString(l.fields, "recipient_id"), EventType: rawString(l.fields, "event_type"),
			ResponseLevel: rawString(l.fields, "response_level"), Status: result.Status,
			Codes: append([]string{}, result.Codes...), Signature: result.Signature,
			Seq: result.Seq, UploadedAt: result.UploadedAt,
		}
		if ref := rawString(l.fields, "archive_ref"); ref != "" {
			rec.ArchiveRef = &ref
		}
		rec.Archive = archiveState(ctx, client, rec, l.line, links, findings)
		report.Records = append(report.Records, rec)
	}

	changed := findings.has(CodeArchiveChanged)
	for _, f := range verification.Findings {
		if f.RecordID == nil || inSession[*f.RecordID] {
			findings.addFinding(f.Code, f.Message, f.Seq, deref(f.RecordID), deref(f.KeyID))
		}
	}
	report.Findings = findings.sorted()
	report.OK = verification.OK && !changed
	return report, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// archiveState applies SPEC.md's archive table to one record.
func archiveState(ctx context.Context, client *http.Client, rec ReplayRecord, line ExportedRecord, links map[string]string, findings *findingSet) string {
	if rec.ArchiveRef == nil {
		return ArchiveNone
	}
	var want string
	if rec.Signature == SignatureValid && line.SignedRecord != nil {
		if _, signed, err := objectFields(*line.SignedRecord); err == nil {
			want = rawString(signed, "archive_sha256")
		}
	}
	if want == "" {
		return ArchiveNotSigned
	}
	ref := *rec.ArchiveRef
	unavailable := func(why string) string {
		findings.add(CodeArchiveUnavailable, fmt.Sprintf("The archived message %s could not be read (%s), so it was not checked.", ref, why), nil, rec.ID)
		return ArchiveUnavailable
	}
	link, ok := links[ref]
	if !ok {
		return unavailable("the export has no link for it")
	}
	if u, err := url.Parse(link); err != nil || u.Scheme != "https" || u.User != nil {
		return unavailable("its link is not an https URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return unavailable(err.Error())
	}
	resp, err := client.Do(req)
	if err != nil {
		return unavailable(err.Error())
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxObjectBytes+1))
	if err != nil {
		return unavailable(err.Error())
	}
	if resp.StatusCode != http.StatusOK {
		return unavailable(fmt.Sprintf("HTTP %d", resp.StatusCode))
	}
	if len(body) > maxObjectBytes {
		return unavailable("it is too large")
	}
	if got := sha256Hex(body); !strings.EqualFold(got, want) {
		findings.add(CodeArchiveChanged, fmt.Sprintf("The archived message %s hashes to %s, but the Verifier signed %s: it was changed or replaced.", ref, got, want), nil, rec.ID)
		return ArchiveChanged
	}
	return ArchiveMatches
}

// WriteText writes the replay for a person to read.
func (r *ReplayReport) WriteText(w io.Writer) error {
	var b strings.Builder
	fmt.Fprintf(&b, "session      %s, %d %s\n", r.Session, len(r.Records), plural(len(r.Records), "record", "records"))
	if r.VerificationOK {
		b.WriteString("export       verified\n\n")
	} else {
		b.WriteString("export       FAILED verification (see problems)\n\n")
	}
	for _, rec := range r.Records {
		checkpoint := "pending"
		if rec.Seq != nil && rec.Status != StatusPending {
			checkpoint = fmt.Sprintf("checkpoint %d", *rec.Seq)
		}
		fmt.Fprintf(&b, "%s  %s %s -> %s  %s  %s  signature %s  %s  archive %s\n",
			rec.Timestamp, rec.Direction, rec.SenderID, rec.RecipientID,
			orDash(&rec.ResponseLevel), strings.ToUpper(rec.Status), rec.Signature, checkpoint, rec.Archive)
	}
	var fails, warns []Finding
	for _, f := range r.Findings {
		switch f.Severity {
		case SeverityFail:
			fails = append(fails, f)
		case SeverityWarning:
			warns = append(warns, f)
		}
	}
	if len(fails) > 0 {
		b.WriteString("\nproblems\n")
		for _, f := range fails {
			subject := ""
			if f.RecordID != nil {
				subject = *f.RecordID + "  "
			}
			fmt.Fprintf(&b, "  %s%s\n", subject, f.Message)
		}
	}
	if len(warns) > 0 {
		b.WriteString("\nwarnings\n")
		for _, f := range warns {
			fmt.Fprintf(&b, "  %s\n", f.Message)
		}
	}
	if r.OK {
		b.WriteString("\nPASSED: the export verified and every archived message checked matches what the Verifier signed.\n")
	} else {
		b.WriteString("\nFAILED: see problems.\n")
	}
	_, err := io.WriteString(w, b.String())
	return err
}
