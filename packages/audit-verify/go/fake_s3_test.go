// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// fakeS3 answers ListObjectVersions and GetObject over a scenario's s3.json,
// in the shape real S3 uses (testdata/s3-xml holds two real responses). It is
// the same fake as tests/unit/audit-verify/fake-s3.ts.
type fakeS3 struct {
	bucket  string
	host    string
	entries []fakeEntry
	latest  map[string]*fakeEntry
}

type fakeEntry struct {
	Key          string  `json:"key"`
	VersionID    string  `json:"version_id"`
	LastModified string  `json:"last_modified"`
	LockMode     *string `json:"lock_mode"`
	RetainUntil  *string `json:"retain_until"`
	Body         string  `json:"body"`
	GetStatus    int     `json:"get_status"`
	GetVersionID string  `json:"get_version_id"`
	deleteMarker bool
}

type fakeBucketFile struct {
	Bucket        string      `json:"bucket"`
	Versions      []fakeEntry `json:"versions"`
	DeleteMarkers []fakeEntry `json:"delete_markers"`
}

func loadFakeS3(path string) (*fakeS3, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var file fakeBucketFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, err
	}
	f := &fakeS3{bucket: file.Bucket, host: s3Host(file.Bucket, "us-west-2"), latest: map[string]*fakeEntry{}}
	f.entries = append(f.entries, file.Versions...)
	for _, d := range file.DeleteMarkers {
		d.deleteMarker = true
		f.entries = append(f.entries, d)
	}
	ms := func(s string) int64 {
		t, _ := time.Parse(time.RFC3339Nano, s)
		return t.UnixMilli()
	}
	sort.SliceStable(f.entries, func(i, j int) bool {
		a, b := f.entries[i], f.entries[j]
		if a.Key != b.Key {
			return a.Key < b.Key
		}
		return ms(a.LastModified) > ms(b.LastModified)
	})
	for i := range f.entries {
		if _, ok := f.latest[f.entries[i].Key]; !ok {
			f.latest[f.entries[i].Key] = &f.entries[i]
		}
	}
	return f, nil
}

var xmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")

func respond(req *http.Request, status int, header http.Header, body string) *http.Response {
	if header == nil {
		header = http.Header{}
	}
	return &http.Response{
		StatusCode:    status,
		Status:        fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Header:        header,
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
		Request:       req,
	}
}

func (f *fakeS3) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" || req.URL.Hostname() != f.host {
		return nil, fmt.Errorf("fake S3 refuses %s", req.URL.Host)
	}
	q := req.URL.Query()
	if (req.URL.Path == "/" || req.URL.Path == "") && q.Has("versions") {
		return f.list(req, q), nil
	}
	return f.get(req, strings.TrimPrefix(req.URL.Path, "/")), nil
}

func (f *fakeS3) list(req *http.Request, q url.Values) *http.Response {
	prefix, marker := q.Get("prefix"), q.Get("key-marker")
	maxKeys := 1000
	if v := q.Get("max-keys"); v != "" {
		maxKeys, _ = strconv.Atoi(v)
	}
	var matching []*fakeEntry
	for i := range f.entries {
		e := &f.entries[i]
		if strings.HasPrefix(e.Key, prefix) && (marker == "" || e.Key > marker) {
			matching = append(matching, e)
		}
	}
	page := matching
	truncated := len(matching) > maxKeys
	if truncated {
		page = matching[:maxKeys]
	}
	var items strings.Builder
	for _, e := range page {
		head := fmt.Sprintf("<Key>%s</Key><VersionId>%s</VersionId><IsLatest>%t</IsLatest><LastModified>%s</LastModified>",
			xmlEscaper.Replace(e.Key), xmlEscaper.Replace(e.VersionID), f.latest[e.Key] == e, e.LastModified)
		if e.deleteMarker {
			fmt.Fprintf(&items, "<DeleteMarker>%s<Owner><ID>%s</ID></Owner></DeleteMarker>", head, strings.Repeat("0", 64))
			continue
		}
		sum := md5.Sum([]byte(e.Body))
		fmt.Fprintf(&items, "<Version>%s<ETag>&quot;%s&quot;</ETag><ChecksumAlgorithm>SHA256</ChecksumAlgorithm><ChecksumType>FULL_OBJECT</ChecksumType><Size>%d</Size><Owner><ID>%s</ID></Owner><StorageClass>STANDARD</StorageClass></Version>",
			head, hex.EncodeToString(sum[:]), len(e.Body), strings.Repeat("0", 64))
	}
	next := ""
	if truncated && len(page) > 0 {
		last := page[len(page)-1]
		next = fmt.Sprintf("<NextKeyMarker>%s</NextKeyMarker><NextVersionIdMarker>%s</NextVersionIdMarker>",
			xmlEscaper.Replace(last.Key), xmlEscaper.Replace(last.VersionID))
	}
	body := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ListVersionsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>%s</Name><Prefix>%s</Prefix><KeyMarker>%s</KeyMarker><VersionIdMarker></VersionIdMarker>%s<MaxKeys>%d</MaxKeys><IsTruncated>%t</IsTruncated>%s</ListVersionsResult>",
		xmlEscaper.Replace(f.bucket), xmlEscaper.Replace(prefix), xmlEscaper.Replace(marker), next, maxKeys, truncated, items.String())
	return respond(req, http.StatusOK, http.Header{"Content-Type": {"application/xml"}}, body)
}

func (f *fakeS3) get(req *http.Request, key string) *http.Response {
	e := f.latest[key]
	if e == nil || e.deleteMarker {
		header := http.Header{}
		if e != nil {
			header.Set("x-amz-delete-marker", "true")
		}
		return respond(req, http.StatusNotFound, header,
			"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>")
	}
	if e.GetStatus != 0 {
		return respond(req, e.GetStatus, nil, "")
	}
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	versionID := e.VersionID
	if e.GetVersionID != "" {
		versionID = e.GetVersionID
	}
	header.Set("x-amz-version-id", versionID)
	if t, err := time.Parse(time.RFC3339Nano, e.LastModified); err == nil {
		header.Set("Last-Modified", t.UTC().Format(http.TimeFormat))
	}
	if e.LockMode != nil {
		header.Set("x-amz-object-lock-mode", *e.LockMode)
	}
	if e.RetainUntil != nil {
		header.Set("x-amz-object-lock-retain-until-date", *e.RetainUntil)
	}
	return respond(req, http.StatusOK, header, e.Body)
}
