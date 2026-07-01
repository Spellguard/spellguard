// SPDX-License-Identifier: Apache-2.0

// Parser for `git show <sha>` output. Converts the unified-diff portion
// of `git show` into the `Record<filepath, CommitDiffFile>` shape expected
// by the commit-observation emitter's `diffProvider`.
//
// Scope (v1): plain text diffs. Binary diffs ("Binary files ... differ"),
// pure renames (no content change), and submodule pointer changes produce
// empty added/removed line arrays for the affected paths — the parser does
// not throw on these shapes, but it also does not synthesize content.
//
// Path extraction: we deliberately do NOT parse the path from the
// `diff --git a/<path> b/<path>` header. The header has no unambiguous
// separator when paths themselves contain ` b/` (e.g., `vendor/lib b/x.ts`),
// so a lazy `(.+?) b/(.+)` regex picks the wrong split point and silently
// mis-attributes every file with that property. Instead, we read the path
// from the `+++ b/<path>` line (or fall back to `--- a/<path>` when the
// b-side is `/dev/null`, i.e. file deletion). Those lines extend to
// end-of-line unambiguously.

import type { CommitDiffFile } from './diff-overlap';

// `diff --git ` is just a section delimiter — it resets per-file state
// but is not the source of truth for the path.
const DIFF_HEADER = /^diff --git /;
// `+++ b/<path>` (new file content) or `+++ /dev/null` (deletion).
const PLUS_PLUS_PLUS = /^\+\+\+ (?:b\/(.+)|\/dev\/null\s*$)/;
// `--- a/<path>` (old file content) or `--- /dev/null` (creation).
const MINUS_MINUS_MINUS = /^--- (?:a\/(.+)|\/dev\/null\s*$)/;

// Prefixes for diff metadata lines that must be skipped before classifying
// the remaining `+`/`-` lines as added/removed content. Centralized in one
// place so `parseShowDiff` stays under Biome's cognitive-complexity gate.
const METADATA_PREFIXES = [
  '@@',
  'index ',
  'similarity index ',
  'rename from ',
  'rename to ',
  'new file mode ',
  'deleted file mode ',
  'old mode ',
  'new mode ',
  'Binary files ',
  '\\ No newline at end of file',
];

function isMetadataLine(line: string): boolean {
  for (const prefix of METADATA_PREFIXES) {
    if (line.startsWith(prefix)) return true;
  }
  return false;
}

export function parseShowDiff(output: string): Record<string, CommitDiffFile> {
  const result: Record<string, CommitDiffFile> = {};
  let current: CommitDiffFile | null = null;
  // Per-file state captured between `diff --git` markers.
  let aPath: string | null = null;
  let inDiffSection = false;

  for (const line of output.split('\n')) {
    if (DIFF_HEADER.test(line)) {
      // New file section starting — reset per-file state. The path is not
      // yet known; we'll learn it from the upcoming `+++` / `---` lines.
      current = null;
      aPath = null;
      inDiffSection = true;
      continue;
    }

    if (!inDiffSection) continue;

    const minusMatch = MINUS_MINUS_MINUS.exec(line);
    if (minusMatch) {
      // Capture the a-path candidate (undefined when /dev/null).
      aPath = minusMatch[1] ?? null;
      continue;
    }

    const plusMatch = PLUS_PLUS_PLUS.exec(line);
    if (plusMatch) {
      // Prefer the b-path; fall back to a-path if b is /dev/null (deletion).
      const path = plusMatch[1] ?? aPath;
      if (path) {
        current = result[path] ?? { addedLines: [], removedLines: [] };
        result[path] = current;
      } else {
        current = null;
      }
      continue;
    }

    if (!current || isMetadataLine(line)) continue;

    if (line.startsWith('+')) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      current.removedLines.push(line.slice(1));
    }
    // Context lines (start with ' ') and other content are ignored.
  }

  return result;
}
