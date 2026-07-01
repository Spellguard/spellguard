// SPDX-License-Identifier: Apache-2.0

// Resolves the git repository root for a given working directory. Used by the
// PostToolUse hook (Edit/Write recording) and the SessionStart commit watcher
// to ensure both sides key edits and commit-diff paths off the *repo root*,
// not whatever subdirectory Claude Code happened to launch in.
//
// Both sites resolve the git root rather than using `input.cwd` (or
// `process.cwd()`) directly. When a user opens Claude in `/repo/web`, edits land keyed by
// `src/foo.ts` but `git show <sha>` emits `web/src/foo.ts`. The keys never
// align and every commit silently scores 0% attribution. Resolving the git
// root once and using it as the canonical key root fixes the monorepo /
// subdir-cwd case.

import { execFileSync } from 'node:child_process';

export function resolveGitRoot(cwd: string): string {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git repo, or git missing. Fall back to the input directory so
    // existing behavior (no attribution but no crash) is preserved.
    return cwd;
  }
}
