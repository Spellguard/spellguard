// SPDX-License-Identifier: Apache-2.0

// Command spellguard-audit-verify checks a Spellguard audit export against its
// checkpoints in S3 Object Lock, on your own machine. See SPEC.md.
//
//	spellguard-audit-verify [--allow-bucket NAME]... [--state FILE | --no-state] [--json] BUNDLE_DIR
//
// Exit status: 0 when verification passes, 1 when it fails, 2 when it could
// not run.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	auditverify "github.com/spellguard/audit-verify"
)

type bucketList []string

func (b *bucketList) String() string { return strings.Join(*b, ",") }

func (b *bucketList) Set(v string) error {
	if v == "" {
		return errors.New("bucket name is empty")
	}
	*b = append(*b, v)
	return nil
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("spellguard-audit-verify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var buckets bucketList
	flags.Var(&buckets, "allow-bucket", "also allow this checkpoint bucket (repeatable); "+auditverify.ProductionBucket+" is always allowed")
	statePath := flags.String("state", "", "file that keeps the checkpoints you have verified (default: your config directory)")
	noState := flags.Bool("no-state", false, "do not read or save verified checkpoints")
	asJSON := flags.Bool("json", false, "print the report as JSON")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "usage: spellguard-audit-verify [--allow-bucket NAME]... [--state FILE | --no-state] [--json] BUNDLE_DIR")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 1 {
		flags.Usage()
		return 2
	}
	if *noState && *statePath != "" {
		fmt.Fprintln(stderr, "spellguard-audit-verify: --state and --no-state cannot be used together")
		return 2
	}

	bundle, err := auditverify.LoadBundle(flags.Arg(0))
	if err != nil {
		fmt.Fprintf(stderr, "spellguard-audit-verify: %v\n", err)
		return 2
	}
	opts := auditverify.Options{
		AllowedBuckets: append([]string{auditverify.ProductionBucket}, buckets...),
		Now:            time.Now(),
	}
	if !*noState {
		path := *statePath
		if path == "" {
			if path, err = auditverify.DefaultStatePath(); err != nil {
				fmt.Fprintf(stderr, "spellguard-audit-verify: no place to keep verified checkpoints (%v); pass --state FILE or --no-state\n", err)
				return 2
			}
		}
		opts.State = auditverify.FileState(path)
	}

	report, err := auditverify.Verify(context.Background(), bundle, opts)
	if err != nil {
		fmt.Fprintf(stderr, "spellguard-audit-verify: %v\n", err)
		return 2
	}
	if *asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fmt.Fprintf(stderr, "spellguard-audit-verify: %v\n", err)
			return 2
		}
	} else if err := report.WriteText(stdout); err != nil {
		fmt.Fprintf(stderr, "spellguard-audit-verify: %v\n", err)
		return 2
	}
	if !report.OK {
		return 1
	}
	return 0
}
