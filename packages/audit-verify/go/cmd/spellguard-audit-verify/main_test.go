// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const scenarios = "../../../testdata/scenarios/"

func TestUsageErrorsExitTwo(t *testing.T) {
	for _, args := range [][]string{
		{},
		{"a", "b"},
		{"--state", "x", "--no-state", scenarios + "pass"},
		{"--no-such-flag", scenarios + "pass"},
		{t.TempDir()},
	} {
		var out, errOut bytes.Buffer
		if code := run(args, &out, &errOut); code != 2 {
			t.Errorf("run(%q) = %d, want 2 (stderr %s)", args, code, errOut.String())
		}
	}
}

func TestOnlyTheProductionBucketByDefault(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run([]string{"--no-state", scenarios + "pass"}, &out, &errOut)
	if code != 1 || !strings.Contains(out.String(), "not an allowed bucket") || !strings.Contains(out.String(), "FAILED") {
		t.Fatalf("code %d, out:\n%s\nerr: %s", code, out.String(), errOut.String())
	}
}

func TestJSONReportForAMismatchedURL(t *testing.T) {
	var out, errOut bytes.Buffer
	code := run([]string{"--no-state", "--json", "--allow-bucket", "spellguard-audit-checkpoints-test", scenarios + "url_mismatch"}, &out, &errOut)
	if code != 1 {
		t.Fatalf("code %d, err: %s", code, errOut.String())
	}
	var report struct {
		OK       bool `json:"ok"`
		Findings []struct {
			Code string `json:"code"`
		} `json:"findings"`
	}
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if report.OK || len(report.Findings) != 1 || report.Findings[0].Code != "url_mismatch" {
		t.Fatalf("report %+v", report)
	}
}
