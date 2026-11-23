// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
)

const realPrefix = "audit-checkpoints/4de38a9a-abd7-4cfa-ac05-9c31067a3e21/ef089c37-90fb-4733-8190-a8364e153054/"

func readXML(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("../testdata/s3-xml/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseRealListingWithOneVersion(t *testing.T) {
	page, err := ParseListVersions(readXML(t, "real-list.xml"))
	if err != nil {
		t.Fatal(err)
	}
	want := &ListingPage{
		IsTruncated: false,
		Prefix:      realPrefix,
		KeyMarker:   "",
		Entries: []ListingEntry{{
			Key:          realPrefix + "000000000001.json",
			VersionID:    "H.qo.Q4uWq649nfDgqV_m2uSl4e6lb5Y",
			LastModified: "2026-11-10T22:17:24.000Z",
		}},
	}
	if !reflect.DeepEqual(page, want) {
		t.Fatalf("got %+v", page)
	}
}

func TestParseRealListingAfterMarker(t *testing.T) {
	page, err := ParseListVersions(readXML(t, "real-list-after-marker.xml"))
	if err != nil {
		t.Fatal(err)
	}
	want := &ListingPage{Prefix: realPrefix, KeyMarker: realPrefix + "000000000001.json"}
	if !reflect.DeepEqual(page, want) {
		t.Fatalf("got %+v", page)
	}
}

func TestParseDeleteMarkersTruncationAndEntities(t *testing.T) {
	page, err := ParseListVersions([]byte(`<?xml version="1.0" encoding="UTF-8"?>` + "\n" +
		`<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Prefix>p/</Prefix><KeyMarker/><NextKeyMarker>p/a&amp;b.json</NextKeyMarker><IsTruncated>true</IsTruncated><DeleteMarker><Key>p/a&amp;b.json</Key><VersionId>dm</VersionId><IsLatest>true</IsLatest><LastModified>2026-11-10T22:17:24.000Z</LastModified><Owner><ID>x</ID></Owner></DeleteMarker></ListVersionsResult>`))
	if err != nil {
		t.Fatal(err)
	}
	if !page.IsTruncated || page.KeyMarker != "" || page.NextKeyMarker == nil || *page.NextKeyMarker != "p/a&b.json" {
		t.Fatalf("got %+v", page)
	}
	if !reflect.DeepEqual(page.Entries, []ListingEntry{{Key: "p/a&b.json", VersionID: "dm", LastModified: "2026-11-10T22:17:24.000Z", DeleteMarker: true}}) {
		t.Fatalf("entries %+v", page.Entries)
	}
}

func TestParseRefusesOtherDocuments(t *testing.T) {
	if _, err := ParseListVersions([]byte(`<Error><Code>AccessDenied</Code></Error>`)); err == nil {
		t.Fatal("parsed an error document")
	}
	if _, err := ParseListVersions([]byte(`<ListVersionsResult></ListVersionsResult>`)); err == nil {
		t.Fatal("parsed a listing with no IsTruncated")
	}
}

var urlManifest = &Manifest{Bucket: "spellguard-audit-checkpoints-test", Region: "us-west-2", Prefix: "audit-checkpoints/g/s/"}

const (
	urlHost = "https://spellguard-audit-checkpoints-test.s3.us-west-2.amazonaws.com"
	// The query order aws4fetch emits, temporary-credential token included.
	urlSig = "X-Amz-Expires=604800&X-Amz-Date=20261110T223000Z&X-Amz-Security-Token=tok&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261110%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-SignedHeaders=host&X-Amz-Signature=abc"
)

func TestListingURLChecks(t *testing.T) {
	enc := url.QueryEscape
	ok := "versions=&prefix=" + enc(urlManifest.Prefix) + "&max-keys=1000&" + urlSig
	if why := CheckListingURL(urlHost+"/?"+ok, 0, urlManifest); why != "" {
		t.Fatalf("page 0 refused: %s", why)
	}
	page1 := urlHost + "/?versions=&prefix=" + enc(urlManifest.Prefix) + "&max-keys=1000&key-marker=" + enc(urlManifest.Prefix+"000000000500.json") + "&" + urlSig
	if why := CheckListingURL(page1, 1, urlManifest); why != "" {
		t.Fatalf("page 1 refused: %s", why)
	}
	cases := map[string]struct {
		url  string
		page int
		want string
	}{
		"http":       {"http://spellguard-audit-checkpoints-test.s3.us-west-2.amazonaws.com/?" + ok, 0, "https"},
		"host":       {"https://evil.example.com/?" + ok, 0, "evil"},
		"port":       {urlHost + ":8443/?" + ok, 0, "port"},
		"path":       {urlHost + "/other/?" + ok, 0, "path"},
		"no-version": {urlHost + "/?prefix=" + enc(urlManifest.Prefix) + "&" + urlSig, 0, "version listing"},
		"prefix":     {urlHost + "/?versions=&prefix=" + enc("audit-checkpoints/g/other/") + "&" + urlSig, 0, "not the stream"},
		"delimiter":  {urlHost + "/?" + ok + "&delimiter=%2F", 0, "delimiter"},
		"marker-0":   {urlHost + "/?" + ok + "&key-marker=" + enc(urlManifest.Prefix+"000000000001.json"), 0, "starts at"},
		"marker-1":   {urlHost + "/?" + ok, 1, "starts at"},
	}
	for name, c := range cases {
		if why := CheckListingURL(c.url, c.page, urlManifest); !strings.Contains(why, c.want) {
			t.Errorf("%s: got %q, want it to mention %q", name, why, c.want)
		}
	}
}

func TestObjectURLChecks(t *testing.T) {
	if why := CheckObjectURL(urlHost+"/"+urlManifest.Prefix+"000000000007.json?"+urlSig, 7, urlManifest); why != "" {
		t.Fatalf("refused: %s", why)
	}
	if why := CheckObjectURL(urlHost+"/"+urlManifest.Prefix+"000000000008.json?"+urlSig, 7, urlManifest); why == "" {
		t.Fatal("accepted another seq")
	}
	if why := CheckObjectURL("https://spellguard-audit-checkpoints-other.s3.us-west-2.amazonaws.com/"+urlManifest.Prefix+"000000000007.json", 7, urlManifest); !strings.Contains(why, "goes to") {
		t.Fatalf("got %q", why)
	}
}

func TestParseRecordsJSONL(t *testing.T) {
	records, err := ParseRecordsJSONL(strings.NewReader(`{"id":"a","checkpoint_seq":1,"record":"{}"}` + "\n\n" +
		`{"id":"b","checkpoint_seq":null,"record":"{}","checkpointed_record":"{}"}` + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || *records[0].CheckpointSeq != 1 || records[1].CheckpointSeq != nil || *records[1].CheckpointedRecord != "{}" {
		t.Fatalf("got %+v", records)
	}
	if _, err := ParseRecordsJSONL(strings.NewReader(`{"id":"a"}` + "\n")); err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("err = %v", err)
	}
	if _, err := ParseRecordsJSONL(strings.NewReader("ok\n")); err == nil || !strings.Contains(err.Error(), "line 1 is not JSON") {
		t.Fatalf("err = %v", err)
	}
	if _, err := ParseRecordsJSONL(strings.NewReader(`{"id":"a","checkpoint_seq":0,"record":"{}"}`)); err == nil {
		t.Fatal("accepted checkpoint_seq 0")
	}
}

func TestGroupDigits(t *testing.T) {
	for n, want := range map[int]string{0: "0", 999: "999", 1000: "1,000", 18204: "18,204", 1234567: "1,234,567"} {
		if got := groupDigits(n); got != want {
			t.Errorf("groupDigits(%d) = %s", n, got)
		}
	}
}
