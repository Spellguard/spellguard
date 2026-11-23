// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"fmt"
	"io"
	"strconv"
	"strings"
)

// groupDigits writes 18204 as 18,204.
func groupDigits(n int) string {
	s := strconv.Itoa(n)
	if n < 0 {
		return s
	}
	var out strings.Builder
	for i, ch := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			out.WriteByte(',')
		}
		out.WriteRune(ch)
	}
	return out.String()
}

func orDash(s *string) string {
	if s == nil {
		return "-"
	}
	return *s
}

// WriteText writes the report for a person to read.
func (r *Report) WriteText(w io.Writer) error {
	var b strings.Builder
	total := r.Counts.OK + r.Counts.Pending + r.Counts.Deleted + r.Counts.Missing + r.Counts.Tampered
	fmt.Fprintf(&b, "stream       organization %s, generation %s\n", r.Stream.Organization, r.Stream.Generation)
	fmt.Fprintf(&b, "bucket       s3://%s (%s)\n", r.Stream.Bucket, r.Stream.Region)
	c := r.Checkpoints
	if c.Count > 0 {
		fmt.Fprintf(&b, "checkpoints  %s, uploaded %s to %s; earliest lock expires %s\n",
			groupDigits(c.Count), orDash(c.FirstUploadedAt), orDash(c.LastUploadedAt), orDash(c.EarliestLockExpiry))
	} else {
		b.WriteString("checkpoints  none yet\n")
	}
	fmt.Fprintf(&b, "\nchecked %s records\n", groupDigits(total))
	width := len(groupDigits(total))
	if width < 5 {
		width = 5
	}
	line := func(label string, n int, note string) {
		fmt.Fprintf(&b, "%-9s %*s", label, width, groupDigits(n))
		if note != "" {
			b.WriteString("  " + note)
		}
		b.WriteByte('\n')
	}
	line("OK", r.Counts.OK, "unchanged since their checkpoint was uploaded")
	line("PENDING", r.Counts.Pending, "not checkpointed yet")
	line("DELETED", r.Counts.Deleted, "deletion announced in a checkpoint")
	line("MISSING", r.Counts.Missing, "")
	line("TAMPERED", r.Counts.Tampered, "")

	s := r.Signatures
	b.WriteString("\nVerifier signatures\n")
	sig := func(label string, n int, note string) {
		fmt.Fprintf(&b, "%-10s %*s", label, width, groupDigits(n))
		if note != "" {
			b.WriteString("  " + note)
		}
		b.WriteByte('\n')
	}
	sig("VALID", s.Valid, "signed by the Verifier with these values, checked against its published key")
	sig("UNSIGNED", s.Unsigned, "no signature: written before signing began, or by Spellguard's control plane")
	sig("UNVERIFIED", s.Unverified, "signed, but the key is unknown or newer than the record, so not checked")
	sig("INVALID", s.Invalid, "")

	statusOf := map[string]string{}
	for _, rec := range r.Records {
		statusOf[rec.ID] = rec.Status
	}
	var fails, warns, infos []Finding
	for _, f := range r.Findings {
		switch f.Severity {
		case SeverityFail:
			fails = append(fails, f)
		case SeverityWarning:
			warns = append(warns, f)
		default:
			infos = append(infos, f)
		}
	}
	if len(fails) > 0 {
		b.WriteString("\nproblems\n")
		for _, f := range fails {
			label := "STREAM"
			subject := ""
			if f.RecordID != nil {
				label = strings.ToUpper(statusOf[*f.RecordID])
				if label == "" {
					label = "RECORD"
				}
				subject = *f.RecordID + "  "
			} else if f.KeyID != nil {
				label = "KEY"
			} else if f.Seq != nil {
				label = "CHECKPOINT"
			}
			fmt.Fprintf(&b, "  %-10s %s%s\n", label, subject, f.Message)
		}
	}
	if len(warns) > 0 {
		// One warning per record can run to thousands (an export without keys
		// warns for every signed record), so show three of each kind.
		b.WriteString("\nwarnings\n")
		shown := map[string]int{}
		total := map[string]int{}
		for _, f := range warns {
			total[f.Code]++
		}
		for _, f := range warns {
			shown[f.Code]++
			if shown[f.Code] > 3 {
				continue
			}
			subject := ""
			if f.RecordID != nil {
				subject = *f.RecordID + "  "
			}
			fmt.Fprintf(&b, "  %s%s\n", subject, f.Message)
			if shown[f.Code] == 3 && total[f.Code] > 3 {
				more := total[f.Code] - 3
				fmt.Fprintf(&b, "  ...and %s more %s like %s\n", groupDigits(more), plural(more, "record", "records"), plural(more, "it", "them"))
			}
		}
	}
	if len(infos) > 0 {
		b.WriteString("\nnotes\n")
		for _, f := range infos {
			fmt.Fprintf(&b, "  %s\n", f.Message)
		}
	}
	if r.Counts.Missing > 0 {
		b.WriteString("\nA deletion is announced in the first hourly checkpoint after it. If this export is\n" +
			"less than an hour old, export and verify again after the next checkpoint; a record\n" +
			"still missing then was removed without notice.\n")
	}
	if r.OK {
		if r.Signatures.Valid > 0 {
			b.WriteString("\nPASSED: no record changed or disappeared after its checkpoint, and every signed\nrecord holds the values its Verifier signed.\n")
		} else {
			b.WriteString("\nPASSED: no record changed or disappeared after its checkpoint.\n")
		}
	} else {
		fmt.Fprintf(&b, "\nFAILED: %d %s.\n", len(fails), plural(len(fails), "problem", "problems"))
	}
	_, err := io.WriteString(w, b.String())
	return err
}
