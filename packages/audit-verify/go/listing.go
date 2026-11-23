// SPDX-License-Identifier: Apache-2.0

package auditverify

import (
	"encoding/xml"
	"errors"
	"fmt"
	"strings"
)

// ListingEntry is one Version or DeleteMarker in a ListObjectVersions page.
type ListingEntry struct {
	Key          string
	VersionID    string
	LastModified string
	DeleteMarker bool
}

// ListingPage is a parsed ListObjectVersions response.
type ListingPage struct {
	IsTruncated   bool
	Prefix        string
	KeyMarker     string
	NextKeyMarker *string
	Entries       []ListingEntry
}

type xmlEntry struct {
	Key          *string `xml:"Key"`
	VersionID    *string `xml:"VersionId"`
	LastModified *string `xml:"LastModified"`
}

// ParseListVersions parses an S3 ListVersionsResult document.
func ParseListVersions(data []byte) (*ListingPage, error) {
	decoder := xml.NewDecoder(strings.NewReader(string(data)))
	var root *xml.StartElement
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, errors.New("not a ListVersionsResult document")
		}
		if start, ok := token.(xml.StartElement); ok {
			root = &start
			break
		}
	}
	if root.Name.Local != "ListVersionsResult" {
		return nil, errors.New("not a ListVersionsResult document")
	}
	page := &ListingPage{}
	var truncated *string
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("listing XML: %w", err)
		}
		if _, ok := token.(xml.EndElement); ok {
			break
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		switch start.Name.Local {
		case "Version", "DeleteMarker":
			var e xmlEntry
			if err := decoder.DecodeElement(&e, &start); err != nil {
				return nil, fmt.Errorf("listing XML: %w", err)
			}
			if e.Key == nil || e.VersionID == nil || e.LastModified == nil {
				return nil, fmt.Errorf("a %s entry is missing Key, VersionId or LastModified", start.Name.Local)
			}
			page.Entries = append(page.Entries, ListingEntry{
				Key:          *e.Key,
				VersionID:    *e.VersionID,
				LastModified: *e.LastModified,
				DeleteMarker: start.Name.Local == "DeleteMarker",
			})
		case "IsTruncated", "Prefix", "KeyMarker", "NextKeyMarker":
			var text string
			if err := decoder.DecodeElement(&text, &start); err != nil {
				return nil, fmt.Errorf("listing XML: %w", err)
			}
			switch start.Name.Local {
			case "IsTruncated":
				truncated = &text
			case "Prefix":
				page.Prefix = text
			case "KeyMarker":
				page.KeyMarker = text
			case "NextKeyMarker":
				page.NextKeyMarker = &text
			}
		default:
			if err := decoder.Skip(); err != nil {
				return nil, fmt.Errorf("listing XML: %w", err)
			}
		}
	}
	if truncated == nil || (*truncated != "true" && *truncated != "false") {
		return nil, errors.New("IsTruncated is missing")
	}
	page.IsTruncated = *truncated == "true"
	return page, nil
}
