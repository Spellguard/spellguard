// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	keyIDPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)
	keyFile      = regexp.MustCompile(`^[0-9a-f]{16}\.json$`)
)

// KeyID is a Verifier key's id: the first 16 hex characters of the SHA-256 of
// its 32-byte public key.
func KeyID(publicKey []byte) string {
	sum := sha256.Sum256(publicKey)
	return hex.EncodeToString(sum[:])[:16]
}

// trustedKey is a Verifier key read from the locked bucket (SPEC.md step 2b).
type trustedKey struct {
	publicKey ed25519.PublicKey
	uploaded  time.Time
}

// readKeys reads the Verifier keys the manifest names and returns the trusted
// ones by key id. It returns an error only when the keys listing cannot be
// fetched or parsed; every other problem is a finding.
func readKeys(ctx context.Context, client *http.Client, m *Manifest, findings *findingSet) (map[string]trustedKey, error) {
	trusted := map[string]trustedKey{}
	if m.Keys == nil {
		return trusted, nil
	}
	resp, err := fetchLimited(ctx, client, m.Keys.Listing, maxListingBytes)
	if err != nil {
		return nil, fmt.Errorf("the keys listing could not be fetched: %w", err)
	}
	if resp.status != http.StatusOK {
		hint := ""
		if resp.status == http.StatusForbidden {
			hint = fmt.Sprintf(" (the export's links expire at %s; export again if they have expired)", m.URLsExpireAt)
		}
		return nil, fmt.Errorf("the keys listing returned HTTP %d%s", resp.status, hint)
	}
	listing, err := ParseListVersions(resp.body)
	if err != nil {
		return nil, fmt.Errorf("the keys listing: %w", err)
	}
	if listing.IsTruncated {
		findings.add(CodeListingIncomplete, "The keys listing was cut off, so some key objects were not seen.", nil, "")
	}

	type slot struct{ versions, markers []ListingEntry }
	byKey := map[string]*slot{}
	unexpected := map[string]bool{}
	for _, e := range listing.Entries {
		name := strings.TrimPrefix(e.Key, KeysPrefix)
		if !strings.HasPrefix(e.Key, KeysPrefix) || !keyFile.MatchString(name) {
			unexpected[e.Key] = true
			continue
		}
		s := byKey[e.Key]
		if s == nil {
			s = &slot{}
			byKey[e.Key] = s
		}
		if e.DeleteMarker {
			s.markers = append(s.markers, e)
		} else {
			s.versions = append(s.versions, e)
		}
	}
	odd := make([]string, 0, len(unexpected))
	for k := range unexpected {
		odd = append(odd, k)
	}
	sort.Strings(odd)
	for _, k := range odd {
		findings.add(CodeUnexpectedKey, fmt.Sprintf("The keys folder holds an object that is not a key: %s.", k), nil, "")
	}

	for _, k := range m.Keys.Objects {
		invalid := func(why string) {
			findings.addKey(CodeKeyInvalid, fmt.Sprintf("Verifier key %s cannot be trusted: %s.", k.KeyID, why), k.KeyID)
		}
		s := byKey[KeysPrefix+k.KeyID+".json"]
		switch {
		case s == nil || len(s.versions) == 0:
			invalid("it is not in the bucket")
			continue
		case len(s.markers) > 0:
			invalid("it has a delete marker on top of it")
			continue
		case len(s.versions) > 1:
			invalid(fmt.Sprintf("it has %d versions, and a key is written once", len(s.versions)))
			continue
		}
		version := s.versions[0]
		uploaded, ok := parseTime(version.LastModified)
		if !ok {
			invalid("its upload time cannot be read")
			continue
		}
		resp, err := fetchLimited(ctx, client, k.URL, maxObjectBytes)
		if err != nil {
			invalid(fmt.Sprintf("it could not be read (%s)", err.Error()))
			continue
		}
		if resp.status != http.StatusOK {
			invalid(fmt.Sprintf("it could not be read (HTTP %d)", resp.status))
			continue
		}
		if resp.header.Get("x-amz-version-id") != version.VersionID {
			invalid("it was read as a version other than its original")
			continue
		}
		if _, ok := parseTime(resp.header.Get("x-amz-object-lock-retain-until-date")); resp.header.Get("x-amz-object-lock-mode") != "COMPLIANCE" || !ok {
			invalid("it has no compliance lock")
			continue
		}
		publicKey, why := parseKeyObject(resp.body, k.KeyID)
		if publicKey == nil {
			invalid(why)
			continue
		}
		trusted[k.KeyID] = trustedKey{publicKey: publicKey, uploaded: uploaded}
	}
	return trusted, nil
}

// parseKeyObject reads a key object, checking it names keyID and that keyID
// is its public key's id.
func parseKeyObject(body []byte, keyID string) (ed25519.PublicKey, string) {
	if !utf8.Valid(body) {
		return nil, "it is not a key object"
	}
	var fields map[string]any
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return nil, "it is not a key object"
	}
	format, _ := fields["format"].(float64)
	kind, _ := fields["kind"].(string)
	algorithm, _ := fields["algorithm"].(string)
	if format != Format || kind != "verifier-audit-key" || algorithm != "ed25519" {
		return nil, "it is not a format 1 Ed25519 key object"
	}
	named, _ := fields["key_id"].(string)
	if named != keyID {
		return nil, fmt.Sprintf("it names key %q", named)
	}
	publicHex, _ := fields["public_key"].(string)
	raw, err := hex.DecodeString(publicHex)
	if err != nil || len(raw) != ed25519.PublicKeySize || publicHex != strings.ToLower(publicHex) {
		return nil, "its public key is not 64 lowercase hex characters"
	}
	if KeyID(raw) != keyID {
		return nil, "its public key does not match its key id"
	}
	return ed25519.PublicKey(raw), ""
}
