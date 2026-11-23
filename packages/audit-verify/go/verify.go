// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	staleAfter      = 25 * time.Hour
	maxObjectBytes  = 4 << 20
	maxListingBytes = 8 << 20
	defaultTimeout  = 60 * time.Second
)

var (
	seqFile = regexp.MustCompile(`^(\d{12})\.json$`)
	region  = regexp.MustCompile(`^[a-z0-9-]+$`)
)

// Options configure Verify.
type Options struct {
	// AllowedBuckets lists the buckets the export may point at.
	AllowedBuckets []string
	// Now is the time staleness is judged against; zero means time.Now().
	Now time.Time
	// HTTPClient fetches from S3. Redirects are always refused. Nil means a
	// client with a 60-second timeout.
	HTTPClient *http.Client
	// State holds checkpoints saved on earlier runs; nil means none.
	State StateStore
	// Concurrency bounds parallel checkpoint reads; 0 means 8.
	Concurrency int
}

var warnings = map[string]bool{
	CodeStreamStale: true, CodeStreamGenerationChanged: true, CodeStateNotSaved: true,
	CodeSignatureKeyUnknown: true, CodeSignaturePredatesKey: true,
	CodeArchiveUnavailable: true,
}

var infos = map[string]bool{CodeCheckpointsBeyondExport: true}

// checkpointProblems are findings about a checkpoint object itself; such an
// object's hash is never saved.
var checkpointProblems = map[string]bool{
	CodeDeleteMarker: true, CodeExtraVersion: true, CodeVersionMismatch: true,
	CodeNotLocked: true, CodeCheckpointInvalid: true, CodeChainBroken: true,
	CodeLedgerMismatch: true, CodeSavedCheckpointChanged: true,
}

func severityOf(code string) string {
	switch {
	case warnings[code]:
		return SeverityWarning
	case infos[code]:
		return SeverityInfo
	default:
		return SeverityFail
	}
}

type findingSet struct {
	list []Finding
	seen map[string]bool
}

func (f *findingSet) add(code, message string, seq *int64, recordID string) {
	f.addFinding(code, message, seq, recordID, "")
}

// addKey adds a finding about one Verifier key.
func (f *findingSet) addKey(code, message, keyID string) {
	f.addFinding(code, message, nil, "", keyID)
}

func (f *findingSet) addFinding(code, message string, seq *int64, recordID, keyID string) {
	id := code + "|"
	if seq != nil {
		id += strconv.FormatInt(*seq, 10)
	}
	id += "|" + recordID + "|" + keyID
	if f.seen[id] {
		return
	}
	f.seen[id] = true
	severity := severityOf(code)
	finding := Finding{Code: code, Fails: severity == SeverityFail, Severity: severity, Message: message}
	if seq != nil {
		s := *seq
		finding.Seq = &s
	}
	if recordID != "" {
		r := recordID
		finding.RecordID = &r
	}
	if keyID != "" {
		k := keyID
		finding.KeyID = &k
	}
	f.list = append(f.list, finding)
}

func (f *findingSet) has(code string) bool {
	for _, x := range f.list {
		if x.Code == code {
			return true
		}
	}
	return false
}

func (f *findingSet) problemAt(seq int64) bool {
	for _, x := range f.list {
		if x.Seq != nil && *x.Seq == seq && checkpointProblems[x.Code] {
			return true
		}
	}
	return false
}

// sorted orders failures first, then by seq, record id and code.
func (f *findingSet) sorted() []Finding {
	rank := map[string]int{SeverityFail: 0, SeverityWarning: 1, SeverityInfo: 2}
	out := append([]Finding{}, f.list...)
	val := func(p *int64) int64 {
		if p == nil {
			return 0
		}
		return *p
	}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if rank[a.Severity] != rank[b.Severity] {
			return rank[a.Severity] < rank[b.Severity]
		}
		if val(a.Seq) != val(b.Seq) {
			return val(a.Seq) < val(b.Seq)
		}
		if str(a.RecordID) != str(b.RecordID) {
			return str(a.RecordID) < str(b.RecordID)
		}
		if str(a.KeyID) != str(b.KeyID) {
			return str(a.KeyID) < str(b.KeyID)
		}
		return a.Code < b.Code
	})
	return out
}

