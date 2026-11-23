// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var signaturePattern = regexp.MustCompile(`^ed25519:([0-9a-f]{16}):([0-9a-f]{128})$`)

// signedPolicyCheck is one policy check as a Verifier signs it. The field
// order is the signed record's, so a diff prints the same in every verifier.
type signedPolicyCheck struct {
	PolicyID      *string `json:"policy_id"`
	Decision      *string `json:"decision"`
	ResponseLevel *string `json:"response_level"`
	Severity      *string `json:"severity"`
}

// signedFieldKinds are the signed record's fields and their JSON types, in
// order: "s" a string, "s?" a string or null, "n" a number, "a" the policy
// checks array.
var signedFieldKinds = []struct{ name, kind string }{
	{"format", "n"}, {"key_id", "s"}, {"id", "s"}, {"agent_id", "s"},
	{"direction", "s"}, {"sender_id", "s"}, {"recipient_id", "s"},
	{"timestamp", "s"}, {"message_hash", "s"}, {"attestation_level", "s"},
	{"correlation_id", "s?"}, {"event_type", "s"}, {"response_level", "s"},
	{"policy_checks", "a"}, {"archive_ref", "s?"}, {"archive_sha256", "s?"},
	{"verifier_id", "s"}, {"signed_at", "s"},
}

// comparedStrings are the signed fields compared exactly with the record's.
var comparedStrings = []string{
	"id", "agent_id", "direction", "sender_id", "recipient_id",
	"attestation_level", "correlation_id", "event_type", "response_level",
	"archive_ref", "verifier_id",
}

type signatureOutcome struct {
	state   string
	keyID   string
	code    string
	message string
	diff    []FieldDiff
}

// checkSignature applies SPEC.md's signature table to one exported record,
// whose top-level fields are given.
func checkSignature(record map[string]json.RawMessage, signedText *string, keys map[string]trustedKey) signatureOutcome {
	var signature string
	if json.Unmarshal(record["verifier_signature"], &signature) != nil {
		return signatureOutcome{state: SignatureUnsigned}
	}
	match := signaturePattern.FindStringSubmatch(signature)
	if match == nil {
		return signatureOutcome{state: SignatureUnsigned}
	}
	keyID := match[1]
	sig, _ := hex.DecodeString(match[2])
	invalid := func(code, message string) signatureOutcome {
		return signatureOutcome{state: SignatureInvalid, keyID: keyID, code: code, message: message}
	}
	if signedText == nil {
		return invalid(CodeSignedRecordMissing, fmt.Sprintf("Signed with Verifier key %s, but the export does not include what was signed.", keyID))
	}
	signed, why := parseSignedRecord(*signedText)
	if signed == nil {
		return invalid(CodeSignatureInvalid, fmt.Sprintf("The signed record is not valid: %s.", why))
	}
	var signedKey string
	_ = json.Unmarshal(signed["key_id"], &signedKey)
	if signedKey != keyID {
		return invalid(CodeSignatureInvalid, fmt.Sprintf("The signature names key %s, but the signed record names key %s.", keyID, signedKey))
	}
	key, ok := keys[keyID]
	if !ok {
		return signatureOutcome{
			state: SignatureUnverified, keyID: keyID, code: CodeSignatureKeyUnknown,
			message: fmt.Sprintf("Signed with Verifier key %s, which the export does not hold or which cannot be trusted, so the signature was not checked.", keyID),
		}
	}
	if !ed25519.Verify(key.publicKey, []byte(*signedText), sig) {
		return invalid(CodeSignatureInvalid, "The signature does not match the signed record: one of them was changed after signing.")
	}
	if diff := compareSigned(record, signed); len(diff) > 0 {
		out := invalid(CodeSignedFieldMismatch, fmt.Sprintf("Changed after the Verifier signed it: %s.", DescribeSignedDiff(diff)))
		out.diff = diff
		return out
	}
	var at string
	_ = json.Unmarshal(signed["timestamp"], &at)
	if t, ok := parseTime(at); !ok || t.Before(key.uploaded) {
		return signatureOutcome{
			state: SignatureUnverified, keyID: keyID, code: CodeSignaturePredatesKey,
			message: fmt.Sprintf("Signed with Verifier key %s, published %s, after this record's time %s, so the key cannot vouch for it.", keyID, isoTime(key.uploaded), at),
		}
	}
	return signatureOutcome{state: SignatureValid, keyID: keyID}
}

// parseSignedRecord reads a signed record's fields, checking each is present
// with its type and that format is 1.
func parseSignedRecord(text string) (map[string]json.RawMessage, string) {
	_, fields, err := objectFields(text)
	if err != nil {
		return nil, "it is not a JSON object"
	}
	for _, f := range signedFieldKinds {
		raw, ok := fields[f.name]
		if !ok {
			return nil, "it has no " + f.name
		}
		var v any
		if json.Unmarshal(raw, &v) != nil {
			return nil, f.name + " is not JSON"
		}
		switch f.kind {
		case "n":
			if n, ok := v.(float64); !ok || n != Format {
				return nil, "it is not format 1"
			}
		case "s":
			if _, ok := v.(string); !ok {
				return nil, f.name + " is not a string"
			}
		case "s?":
			if _, ok := v.(string); !ok && v != nil {
				return nil, f.name + " is not a string or null"
			}
		case "a":
			if _, ok := signedChecks(raw); !ok {
				return nil, "policy_checks is not a list of signed policy checks"
			}
		}
	}
	return fields, ""
}

