// SPDX-License-Identifier: Apache-2.0

// Commit watcher: observes the local git repo for new commits during a
// Claude Code session and invokes `onCommit` for each previously-unseen
// branch HEAD SHA.
//
// We watch `.git/logs/HEAD` rather than `.git/refs/heads/`
// because Linux `fs.watch` is NON-RECURSIVE (`recursive: true` is supported
// only on darwin/win32) and `refs/heads/` contains nested directories like
// `refs/heads/feature/foo`. A flat watcher on `refs/heads/` therefore
// silently misses every commit on a non-flat branch. Git appends one line
// to `.git/logs/HEAD` for every ref motion regardless of nesting (this is
// the file backing `git reflog show HEAD`), gated by
// `core.logAllRefUpdates` which defaults to `true` for every interactive
// repo. One file, one watcher, all branches covered.
//
// Lifecycle: the watcher uses `persistent: true` so the hook process stays
// alive after `runSessionStart` resolves — git ref changes can fire later
// during the Claude Code session. Call `stop()` to release the watcher and
// let the process exit cleanly.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// Shared options for all git exec calls so the option object is
// defined in a single place and is consistent across all call sites.
// The body call additionally spreads `{ ...GIT_EXEC_OPTS, maxBuffer: ... }`.
// Note: `stdio` is typed as a mutable tuple (not `as const`) so it remains
// assignable to the `StdioOptions` overloads of execFileSync.
const GIT_EXEC_OPTS = {
  encoding: 'utf8' as const,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
};

// 64 MB buffer for the %B body call. Commits with large embedded
// patches or auto-changelogs can exceed execFileSync's default 1 MB limit,
// which would silently drop the whole commit via the outer catch. A 64 MB cap
// is generous enough for any realistic commit message.
const GIT_BODY_MAX_BUFFER = 64 * 1024 * 1024;

// Throttle state for enumerateBranchHeads persistent-failure warnings.
// Keyed by workingDir so each watched repo gets its own throttle window.
// Value: timestamp (ms) of the last emitted warning for that directory.
// A warning is suppressed if one was already emitted within
// ENUMERATE_WARN_THROTTLE_MS milliseconds.
const ENUMERATE_WARN_THROTTLE_MS = 60_000;
const enumerateFailureLastWarnAt = new Map<string, number>();

export interface CommitEvent {
  sha: string;
  branch: string;
  authoredAt: string;
  authorName: string | null;
  authorEmail: string | null;
  committedAt: string | null;
  committerName: string | null;
  committerEmail: string | null;
  message: string;
  parentSha: string | null;
  parentShas: string[];
  workingDir: string;
}

// Branch name validator — a character allow-list plus an explicit `..`
// block. Git refnames technically allow `..` but
// it's a path-traversal idiom (`refs/heads/feature/../HEAD`) and we never
// expect to see it on a real branch. Defense-in-depth: even though the
// args go through execFileSync (no shell), this keeps the validator
// honest as the documented gate, mirroring git's own check-ref-format
// rules.
const VALID_BRANCH_NAME = /^[A-Za-z0-9_\-./]+$/;
const VALID_SHA = /^[0-9a-f]{40}$/;

function isValidBranchName(name: string): boolean {
  if (!VALID_BRANCH_NAME.test(name)) return false;
  // Reject `..`, `.lock` suffix, leading `.`, trailing `/`, and `//`.
  if (name.includes('..')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.startsWith('.') || name.endsWith('/')) return false;
  if (name.includes('//')) return false;
  return true;
}

/**
 * Resolve the absolute path of `.git/logs/HEAD` for the given working
 * directory using `git rev-parse --git-path`. This is worktree-safe: in a
 * `git worktree add` checkout `.git` is a FILE (not a directory), so the
 * naive `join(workingDir, '.git', 'logs', 'HEAD')` path does not exist. Git's
 * `--git-path` plumbing resolves through the gitdir pointer and returns the
 * real path in the main repo's `.git/worktrees/<name>/logs/HEAD`.
 *
 * Returns `null` if git is not available or the directory is not a git repo.
 *
 * Exposed for byte-offset reflog tracking so it can reuse the same
 * resolution logic without duplicating the rev-parse call.
 */
export function resolveReflogPath(workingDir: string): string | null {
  try {
    const raw = execFileSync(
      'git',
      ['-C', workingDir, 'rev-parse', '--git-path', 'logs/HEAD'],
      GIT_EXEC_OPTS,
    ).trim();
    if (!raw) return null;
    // `--git-path` returns an absolute path in worktrees and a relative path
    // (e.g. `.git/logs/HEAD`) in normal repos. Resolve relative paths against
    // the working directory.
    return isAbsolute(raw) ? raw : resolve(workingDir, raw);
  } catch {
    return null;
  }
}