func ptr(n int64) *int64 { return &n }

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type fetched struct {
	status int
	header http.Header
	body   []byte
}

func fetchLimited(ctx context.Context, client *http.Client, rawURL string, limit int64) (*fetched, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.ContentLength > limit {
		return nil, fmt.Errorf("response is larger than %d bytes", limit)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("response is larger than %d bytes", limit)
	}
	return &fetched{status: resp.StatusCode, header: resp.Header, body: body}, nil
}

type listed struct {
	versionID  string
	uploaded   time.Time
	uploadedOK bool
}

type readCheckpoint struct {
	sha256     string
	parsed     *parsedCheckpoint
	lockExpiry time.Time
	locked     bool
}

func emptyReport(m *Manifest) *Report {
	return &Report{
		Stream: ReportStream{
			Bucket: m.Bucket, Region: m.Region, Generation: m.Generation, Organization: m.Stream,
		},
		Records:  []RecordResult{},
		Findings: []Finding{},
	}
}

func finish(r *Report, f *findingSet) *Report {
	r.Findings = f.sorted()
	r.OK = true
	for _, x := range r.Findings {
		if x.Fails {
			r.OK = false
		}
	}
	for _, rec := range r.Records {
		switch rec.Status {
		case StatusOK:
			r.Counts.OK++
		case StatusPending:
			r.Counts.Pending++
		case StatusDeleted:
			r.Counts.Deleted++
		case StatusMissing:
			r.Counts.Missing++
		case StatusTampered:
			r.Counts.Tampered++
		}
		switch rec.Signature {
		case SignatureValid:
			r.Signatures.Valid++
		case SignatureUnsigned:
			r.Signatures.Unsigned++
		case SignatureUnverified:
			r.Signatures.Unverified++
		case SignatureInvalid:
			r.Signatures.Invalid++
		}
	}
	return r
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// Verify checks a bundle as SPEC.md describes. It returns an error only when
// the bundle cannot be verified at all (a malformed manifest, a listing that
// cannot be fetched, unreadable saved checkpoints); every other problem is a
// finding in the report.
func Verify(ctx context.Context, b *Bundle, opts Options) (*Report, error) {
	m := &b.Manifest
	if err := ValidateManifest(m); err != nil {
		return nil, err
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	client := &http.Client{Timeout: defaultTimeout}
	if opts.HTTPClient != nil {
		c := *opts.HTTPClient
		client = &c
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	concurrency := opts.Concurrency
	if concurrency <= 0 {
		concurrency = 8
	}
	report := emptyReport(m)
	findings := &findingSet{seen: map[string]bool{}}
	host := s3Host(m.Bucket, m.Region)

	// 1. Where the URLs go.
	allowed := false
	for _, bucket := range opts.AllowedBuckets {
		if bucket == m.Bucket {
			allowed = true
		}
	}
	if !allowed {
		list := strings.Join(opts.AllowedBuckets, ", ")
		if list == "" {
			list = "none"
		}
		findings.add(CodeBucketNotAllowed, fmt.Sprintf(
			"The export points at bucket %q, which is not an allowed bucket (%s). Allow it only if you know it holds Spellguard's checkpoints for your environment.",
			m.Bucket, list), nil, "")
		return finish(report, findings), nil
	}
	if !region.MatchString(m.Region) {
		findings.add(CodeURLMismatch, fmt.Sprintf("The export names region %q, which is not an AWS region.", m.Region), nil, "")
		return finish(report, findings), nil
	}
	if expected := StreamPrefix(m.Generation, m.Stream); m.Prefix != expected {
		findings.add(CodeURLMismatch, fmt.Sprintf("The export's prefix %q is not this stream's (%q).", m.Prefix, expected), nil, "")
		return finish(report, findings), nil
	}
	for page, u := range m.Listing {
		if why := CheckListingURL(u, page, m); why != "" {
			findings.add(CodeURLMismatch, fmt.Sprintf("Listing page %d does not list this stream at %s: %s.", page+1, host, why), nil, "")
		}
	}
	for _, c := range m.Checkpoints {
		if why := CheckObjectURL(c.URL, c.Seq, m); why != "" {
			findings.add(CodeURLMismatch, fmt.Sprintf("The link for checkpoint %d does not read it from %s: %s.", c.Seq, host, why), ptr(c.Seq), "")
		}
	}
	if m.Keys != nil {
		if why := CheckKeysListingURL(m.Keys.Listing, m); why != "" {
			findings.add(CodeURLMismatch, fmt.Sprintf("The keys listing does not list the Verifier keys at %s: %s.", host, why), nil, "")
		}
		for _, k := range m.Keys.Objects {
			if why := CheckKeyURL(k.URL, k.KeyID, m); why != "" {
				findings.addKey(CodeURLMismatch, fmt.Sprintf("The link for Verifier key %s does not read it from %s: %s.", k.KeyID, host, why), k.KeyID)
			}
		}
	}
	if findings.has(CodeURLMismatch) {
		return finish(report, findings), nil
	}

	// 2. List the stream.
	type entryKey struct {
		marker bool
		key    string
		id     string
	}
	entries := map[entryKey]ListingEntry{}
	var pages []*ListingPage
	for page, u := range m.Listing {
		resp, err := fetchLimited(ctx, client, u, maxListingBytes)
		if err != nil {
			return nil, fmt.Errorf("listing page %d could not be fetched: %w", page+1, err)
		}
		if resp.status != http.StatusOK {
			hint := ""
			if resp.status == http.StatusForbidden {
				hint = fmt.Sprintf(" (the export's links expire at %s; export again if they have expired)", m.URLsExpireAt)
			}
			return nil, fmt.Errorf("listing page %d returned HTTP %d%s", page+1, resp.status, hint)
		}
		listing, err := ParseListVersions(resp.body)
		if err != nil {
			return nil, fmt.Errorf("listing page %d: %w", page+1, err)
		}
		pages = append(pages, listing)
		for _, e := range listing.Entries {
			entries[entryKey{e.DeleteMarker, e.Key, e.VersionID}] = e
		}
	}
	for page, listing := range pages {
		if !listing.IsTruncated {
			continue
		}
		last := page == len(pages)-1
		if !last {
			nextStart := CheckpointKey(m.Prefix, int64(page+1)*ListPageSeqs)
			if listing.NextKeyMarker != nil && *listing.NextKeyMarker > nextStart {
				continue
			}
		}
		if last {
			findings.add(CodeListingIncomplete, "The last listing page was cut off, so some objects in the stream were not seen. A stream holds one version per checkpoint; more than the page can hold means objects were added.", nil, "")
		} else {
			findings.add(CodeListingIncomplete, fmt.Sprintf("Listing page %d stopped before page %d begins, so some versions were not seen. A stream holds one version per checkpoint; more than the page can hold means versions were added.", page+1, page+2), nil, "")
		}
	}

	type slot struct{ versions, markers []ListingEntry }
	byKey := map[string]*slot{}
	for _, e := range entries {
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
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	listedSeqs := map[int64]*listed{}
	for _, key := range keys {
		s := byKey[key]
		var seq int64
		if strings.HasPrefix(key, m.Prefix) {
			if match := seqFile.FindStringSubmatch(key[len(m.Prefix):]); match != nil {
				seq, _ = strconv.ParseInt(match[1], 10, 64)
			}
		}
		if seq < 1 {
			findings.add(CodeUnexpectedKey, fmt.Sprintf("The stream's folder holds an object that is not a checkpoint: %s.", key), nil, "")
			continue
		}
		if len(s.markers) > 0 {
			findings.add(CodeDeleteMarker, fmt.Sprintf("Checkpoint %d has a delete marker on top of it. A locked version cannot be deleted, so this hides it rather than removing it.", seq), ptr(seq), "")
		}
		if len(s.versions) > 1 {
			findings.add(CodeExtraVersion, fmt.Sprintf("Checkpoint %d has %d versions. A checkpoint is written once; any other version was added on top of the locked original.", seq, len(s.versions)), ptr(seq), "")
		}
		// The oldest version is the original. Order the versions so ties and
		// unparsable times resolve the same way every run.
		versions := append([]ListingEntry{}, s.versions...)
		sort.SliceStable(versions, func(i, j int) bool { return versions[i].VersionID < versions[j].VersionID })
		var oldest *listed
		for _, v := range versions {
			t, ok := parseTime(v.LastModified)
			if oldest == nil || (ok && (!oldest.uploadedOK || t.Before(oldest.uploaded))) {
				oldest = &listed{versionID: v.VersionID, uploaded: t, uploadedOK: ok}
			}
		}
		if oldest != nil {
			listedSeqs[seq] = oldest
		}
	}
	sortedListed := make([]int64, 0, len(listedSeqs))
	for seq := range listedSeqs {
		sortedListed = append(sortedListed, seq)
	}
	sort.Slice(sortedListed, func(i, j int) bool { return sortedListed[i] < sortedListed[j] })
	var maxListed int64
	if n := len(sortedListed); n > 0 {
		maxListed = sortedListed[n-1]
	}
	for seq := int64(1); seq <= maxListed; seq++ {
		if listedSeqs[seq] == nil {
			findings.add(CodeCheckpointMissing, fmt.Sprintf("Checkpoint %d is not in the bucket.", seq), ptr(seq), "")
		}
	}

	// 2b. The Verifier keys.
	verifierKeys, err := readKeys(ctx, client, m, findings)
	if err != nil {
		return nil, err
	}

	// 3. Read and chain the checkpoints.
	manifestBySeq := map[int64]ManifestCheckpoint{}
	var maxManifest int64
	for _, c := range m.Checkpoints {
		manifestBySeq[c.Seq] = c
		if c.Seq > maxManifest {
			maxManifest = c.Seq
		}
		if listedSeqs[c.Seq] == nil {
			findings.add(CodeCheckpointMissing, fmt.Sprintf("Checkpoint %d is not in the bucket.", c.Seq), ptr(c.Seq), "")
		}
	}
	var toRead, beyond []int64
	for _, seq := range sortedListed {
		if seq > maxManifest {
			beyond = append(beyond, seq)
			continue
		}
		if _, ok := manifestBySeq[seq]; ok {
			toRead = append(toRead, seq)
		} else {
			findings.add(CodeCheckpointNotExported, fmt.Sprintf("Checkpoint %d is in the bucket, but the export has no link to read it.", seq), ptr(seq), "")
		}
	}
	if len(beyond) > 0 {
		findings.add(CodeCheckpointsBeyondExport, fmt.Sprintf(
			"%d newer checkpoint%s uploaded after this export (from %d). Export again to include %s.",
			len(beyond), plural(len(beyond), " was", "s were"), beyond[0], plural(len(beyond), "it", "them")),
			ptr(beyond[0]), "")
	}

	type outcome struct {
		resp *fetched
		err  error
	}
	responses := make(map[int64]outcome, len(toRead))
	var mu sync.Mutex
	var wg sync.WaitGroup
	work := make(chan int64)
	for i := 0; i < concurrency && i < len(toRead); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for seq := range work {
				resp, err := fetchLimited(ctx, client, manifestBySeq[seq].URL, maxObjectBytes)
				mu.Lock()
				responses[seq] = outcome{resp, err}
				mu.Unlock()
			}
		}()
	}
	for _, seq := range toRead {
		work <- seq
	}
	close(work)
	wg.Wait()

	read := map[int64]*readCheckpoint{}
	for _, seq := range toRead {
		out := responses[seq]
		entry := manifestBySeq[seq]
		was := listedSeqs[seq]
		if out.err != nil {
			findings.add(CodeCheckpointUnreadable, fmt.Sprintf("Checkpoint %d could not be read (%s).", seq, out.err.Error()), ptr(seq), "")
			continue
		}
		resp := out.resp
		if resp.status != http.StatusOK {
			findings.add(CodeCheckpointUnreadable, fmt.Sprintf("Checkpoint %d could not be read (HTTP %d).", seq, resp.status), ptr(seq), "")
			continue
		}
		cp := &readCheckpoint{sha256: sha256Hex(resp.body)}
		if versionID := resp.header.Get("x-amz-version-id"); versionID != was.versionID {
			got := versionID
			if got == "" {
				got = "(none)"
			}
			findings.add(CodeVersionMismatch, fmt.Sprintf("Checkpoint %d was read as version %s, but its original version is %s.", seq, got, was.versionID), ptr(seq), "")
		}
		retainUntil, retainOK := parseTime(resp.header.Get("x-amz-object-lock-retain-until-date"))
		if resp.header.Get("x-amz-object-lock-mode") != "COMPLIANCE" || !retainOK {
			findings.add(CodeNotLocked, fmt.Sprintf("Checkpoint %d has no compliance lock.", seq), ptr(seq), "")
		} else {
			cp.lockExpiry, cp.locked = retainUntil, true
		}
		if !utf8.Valid(resp.body) {
			findings.add(CodeCheckpointInvalid, fmt.Sprintf("Checkpoint %d is not valid UTF-8.", seq), ptr(seq), "")
		} else if parsed, why := parseCheckpoint(resp.body, m, seq); parsed == nil {
			findings.add(CodeCheckpointInvalid, fmt.Sprintf("Checkpoint %d is not a valid checkpoint: %s.", seq, why), ptr(seq), "")
		} else {
			cp.parsed = parsed
		}
		var ledger []string
		if entry.SHA256 != cp.sha256 {
			ledger = append(ledger, fmt.Sprintf("it hashes to %s, not %s", cp.sha256, entry.SHA256))
		}
		if cp.parsed != nil && entry.Kind != cp.parsed.Kind {
			ledger = append(ledger, fmt.Sprintf("it is a %s, not a %s", cp.parsed.Kind, entry.Kind))
		}
		if cp.parsed != nil && entry.LeafCount != cp.parsed.leafCount() {
			ledger = append(ledger, fmt.Sprintf("it lists %d records, not %d", cp.parsed.leafCount(), entry.LeafCount))
		}
		if len(ledger) > 0 {
			findings.add(CodeLedgerMismatch, fmt.Sprintf("Spellguard's own record of checkpoint %d disagrees with the bucket: %s.", seq, strings.Join(ledger, "; ")), ptr(seq), "")
		}
		read[seq] = cp
	}
	for _, seq := range toRead {
		cp := read[seq]
		if cp == nil || cp.parsed == nil || seq == 1 {
			continue
		}
		previous := read[seq-1]
		if previous != nil && (cp.parsed.Previous == nil || *cp.parsed.Previous != previous.sha256) {
			named := "null"
			if cp.parsed.Previous != nil {
				named = *cp.parsed.Previous
			}
			findings.add(CodeChainBroken, fmt.Sprintf("Checkpoint %d does not link to checkpoint %d: it names %s, but checkpoint %d hashes to %s.", seq, seq-1, named, seq-1, previous.sha256), ptr(seq), "")
		}
	}

	// Summary of the stream.
	var first, last time.Time
	var haveTimes bool
	for _, l := range listedSeqs {
		if !l.uploadedOK {
			continue
		}
		if !haveTimes || l.uploaded.Before(first) {
			first = l.uploaded
		}
		if !haveTimes || l.uploaded.After(last) {
			last = l.uploaded
		}
		haveTimes = true
	}
	var earliestLock time.Time
	var haveLock bool
	for _, cp := range read {
		if cp.locked && (!haveLock || cp.lockExpiry.Before(earliestLock)) {
			earliestLock, haveLock = cp.lockExpiry, true
		}
		if cp.parsed != nil {
			switch cp.parsed.Kind {
			case "records":
				report.Checkpoints.ByKind.Records++
			case "disposal":
				report.Checkpoints.ByKind.Disposal++
			case "heartbeat":
				report.Checkpoints.ByKind.Heartbeat++
			}
		}
	}
	report.Checkpoints.Count = len(listedSeqs)
	report.Checkpoints.FirstUploadedAt = isoPtr(first, haveTimes)
	report.Checkpoints.LastUploadedAt = isoPtr(last, haveTimes)
	report.Checkpoints.EarliestLockExpiry = isoPtr(earliestLock, haveLock)
	if haveTimes && now.Sub(last) > staleAfter {
		hours := int(now.Sub(last) / time.Hour)
		findings.add(CodeStreamStale, fmt.Sprintf("The newest checkpoint was uploaded %d hours ago. Checkpoints have stopped, so records since then are not protected; older ones still are.", hours), nil, "")
	}

	// 4. Saved checkpoints.
	key := StateKey(m.Bucket, m.Generation, m.Stream)
	var saved *SavedStream
	if opts.State != nil {
		var err error
		if saved, err = opts.State.Load(key); err != nil {
			return nil, err
		}
		if saved != nil {
			seqs := make([]int64, 0, len(saved.Checkpoints))
			hashes := map[int64]string{}
			for text, hash := range saved.Checkpoints {
				seq, err := strconv.ParseInt(text, 10, 64)
				if err != nil {
					continue
				}
				seqs = append(seqs, seq)
				hashes[seq] = hash
			}
			sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
			for _, seq := range seqs {
				if listedSeqs[seq] == nil {
					findings.add(CodeSavedCheckpointGone, fmt.Sprintf("Checkpoint %d, which you verified on %s, is no longer in the bucket.", seq, saved.VerifiedAt), ptr(seq), "")
					continue
				}
				if cp := read[seq]; cp != nil && cp.sha256 != hashes[seq] {
					findings.add(CodeSavedCheckpointChanged, fmt.Sprintf("Checkpoint %d no longer matches the copy you verified on %s.", seq, saved.VerifiedAt), ptr(seq), "")
				}
			}
		}
		everything, err := opts.State.All()
		if err != nil {
			return nil, err
		}
		otherKeys := make([]string, 0, len(everything))
		for k := range everything {
			otherKeys = append(otherKeys, k)
		}
		sort.Strings(otherKeys)
		for _, k := range otherKeys {
			other := everything[k]
			if k != key && other != nil && other.Bucket == m.Bucket && other.Stream == m.Stream && other.Generation != m.Generation {
				findings.add(CodeStreamGenerationChanged, fmt.Sprintf("You verified this organization before under database generation %s; this export is generation %s. That is expected after Spellguard rebuilds a database; otherwise treat it as a rewrite.", other.Generation, m.Generation), nil, "")
			}
		}
	}

	// 5. Records.
	type leafInfo struct {
		seq      int64
		sha256   string
		uploaded *string
	}
	type disposalInfo struct {
		seq    int64
		leaf   disposalLeaf
		reason string
	}
	leafByID := map[string]leafInfo{}
	disposalByID := map[string]disposalInfo{}
	var disposalOrder []string
	for _, seq := range toRead {
		cp := read[seq]
		if cp == nil || cp.parsed == nil {
			continue
		}
		l := listedSeqs[seq]
		uploaded := isoPtr(l.uploaded, l.uploadedOK)
		switch cp.parsed.Kind {
		case "records":
			for _, leaf := range cp.parsed.Records {
				if _, dup := leafByID[leaf.ID]; dup {
					findings.add(CodeDuplicateLeaf, fmt.Sprintf("Record %s is listed again in checkpoint %d; a record is checkpointed once.", leaf.ID, seq), ptr(seq), leaf.ID)
					continue
				}
				leafByID[leaf.ID] = leafInfo{seq: seq, sha256: leaf.SHA256, uploaded: uploaded}
			}
		case "disposal":
			for _, leaf := range cp.parsed.Disposals {
				if _, seen := disposalByID[leaf.ID]; !seen {
					disposalByID[leaf.ID] = disposalInfo{seq: seq, leaf: leaf, reason: cp.parsed.Reason}
					disposalOrder = append(disposalOrder, leaf.ID)
				}
			}
		}
	}
	for _, id := range disposalOrder {
		d := disposalByID[id]
		leaf, ok := leafByID[id]
		var mismatch bool
		if ok {
			mismatch = leaf.sha256 != d.leaf.SHA256 || leaf.seq != d.leaf.CheckpointSeq
		} else if named := read[d.leaf.CheckpointSeq]; named != nil && named.parsed != nil {
			mismatch = named.parsed.Kind == "records"
		}
		if mismatch {
			findings.add(CodeDisposalMismatch, fmt.Sprintf("The deletion of %s announced in checkpoint %d does not match the record checkpoint %d listed.", id, d.seq, d.leaf.CheckpointSeq), ptr(d.seq), id)
		}
	}

	exported := map[string]bool{}
	for _, line := range b.Records {
		exported[line.ID] = true
		result := RecordResult{ID: line.ID, Status: StatusOK, Codes: []string{}}
		tamper := func(code, message string, seq *int64) {
			result.Status = StatusTampered
			if !containsString(result.Codes, code) {
				result.Codes = append(result.Codes, code)
			}
			findings.add(code, message, seq, line.ID)
		}
		leaf, haveLeaf := leafByID[line.ID]
		if haveLeaf {
			result.Seq = ptr(leaf.seq)
			result.UploadedAt = leaf.uploaded
		} else if line.CheckpointSeq != nil {
			result.Seq = ptr(*line.CheckpointSeq)
		}
		if !recordHasID(line.Record, line.ID) {
			tamper(CodeRecordInvalid, fmt.Sprintf("The exported record is not a valid record with id %s.", line.ID), result.Seq)
		} else {
			result.Record = json.RawMessage(line.Record)
			switch {
			case haveLeaf:
				if sha256Hex([]byte(line.Record)) != leaf.sha256 {
					detail := ""
					if line.CheckpointedRecord != nil && sha256Hex([]byte(*line.CheckpointedRecord)) == leaf.sha256 {
						if diff, ok := diffRecords(line.Record, *line.CheckpointedRecord); ok && len(diff) > 0 {
							result.Diff = diff
							detail = ": " + DescribeDiff(diff)
						}
					}
					tamper(CodeRecordChanged, fmt.Sprintf("Changed after checkpoint %d%s.", leaf.seq, detail), ptr(leaf.seq))
				}
			case line.CheckpointSeq == nil || *line.CheckpointSeq > maxListed:
				result.Status = StatusPending
			default:
				tamper(CodeRecordUnlisted, fmt.Sprintf("Spellguard says checkpoint %d lists this record, but no checkpoint the audit checker read does.", *line.CheckpointSeq), ptr(*line.CheckpointSeq))
			}
			// The signature, pending records included.
			_, fields, _ := objectFields(line.Record)
			sig := checkSignature(fields, line.SignedRecord, verifierKeys)
			result.Signature = sig.state
			if sig.keyID != "" {
				k := sig.keyID
				result.SignedBy = &k
			}
			switch {
			case sig.code == "":
			case sig.state == SignatureInvalid:
				result.SignedDiff = sig.diff
				tamper(sig.code, sig.message, result.Seq)
			default:
				if !containsString(result.Codes, sig.code) {
					result.Codes = append(result.Codes, sig.code)
				}
				findings.add(sig.code, sig.message, result.Seq, line.ID)
			}
		}
		if d, ok := disposalByID[line.ID]; ok {
			tamper(CodeDisposedButPresent, fmt.Sprintf("Announced as deleted in checkpoint %d, but still in the export.", d.seq), ptr(d.seq))
		}
		report.Records = append(report.Records, result)
	}

	from := int64(1)
	var to *int64 = ptr(maxManifest)
	if m.Records != nil {
		from, to = m.Records.FromSeq, m.Records.ToSeq
	}
	for _, seq := range toRead {
		if seq < from || (to != nil && seq > *to) {
			continue
		}
		cp := read[seq]
		if cp == nil || cp.parsed == nil || cp.parsed.Kind != "records" {
			continue
		}
		for _, entry := range cp.parsed.Records {
			leaf, ok := leafByID[entry.ID]
			if exported[entry.ID] || !ok || leaf.seq != seq {
				continue
			}
			exported[entry.ID] = true
			result := RecordResult{ID: entry.ID, Status: StatusMissing, Seq: ptr(seq), UploadedAt: leaf.uploaded, Codes: []string{}}
			d, announced := disposalByID[entry.ID]
			switch {
			case announced && d.leaf.SHA256 == leaf.sha256 && d.leaf.CheckpointSeq == seq:
				result.Status = StatusDeleted
				result.Reason = d.reason
				if d.reason == "unattributed" {
					result.Codes = append(result.Codes, CodeRecordDeletedUnexplained)
					findings.add(CodeRecordDeletedUnexplained, fmt.Sprintf("Deleted outside any retention or purge path; checkpoint %d announced it as unattributed.", d.seq), ptr(d.seq), entry.ID)
				}
			case announced:
				result.Status = StatusTampered
				result.Codes = append(result.Codes, CodeDisposalMismatch)
				findings.add(CodeDisposalMismatch, fmt.Sprintf("The deletion of %s announced in checkpoint %d does not match the record checkpoint %d listed.", entry.ID, d.seq, d.leaf.CheckpointSeq), ptr(d.seq), entry.ID)
			default:
				result.Codes = append(result.Codes, CodeRecordMissing)
				findings.add(CodeRecordMissing, fmt.Sprintf("Listed in checkpoint %d but missing from the export, with no deletion announced.", seq), ptr(seq), entry.ID)
			}
			report.Records = append(report.Records, result)
		}
	}

	// Save what verified cleanly. A saved hash is never overwritten.
	if opts.State != nil {
		next := &SavedStream{Bucket: m.Bucket, Generation: m.Generation, Stream: m.Stream, Checkpoints: map[string]string{}}
		if saved != nil {
			next = cloneStream(saved)
		}
		for _, seq := range toRead {
			cp := read[seq]
			if cp == nil || findings.problemAt(seq) {
				continue
			}
			id := strconv.FormatInt(seq, 10)
			if _, have := next.Checkpoints[id]; !have {
				next.Checkpoints[id] = cp.sha256
			}
		}
		next.VerifiedAt = isoTime(now)
		if err := opts.State.Save(key, next); err != nil {
			findings.add(CodeStateNotSaved, fmt.Sprintf("The checkpoints verified this time were not saved (%s), so a later run cannot compare against them.", err.Error()), nil, "")
		}
	}

	return finish(report, findings), nil
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// recordHasID reports whether text is one JSON object whose id is id.
func recordHasID(text, id string) bool {
	var fields map[string]any
	decoder := json.NewDecoder(strings.NewReader(text))
	if err := decoder.Decode(&fields); err != nil || fields == nil || decoder.More() {
		return false
	}
	got, ok := fields["id"].(string)
	return ok && got == id
}

// objectFields reads a JSON object's top-level fields in order, keeping each
// value's text. A repeated key keeps its first position and its last value, as
// JavaScript's JSON.parse does.
func objectFields(text string) ([]string, map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	open, err := decoder.Token()
	if err != nil || open != json.Delim('{') {
		return nil, nil, errors.New("not a JSON object")
	}
	var order []string
	values := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, nil, err
		}
		name, ok := token.(string)
		if !ok {
			return nil, nil, errors.New("not a JSON object")
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, nil, err
		}
		if _, seen := values[name]; !seen {
			order = append(order, name)
		}
		values[name] = raw
	}
	return order, values, nil
}

func diffRecords(nowText, wasText string) ([]FieldDiff, bool) {
	nowOrder, now, err := objectFields(nowText)
	if err != nil {
		return nil, false
	}
	wasOrder, was, err := objectFields(wasText)
	if err != nil {
		return nil, false
	}
	fields := append([]string{}, wasOrder...)
	for _, k := range nowOrder {
		if _, ok := was[k]; !ok {
			fields = append(fields, k)
		}
	}
	null := json.RawMessage("null")
	var out []FieldDiff
	for _, field := range fields {
		a, ok := now[field]
		if !ok {
			a = null
		}
		b, ok := was[field]
		if !ok {
			b = null
		}
		if !jsonEqual(a, b) {
			out = append(out, FieldDiff{Field: field, Now: compactRaw(a), Was: compactRaw(b)})
		}
	}
	return out, true
}

func jsonEqual(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return bytes.Equal(a, b)
	}
	return deepEqual(x, y)
}

func deepEqual(a, b any) bool {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok || !deepEqual(v, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !deepEqual(x[i], y[i]) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}

func compactRaw(raw json.RawMessage) json.RawMessage {
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return raw
	}
	return json.RawMessage(buf.Bytes())
}

// DescribeDiff describes a diff the way the reports print it.
func DescribeDiff(diff []FieldDiff) string {
	parts := make([]string, 0, len(diff))
	for _, d := range diff {
		parts = append(parts, fmt.Sprintf("%s is %s, was checkpointed as %s", d.Field, compactRaw(d.Now), compactRaw(d.Was)))
	}
	return strings.Join(parts, "; ")
}