func signedChecks(raw json.RawMessage) ([]signedPolicyCheck, bool) {
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	out := make([]signedPolicyCheck, 0, len(items))
	for _, item := range items {
		if item == nil {
			return nil, false
		}
		var c signedPolicyCheck
		for _, f := range []struct {
			name string
			into **string
		}{{"policy_id", &c.PolicyID}, {"decision", &c.Decision}, {"response_level", &c.ResponseLevel}, {"severity", &c.Severity}} {
			v, ok := item[f.name]
			if !ok {
				return nil, false
			}
			switch x := v.(type) {
			case string:
				s := x
				*f.into = &s
			case nil:
			default:
				return nil, false
			}
		}
		out = append(out, c)
	}
	return out, true
}

// recordChecks projects the record's policy checks onto the signed fields;
// ok is false when they are not a list of objects. Spellguard stores most
// records' checks as a JSON string holding the array, so a string is parsed
// first.
func recordChecks(raw json.RawMessage) ([]signedPolicyCheck, bool) {
	if raw == nil {
		return nil, false
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		raw = json.RawMessage(text)
	}
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	str := func(item map[string]any, name string) *string {
		if s, ok := item[name].(string); ok {
			return &s
		}
		return nil
	}
	out := make([]signedPolicyCheck, 0, len(items))
	for _, item := range items {
		if item == nil {
			return nil, false
		}
		out = append(out, signedPolicyCheck{
			PolicyID: str(item, "policyId"), Decision: str(item, "decision"),
			ResponseLevel: str(item, "responseLevel"), Severity: str(item, "severity"),
		})
	}
	return out, true
}

func sameString(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// compareSigned returns each signed field whose value differs from the
// record's, in the signed record's order.
func compareSigned(record, signed map[string]json.RawMessage) []FieldDiff {
	null := json.RawMessage("null")
	value := func(m map[string]json.RawMessage, name string) json.RawMessage {
		if raw, ok := m[name]; ok {
			return compactRaw(raw)
		}
		return null
	}
	optString := func(raw json.RawMessage) (*string, bool) {
		var v any
		if raw == nil || json.Unmarshal(raw, &v) != nil {
			return nil, false
		}
		switch x := v.(type) {
		case string:
			return &x, true
		case nil:
			return nil, true
		}
		return nil, false
	}
	var diff []FieldDiff
	add := func(name string, now, was json.RawMessage) {
		diff = append(diff, FieldDiff{Field: name, Now: now, Was: was})
	}
	for _, f := range signedFieldKinds {
		switch name := f.name; {
		case containsString(comparedStrings, name):
			a, okA := optString(record[name])
			b, _ := optString(signed[name])
			if !okA || !sameString(a, b) {
				add(name, value(record, name), value(signed, name))
			}
		case name == "message_hash":
			a, okA := optString(record[name])
			b, _ := optString(signed[name])
			if !okA || a == nil || b == nil || !strings.EqualFold(*a, *b) {
				add(name, value(record, name), value(signed, name))
			}
		case name == "timestamp":
			a, okA := optString(record[name])
			b, _ := optString(signed[name])
			var ta, tb int64
			okT := okA && a != nil && b != nil
			if okT {
				x, okX := parseTime(*a)
				y, okY := parseTime(*b)
				okT = okX && okY
				ta, tb = x.UnixMilli(), y.UnixMilli()
			}
			if !okT || ta != tb {
				add(name, value(record, name), value(signed, name))
			}
		case name == "policy_checks":
			was, _ := signedChecks(signed[name])
			now, ok := recordChecks(record[name])
			same := ok && len(now) == len(was)
			for i := 0; same && i < len(now); i++ {
				same = sameString(now[i].PolicyID, was[i].PolicyID) &&
					sameString(now[i].Decision, was[i].Decision) &&
					sameString(now[i].ResponseLevel, was[i].ResponseLevel) &&
					sameString(now[i].Severity, was[i].Severity)
			}
			if !same {
				nowRaw := value(record, name)
				if ok {
					nowRaw, _ = json.Marshal(now)
				}
				wasRaw, _ := json.Marshal(was)
				add(name, nowRaw, wasRaw)
			}
		}
	}
	return diff
}

// DescribeSignedDiff describes a signed-field diff the way the reports print
// it.
func DescribeSignedDiff(diff []FieldDiff) string {
	parts := make([]string, 0, len(diff))
	for _, d := range diff {
		parts = append(parts, fmt.Sprintf("%s is %s, was signed as %s", d.Field, compactRaw(d.Now), compactRaw(d.Was)))
	}
	return strings.Join(parts, "; ")
}