function readCommitMeta(
  workingDir: string,
  sha: string,
): {
  sha: string;
  parentSha: string | null;
  parentShas: string[];
  authoredAt: string;
  authorName: string | null;
  authorEmail: string | null;
  committedAt: string | null;
  committerName: string | null;
  committerEmail: string | null;
  message: string;
} | null {
  if (!VALID_SHA.test(sha)) return null;
  try {
    // SHA is regex-validated above to /^[0-9a-f]{40}$/ so it
    // cannot be interpreted as an option. `git show` treats anything
    // after `--` as a pathspec (not a ref), so we deliberately don't
    // pass `--` here — the regex is the load-bearing defense.
    //
    // Extract author/committer name+email+date too. The plugin
    // is the only ingest path where a human-committed (0%-attribution)
    // commit can flow through; the server uses these fields to populate
    // commits.author_* / committer_* so the activity feed can render the
    // commit even when no agent attribution is attached.
    //
    // Use `-C workingDir` instead of `--git-dir join(workingDir,
    // '.git')` so this works in `git worktree add` checkouts where .git
    // is a FILE, not a directory. `-C` lets git resolve the gitdir itself.
    const out = execFileSync(
      'git',
      [
        '-C',
        workingDir,
        'show',
        '-s',
        '--format=%H%x09%P%x09%aI%x09%an%x09%ae%x09%cI%x09%cn%x09%ce',
        sha,
      ],
      GIT_EXEC_OPTS,
    );
    const parts = out.trim().split('\t');
    const [
      shaOut,
      parents,
      authoredAt,
      authorName,
      authorEmail,
      committedAt,
      committerName,
      committerEmail,
    ] = parts;
    // Re-validate the SHA from `git show` output before threading
    // it back into the CommitEvent. A hostile git replacement could return
    // arbitrary text; this gate keeps the watcher's downstream consumers
    // honest about what they receive.
    if (!shaOut || !VALID_SHA.test(shaOut)) return null;

    const parentShas = parents.trim() === '' ? [] : parents.trim().split(' ');
    // Each parent must also pass SHA validation; strip any that don't so
    // downstream can trust the array contents.
    const validParentShas = parentShas.filter((p) => VALID_SHA.test(p));

    // Capture the full commit message body (subject + blank
    // line + body paragraphs) rather than just the subject (%s). We use a
    // separate `git log -1 --format=%B` call so that the tab-delimited
    // metadata parse above is not disturbed by any embedded newlines (or
    // rare tabs) in %B output.
    //
    // A commit with a very large body (auto-changelog, embedded patch) can
    // exceed execFileSync's default 1 MB buffer → ENOBUFS → previously the
    // outer catch would silently drop the whole commit observation. To avoid
    // that data loss we:
    //   1. Use an explicit 64 MB maxBuffer so normal large messages succeed.
    //   2. Wrap the body call in its own try/catch: if it still fails (e.g.
    //      a pathological >64 MB message), we emit the commit metadata with
    //      an empty message string and a structured warning rather than
    //      discarding the observation entirely.
    let message = '';
    try {
      message = execFileSync(
        'git',
        ['-C', workingDir, 'log', '-1', '--format=%B', sha],
        { ...GIT_EXEC_OPTS, maxBuffer: GIT_BODY_MAX_BUFFER },
      ).trimEnd();
    } catch (bodyErr) {
      console.warn(
        `[commit-watcher] could not read message body for ${sha}: ${String(bodyErr)}`,
      );
      // Fall through with message = '' — the commit metadata is still emitted.
    }

    return {
      sha: shaOut,
      parentShas: validParentShas,
      parentSha: validParentShas[0] ?? null,
      authoredAt,
      authorName: authorName || null,
      authorEmail: authorEmail || null,
      committedAt: committedAt || null,
      committerName: committerName || null,
      committerEmail: committerEmail || null,
      message,
    };
  } catch {
    return null;
  }
}

/**
 * Enumerate `(branch, sha)` for every local branch HEAD via
 * `git for-each-ref refs/heads/`. Used both at startup (to seed the
 * dedup set) and after every `.git/logs/HEAD` event (to discover which
 * branch moved). The branch name is the short ref form (e.g.
 * `feature/foo`), so nested branch names round-trip cleanly.
 */
