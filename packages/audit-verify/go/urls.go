// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"fmt"
	"net/url"
	"strings"
)

// CheckpointKey is the object key of a stream's checkpoint.
func CheckpointKey(prefix string, seq int64) string {
	return fmt.Sprintf("%s%012d.json", prefix, seq)
}

// StreamPrefix is the key prefix of a stream.
func StreamPrefix(generation, stream string) string {
	return "audit-checkpoints/" + generation + "/" + stream + "/"
}

func s3Host(bucket, region string) string {
	return bucket + ".s3." + region + ".amazonaws.com"
}

func checkHost(raw, bucket, region string) (*url.URL, string) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, "it is not a URL"
	}
	host := s3Host(bucket, region)
	if u.Scheme != "https" {
		return nil, fmt.Sprintf("it uses %s:, not https", u.Scheme)
	}
	if u.User != nil {
		return nil, "it carries credentials"
	}
	if !strings.EqualFold(u.Hostname(), host) {
		return nil, fmt.Sprintf("it goes to %s, not %s", strings.ToLower(u.Hostname()), host)
	}
	if p := u.Port(); p != "" && p != "443" {
		return nil, "it uses port " + p
	}
	return u, ""
}

// CheckListingURL says why a listing URL does not list the stream's page, or
// returns "" when it does.
func CheckListingURL(raw string, page int, m *Manifest) string {
	u, why := checkHost(raw, m.Bucket, m.Region)
	if u == nil {
		return why
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if path != "/" {
		return fmt.Sprintf("path is %s, not /", path)
	}
	q := u.Query()
	if _, ok := q["versions"]; !ok {
		return "it is not a version listing"
	}
	for _, forbidden := range []string{"delimiter", "version-id-marker", "encoding-type"} {
		if _, ok := q[forbidden]; ok {
			return "it sets " + forbidden
		}
	}
	prefixes := q["prefix"]
	if len(prefixes) != 1 || prefixes[0] != m.Prefix {
		return fmt.Sprintf("it lists %q, not the stream %q", strings.Join(prefixes, ","), m.Prefix)
	}
	markers := q["key-marker"]
	var expected string
	if page > 0 {
		expected = CheckpointKey(m.Prefix, int64(page)*ListPageSeqs)
	}
	if (page == 0 && len(markers) != 0) || (page > 0 && (len(markers) != 1 || markers[0] != expected)) {
		got := strings.Join(markers, ",")
		if got == "" {
			got = "(the beginning)"
		}
		want := expected
		if want == "" {
			want = "(the beginning)"
		}
		return fmt.Sprintf("page %d starts at %q, not %q", page+1, got, want)
	}
	return ""
}

// CheckKeysListingURL says why a URL does not list the Verifier keys, or
// returns "" when it does.
func CheckKeysListingURL(raw string, m *Manifest) string {
	u, why := checkHost(raw, m.Bucket, m.Region)
	if u == nil {
		return why
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if path != "/" {
		return fmt.Sprintf("path is %s, not /", path)
	}
	q := u.Query()
	if _, ok := q["versions"]; !ok {
		return "it is not a version listing"
	}
	for _, forbidden := range []string{"delimiter", "version-id-marker", "encoding-type", "key-marker"} {
		if _, ok := q[forbidden]; ok {
			return "it sets " + forbidden
		}
	}
	if prefixes := q["prefix"]; len(prefixes) != 1 || prefixes[0] != KeysPrefix {
		return fmt.Sprintf("it lists %q, not the keys %q", strings.Join(prefixes, ","), KeysPrefix)
	}
	return ""
}

// CheckKeyURL says why a URL does not read the named key object, or returns
// "" when it does.
func CheckKeyURL(raw, keyID string, m *Manifest) string {
	if !keyIDPattern.MatchString(keyID) {
		return fmt.Sprintf("%q is not a key id", keyID)
	}
	u, why := checkHost(raw, m.Bucket, m.Region)
	if u == nil {
		return why
	}
	expected := KeysPrefix + keyID + ".json"
	key := strings.TrimPrefix(u.Path, "/")
	if !strings.HasPrefix(u.Path, "/") || key != expected {
		return fmt.Sprintf("it reads %q, not %q", key, expected)
	}
	return ""
}

// CheckObjectURL says why a checkpoint URL does not read that checkpoint, or
// returns "" when it does.
func CheckObjectURL(raw string, seq int64, m *Manifest) string {
	u, why := checkHost(raw, m.Bucket, m.Region)
	if u == nil {
		return why
	}
	expected := CheckpointKey(m.Prefix, seq)
	key := strings.TrimPrefix(u.Path, "/")
	if !strings.HasPrefix(u.Path, "/") || key != expected {
		return fmt.Sprintf("it reads %q, not %q", key, expected)
	}
	return ""
}