function enumerateBranchHeads(
  workingDir: string,
): Array<{ branch: string; sha: string }> {
  try {
    // Use `-C workingDir` instead of `--git-dir join(workingDir,
    // '.git')` so this works in `git worktree add` checkouts where .git
    // is a FILE, not a directory.
    const out = execFileSync(
      'git',
      [
        '-C',
        workingDir,
        'for-each-ref',
        '--format=%(refname:short) %(objectname)',
        'refs/heads/',
      ],
      GIT_EXEC_OPTS,
    );
    // Success: clear any pending throttle state so a recovered repo goes
    // silent again (no stale last-warn timestamp for next failure).
    enumerateFailureLastWarnAt.delete(workingDir);
    const result: Array<{ branch: string; sha: string }> = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sep = trimmed.lastIndexOf(' ');
      if (sep < 0) continue;
      const branch = trimmed.slice(0, sep);
      const sha = trimmed.slice(sep + 1);
      if (!isValidBranchName(branch)) continue;
      if (!VALID_SHA.test(sha)) continue;
      result.push({ branch, sha });
    }
    return result;
  } catch (err) {
    // Distinguish a genuine git failure (execFileSync threw) from the
    // benign "no refs yet" case. If execFileSync throws, the git command
    // itself failed — this is a REAL error (corrupt repo, git missing, wrong
    // permissions, gitdir gone) that will persist silently forever unless
    // surfaced.  The clean-exit / empty-stdout case (no branches) does NOT
    // throw — it returns '' — so we only reach this catch on a real failure.
    //
    // Throttle: emit at most one warning per ENUMERATE_WARN_THROTTLE_MS per
    // working directory so a persistent outage surfaces once rather than
    // spamming the operator on every reflog event.
    const now = Date.now();
    const lastWarn = enumerateFailureLastWarnAt.get(workingDir) ?? 0;
    if (now - lastWarn >= ENUMERATE_WARN_THROTTLE_MS) {
      enumerateFailureLastWarnAt.set(workingDir, now);
      console.warn(
        `[commit-watcher] enumerateBranchHeads failed for ${workingDir}: ${String(err)}`,
      );
    }
    return [];
  }
}

function seedSeenWithCurrentHeads(workingDir: string, seen: Set<string>): void {
  for (const { sha } of enumerateBranchHeads(workingDir)) {
    seen.add(sha);
  }
}

/**
 * Resolve the current HEAD branch name (short form, e.g. `main`).
 * Returns `null` if HEAD is detached or git is unavailable.
 */
function resolveHeadBranch(workingDir: string): string | null {
  try {
    const name = execFileSync(
      'git',
      ['-C', workingDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      GIT_EXEC_OPTS,
    ).trim();
    // `HEAD` is the detached-head marker.
    if (!name || name === 'HEAD') return null;
    return isValidBranchName(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Read reflog lines appended since `lastOffset`, parse each
 * `<new-sha>` (the second whitespace-delimited token on a reflog line),
 * and return the new SHAs together with the updated offset.
 *
 * Reflog line format (git source):
 *   <old-sha> <new-sha> <committer-ident> <timestamp> <tz>\t<message>\n
 *
 * We only need the second token (new-sha).  Lines that don't look like
 * reflog entries (e.g. trailing newlines added by tests) are silently
 * skipped.
 *
 * Returns `{ shas, newOffset }`.  If the file has been truncated (e.g.
 * `git reflog expire`) `newOffset` is reset to 0 and the whole file is
 * re-read so the caller can rely on `seen` to avoid re-emitting old commits.
 */
function readNewReflogShas(
  reflogPath: string,
  lastOffset: number,
): { shas: string[]; newOffset: number } {
  let currentSize: number;
  try {
    currentSize = statSync(reflogPath).size;
  } catch {
    // File disappeared (race with git operations) — skip this event.
    return { shas: [], newOffset: lastOffset };
  }

  // Handle truncation / reflog expiry: reset to read the whole file.
  const readFrom = currentSize < lastOffset ? 0 : lastOffset;

  if (currentSize === readFrom) {
    // Nothing new.
    return { shas: [], newOffset: currentSize };
  }

  const chunkLen = currentSize - readFrom;
  const buf = Buffer.allocUnsafe(chunkLen);
  let fd: number;
  try {
    fd = openSync(reflogPath, 'r');
  } catch {
    return { shas: [], newOffset: lastOffset };
  }
  let totalRead = 0;
  try {
    while (totalRead < chunkLen) {
      const n = readSync(
        fd,
        buf,
        totalRead,
        chunkLen - totalRead,
        readFrom + totalRead,
      );
      if (n === 0) break;
      totalRead += n;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  const chunk = buf.toString('utf8', 0, totalRead);
  const shas: string[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // The second space-delimited token is the new-sha.
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace < 0) continue;
    const rest = trimmed.slice(firstSpace + 1);
    const secondSpace = rest.indexOf(' ');
    const newSha = secondSpace < 0 ? rest : rest.slice(0, secondSpace);
    if (VALID_SHA.test(newSha)) {
      shas.push(newSha);
    }
  }

  return { shas, newOffset: currentSize };
}

export async function startCommitWatcher(input: {
  workingDir: string;
  onCommit: (e: CommitEvent) => Promise<void>;
}): Promise<() => Promise<void>> {
  // `.git/logs/HEAD` is created by git the first time `core.logAllRefUpdates`
  // is honoured (i.e. on the first commit). For a brand-new repo with zero
  // commits we therefore can't watch it yet — but a brand-new repo also has
  // no commits to observe. If the file is missing we surface the same
  // structured error the old `refs/heads/` precondition raised so callers
  // (the SessionStart hook) can treat both shapes identically.
  //
  // Resolve the reflog path via `git rev-parse --git-path` rather
  // than naive string-joining. In a `git worktree add` checkout `.git` is a
  // FILE (not a directory) so `join(workingDir, '.git', 'logs', 'HEAD')` is
  // never a valid file path — it traverses through a file. `resolveReflogPath`
  // uses git plumbing to obtain the real location (e.g.
  // `.git/worktrees/<name>/logs/HEAD` inside the main repo) in a
  // worktree-safe way. It returns `null` when git is unavailable or the
  // directory is not a repo, which we surface as the same structured error.
  const logsHeadFileOrNull = resolveReflogPath(input.workingDir);
  if (!logsHeadFileOrNull || !existsSync(logsHeadFileOrNull)) {
    // Use the naive path only when git resolution failed (null); when
    // resolution succeeded but the file is missing, show the resolved path
    // so operators see the actual location checked.
    throw new Error(
      `No git reflog at ${logsHeadFileOrNull ?? `${input.workingDir}/.git/logs/HEAD`}`,
    );
  }
  // Narrowed non-null reference captured by the inner closure below.
  const logsHeadFile: string = logsHeadFileOrNull;

  const watchers: ReturnType<typeof watch>[] = [];
  const seen = new Set<string>();

  // Seed seen with all current branch HEADs so unrelated fs events
  // (fetch, gc, touch, chmod) don't re-emit existing commits.
  seedSeenWithCurrentHeads(input.workingDir, seen);

  // Initialize the byte offset to the current EOF of .git/logs/HEAD
  // so we capture only FUTURE appends (not historical entries already in
  // `seen` via seedSeenWithCurrentHeads). Any git operation that happens
  // after this point will append new lines; we read exactly those bytes.
  let lastOffset = statSync(logsHeadFile).size;

  // Concurrency guard: fs.watch can fire re-entrantly (e.g. Linux inotify
  // delivers both IN_MODIFY and IN_CLOSE_WRITE for a single append). Without
  // a guard, two overlapping callbacks could both read the same byte range
  // and double-advance lastOffset. The `processing` flag serialises them:
  // if a callback fires while one is already running, it sets `pending` so
  // the running callback re-processes after it finishes.
  let processing = false;
  let pending = false;

  async function processReflogChunk(): Promise<void> {
    if (processing) {
      pending = true;
      return;
    }
    processing = true;
    try {
      do {
        pending = false;
        // Read bytes since lastOffset, parse new-sha from each line.
        const { shas, newOffset } = readNewReflogShas(logsHeadFile, lastOffset);
        lastOffset = newOffset;

        if (shas.length === 0) continue;

        // Build a sha→branch map from all current branch tips so we can
        // assign the correct branch to exact tip commits. Intermediate
        // commits (e.g. mid-rebase SHAs) fall back to the current HEAD
        // branch.
        const branchHeads = enumerateBranchHeads(input.workingDir);
        const shaToB = new Map<string, string>(
          branchHeads.map(({ sha, branch }): [string, string] => [sha, branch]),
        );
        const headBranch = resolveHeadBranch(input.workingDir);

        for (const sha of shas) {
          if (seen.has(sha)) continue;
          seen.add(sha);
          const meta = readCommitMeta(input.workingDir, sha);
          if (!meta) continue;
          const branch = shaToB.get(sha) ?? headBranch ?? 'HEAD';
          input
            .onCommit({ ...meta, branch, workingDir: input.workingDir })
            .catch(() => {});
        }
      } while (pending);
    } finally {
      processing = false;
    }
  }

  // The `filename` arg from fs.watch on a single file isn't meaningful —
  // we use the byte-offset approach to read every new reflog line regardless
  // of how many lines landed between callbacks (burst commits, rebases,
  // cherry-picks). The `seen` set deduplicates; the offset ensures no line
  // is parsed twice.
  const watcher = watch(logsHeadFile, { persistent: true }, () => {
    processReflogChunk().catch(() => {});
  });
  watchers.push(watcher);

  return async function stop() {
    for (const w of watchers) w.close();
  };
}
