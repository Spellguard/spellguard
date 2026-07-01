// SPDX-License-Identifier: Apache-2.0

// Bash-authored edit capture.
//
// WHY THIS EXISTS: a real coding agent authors files in many ways that never
// go through the Edit/Write tools — heredocs (`cat > f <<EOF`), code
// generators, `sed -i`, formatters, `git apply`, `npm`/`pnpm` scaffolding.
// `recordEditFromToolUse` only captures Edit/Write tool calls, so before this
// module those lines had NO agent-edit record. At commit time, diff-overlap
// found no matching agent-added lines, attribution came out 0%, the emitter
// omitted it, and the agent's real work surfaced on the dashboard as
// "0% / human". That was the primary cause of the "all 0%" symptom for new
// agent work.
//
// WHAT IT DOES: invoked from the PostToolUse(Bash) hook for EVERY Bash tool
// call (except tree-materializing git ops — see the caller), it reconciles the
// git working tree against the edit-store "ledger" and records the file changes
// THIS command produced as agent edits — so they feed diff-overlap exactly like
// an Edit/Write would.
//
// ACCURACY (not just presence) — we must neither under-attribute the agent nor
// credit it for content a human/upstream produced. Guards:
//   1. Command window: only files whose on-disk mtime falls inside this Bash
//      command's window are "written by this command". The window starts at the
//      command's REAL start time, captured by the PreToolUse hook and passed in
//      as `commandStartedAtMs` (Claude Code's `duration_ms` is documented
//      OPTIONAL, so we do not rely on it — it is only a fallback). This makes
//      the window cover the whole command even for slow multi-second
//      generators, while still excluding pre-existing dirty files and files a
//      human edited between tool calls (older mtimes).
//   2. Tree-materializing git ops (merge / rebase / cherry-pick / revert /
//      pull / reset / restore / checkout/switch of existing refs / stash
//      pop/apply) are skipped ENTIRELY by the caller — their files carry a
//      fresh mtime but the content came from git objects / a stash / upstream,
//      not from the agent typing.
//   3. contentBefore = the agent-edit ledger's latest content for the file,
//      else the file's content at the baseline ref (HEAD, or HEAD^ for a file
//      committed by this very command), else ''. So a MODIFICATION only
//      attributes the lines added on top of that baseline — never the whole
//      file. Merge/amend commits skip the committed-set pass (ambiguous
//      baseline) — see `skipCommittedSet`.
//   4. Symlinks are never followed and every candidate is realpath-checked to
//      be INSIDE the repo root (so neither a final-component nor an
//      intermediate-directory symlink can read a host file outside gitRoot);
//      binary / oversized / unmerged-conflict / secret-bearing files are
//      excluded; pure deletions carry no added lines.
//
// Known characteristics (documented, defensible): content the agent CAUSED via
// a tool it ran in-session — generated code, a formatter's rewrite, an
// `npm install` lockfile — is attributed to the agent (the agent's action
// produced it). Foreign content pulled in by a git materialize op is not (guard
// 2). A human editing the SAME file the agent later also edits, with no commit
// in between, can have their pre-existing uncommitted lines credited to the
// agent (no per-session baseline); this needs local co-editing and does not
// occur in the managed-agent (fresh sandbox) flow. A local `git merge --squash`
// of a colleague's branch in ONE Bash call is fully excluded (materialize op
// skipped); only the rare case of running the squash and a SEPARATE `git commit`
// as two back-to-back calls within ~1.7s can still admit the foreign files —
// not the managed-agent flow, where squash-merge happens server-side.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { type EditRecord, openEditStore } from './edit-store';

type Store = ReturnType<typeof openEditStore>;

// Slack added to the command window to cover hook-spawn latency between the
// command finishing and this hook process reading mtimes, plus coarse
// filesystem mtime granularity (some filesystems round to 1–2s).
const WINDOW_SLACK_MS = 3_000;
// Tighter slack for the COMMITTED-set pass (single-command write+commit). Those
// files were written DURING the commit command, so their mtime is ≥ the command
// start; we only need a small granularity cushion. Keeping this tight excludes
// files a PRIOR tree-materializing command (e.g. `git merge --squash`) left in
// the tree before a separate `git commit` — those would otherwise be synthesized
// as 100% agent-authored. See the module header guard 2.
const COMMITTED_WINDOW_SLACK_MS = 1_500;
// Fallback window when NEITHER a PreToolUse start time NOR duration_ms is
// available (should be rare — PreToolUse stamps the start time). Generous so we
// don't silently drop the agent's work; the ledger/baseline diff still prevents
// crediting unchanged content.
const DEFAULT_WINDOW_MS = 15_000;
// Skip files larger than this — bounds per-call cost and avoids storing huge
// generated blobs. A source file over 2 MB is pathological.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Hard cap on candidate files reconciled in a single Bash call. A command that
// touches more files than this is almost certainly a bulk/generated operation;
// we process the first N and log the truncation (never silently).
const MAX_CANDIDATES = 500;
// Bytes sniffed for a NUL to classify a file as binary.
const BINARY_SNIFF_BYTES = 8_000;

// Secret-bearing files we refuse to read into the (plaintext, at-rest) edit
// store, matched on basename. `.gitignore` already keeps most of these out of
// `git status`, but a not-yet-ignored `.env`/key written by a subprocess could
// slip through; this is the backstop. Matched against the file's basename.
const SECRET_FILE_RES: RegExp[] = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
];

export interface BashEditCaptureDeps {
  /** Runs `git <args>` in the repo root; returns stdout or null on failure. */
  gitExec?: (args: string[]) => string | null;
  /** Reads a file as raw bytes; returns null if it can't be read. */
  readFileBytes?: (absPath: string) => Buffer | null;
  /** Returns a file's mtime in ms since epoch, or null if it doesn't exist. */
  statMtimeMs?: (absPath: string) => number | null;
  /** True if the path is a symlink (capture refuses to follow symlinks). */
  isSymlink?: (absPath: string) => boolean;
  /** Resolves a path to its canonical (symlink-free) form, or null on failure. */
  realPath?: (p: string) => string | null;
  /** Opens the edit store (lazily — only when there is something to record). */
  openStore?: () => Store;
  /** Current time in ms; injectable for deterministic tests. */
  nowMs?: number;
}

export interface BashEditCaptureInput {
  /** Root dir under which the edit store lives (e.g. `~/.spellguard`). */
  editsRootDir: string;
  /** Repository root (resolveGitRoot of the hook cwd). */
  gitRoot: string;
  sessionId: string;
  agentId: string;
  /** True when the Bash command that just ran created a commit. */
  isCommit: boolean;
  /**
   * Real start time of the Bash command (ms), captured by the PreToolUse hook.
   * Primary source for the command window — robust to `duration_ms` being
   * absent. When set, the window is [commandStartedAtMs - slack, now].
   */
  commandStartedAtMs?: number;
  /** PostToolUse `duration_ms` for the command — fallback window source only. */
  durationMs?: number;
  /**
   * Skip the committed-file candidate set (the `isCommit` HEAD diff). Set for
   * MERGE commits (combined diff / multi-parent baseline is ambiguous and the
   * downstream parser can't read it) and AMEND commits (HEAD^ spans the
   * pre-amend commit). The dirty-set pass on the writing command already
   * captured genuine agent edits; only the commit-time synthesis is skipped.
   */
  skipCommittedSet?: boolean;
  deps?: BashEditCaptureDeps;
}

export interface BashEditCaptureResult {
  recorded: number;
  truncated: boolean;
}

function defaultGitExec(gitRoot: string) {
  return (args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd: gitRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
}

function defaultReadFileBytes(absPath: string): Buffer | null {
  try {
    return readFileSync(absPath);
  } catch {
    return null;
  }
}

function defaultStatMtimeMs(absPath: string): number | null {
  try {
    return statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
}

function defaultIsSymlink(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function defaultRealPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** True if `child` is `parent` itself or strictly contained under it. */
function isWithin(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function normalizeKey(p: string): string {
  return posix.normalize(p).replace(/^\.\//, '');
}

function isSecretPath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return SECRET_FILE_RES.some((re) => re.test(base));
}

/**
 * Parse `git status --porcelain=v1 -z --no-renames` output into the set of
 * paths with working-tree content worth reconciling (modified, added,
 * untracked). Skipped: pure deletions (no content to attribute) and UNMERGED
 * conflict states (`U` in either column, plus `AA`/`DD`) — a conflict's content
 * comes from the merge, not from the agent typing this command.
 */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // Rename/copy: consume the trailing "from" path token. (With --no-renames
    // git emits D+A instead, so this is belt-and-suspenders.)
    if (
      code[0] === 'R' ||
      code[0] === 'C' ||
      code[1] === 'R' ||
      code[1] === 'C'
    ) {
      i++;
    }
    // Pure deletions: nothing to attribute.
    if (code === 'D ' || code === ' D') continue;
    // Unmerged / conflicted: content is from the merge, not the agent.
    if (code[0] === 'U' || code[1] === 'U' || code === 'AA' || code === 'DD')
      continue;
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * Candidate files to reconcile, split into two sets with DIFFERENT command
 * windows:
 *   - `dirty`: working-tree changes (`git status`). Windowed loosely (slack for
 *     hook latency + mtime granularity).
 *   - `committed`: files in the just-made commit (when `includeCommittedSet`).
 *     Catches the write-and-commit-in-one-command case. Windowed TIGHTLY (≥
 *     command start) so a file a PRIOR materialize op left in the tree before a
 *     separate `git commit` is NOT synthesized as agent-authored.
 */
function collectCandidatePaths(
  gitExec: (args: string[]) => string | null,
  includeCommittedSet: boolean,
): { dirty: string[]; committed: string[] } {
  const dirty = new Set<string>();
  // `--untracked-files=all` is REQUIRED: the default (`normal`) collapses a
  // fully-untracked directory to just `dir/`, so a brand-new file the agent
  // wrote (e.g. `src/math.js` in a new `src/`) would never appear as an
  // individual path and would be silently un-attributed. `-uall` lists each
  // untracked file. (`--no-renames` keeps parsing simple — renames are
  // reconciled as their new path anyway.)
  const status = gitExec([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  if (status) for (const p of parsePorcelainZ(status)) dirty.add(p);

  const committed = new Set<string>();
  if (includeCommittedSet) {
    const out = gitExec([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      '--root',
      'HEAD',
    ]);
    if (out)
      for (const p of out.split('\0')) if (p && !dirty.has(p)) committed.add(p);
  }
  return { dirty: [...dirty], committed: [...committed] };
}

/**
 * Start of the command window, in ms. See guard 1 in the module header. `slack`
 * is the cushion subtracted from the start (loose for dirty files, tight for
 * committed files).
 */
function computeWindowStart(input: {
  commandStartedAtMs?: number;
  durationMs?: number;
  nowMs: number;
  slack: number;
}): number {
  if (
    input.commandStartedAtMs != null &&
    Number.isFinite(input.commandStartedAtMs)
  ) {
    return input.commandStartedAtMs - input.slack;
  }
  if (input.durationMs != null && input.durationMs >= 0) {
    return input.nowMs - input.durationMs - input.slack;
  }
  return input.nowMs - DEFAULT_WINDOW_MS;
}

interface SelectDeps {
  statMtimeMs: (absPath: string) => number | null;
  isSymlink: (absPath: string) => boolean;
  realPath: (p: string) => string | null;
}

/**
 * Keep only files this command actually authored: in-window mtime, not a
 * symlink, resolving (via realpath) to a path INSIDE the repo — so an
 * intermediate symlinked directory can't read a host file outside gitRoot — and
 * not a secret-bearing file. Runs BEFORE the store is opened so a no-op Bash
 * call (ls/grep/cd) never pays the SQLite open cost.
 */
function selectFreshPaths(
  paths: string[],
  gitRoot: string,
  realGitRoot: string | null,
  deps: SelectDeps,
  windowStartMs: number,
): string[] {
  const fresh: string[] = [];
  for (const path of paths) {
    if (isSecretPath(path)) continue; // never store secrets at rest
    const abs = join(gitRoot, path);
    if (deps.isSymlink(abs)) continue; // never follow a final-component symlink
    // Realpath containment: reject anything resolving outside the repo root
    // (covers an intermediate symlinked directory pointing at the host FS).
    const real = deps.realPath(abs);
    if (real === null) continue;
    if (realGitRoot !== null && !isWithin(real, realGitRoot)) continue;
    const mtime = deps.statMtimeMs(abs);
    if (mtime === null) continue; // deleted / missing
    if (mtime < windowStartMs) continue; // not written by this command
    fresh.push(path);
  }
  return fresh;
}

/** Read the file's content if it is a reconcilable text file, else null. */
function readReconcilableText(
  readFileBytes: (absPath: string) => Buffer | null,
  abs: string,
): string | null {
  const buf = readFileBytes(abs);
  if (!buf) return null;
  if (buf.length > MAX_FILE_BYTES) return null;
  if (isBinary(buf)) return null;
  return buf.toString('utf8');
}

/** Build a map of normalized path → latest agent-recorded content for the repo. */
async function buildLedgerMap(
  store: Store,
  gitRoot: string,
  nowMs: number,
): Promise<Map<string, string>> {
  const sinceIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  let ledger: EditRecord[] = [];
  try {
    ledger = await store.queryByDir({ workingDir: gitRoot, sinceIso });
  } catch {
    ledger = [];
  }
  // queryByDir returns rows oldest-first, so the last write wins = latest.
  const latestByPath = new Map<string, string>();
  for (const e of ledger)
    latestByPath.set(normalizeKey(e.filePath), e.contentAfter);
  return latestByPath;
}

/**
 * Record the fresh files' agent-authored content into the store. Returns the
 * number of edits written. `contentBefore` is the agent-edit ledger's latest
 * content for the file, else the file's content at `baseRef`, else '' — so a
 * modification only attributes the lines added on top of that baseline.
 */
async function recordFreshEdits(args: {
  store: Store;
  freshPaths: string[];
  input: BashEditCaptureInput;
  gitExec: (a: string[]) => string | null;
  readFileBytes: (absPath: string) => Buffer | null;
  nowMs: number;
}): Promise<number> {
  const { store, freshPaths, input, gitExec, readFileBytes, nowMs } = args;
  const latestByPath = await buildLedgerMap(store, input.gitRoot, nowMs);
  // Baseline ref for the "no prior agent record" fallback. When this command
  // just CREATED a (non-merge, non-amend) commit, the file's HEAD content IS
  // the working-tree content (`git show HEAD:f` == disk), so HEAD is the wrong
  // baseline — the agent's added lines are relative to the commit's PARENT. Use
  // HEAD^ in that case (it fails to '' for a root commit). For an uncommitted
  // change HEAD is the committed baseline and is correct.
  const baseRef = input.isCommit && !input.skipCommittedSet ? 'HEAD^' : 'HEAD';

  let recorded = 0;
  for (const path of freshPaths) {
    const contentAfter = readReconcilableText(
      readFileBytes,
      join(input.gitRoot, path),
    );
    if (contentAfter === null) continue;

    const key = normalizeKey(path);
    const contentBefore =
      latestByPath.get(key) ?? gitExec(['show', `${baseRef}:${path}`]) ?? '';
    if (contentAfter === contentBefore) continue;

    await store.record({
      workingDir: input.gitRoot,
      filePath: path,
      contentBefore,
      contentAfter,
      sessionId: input.sessionId,
      agentId: input.agentId,
      timestamp: new Date(nowMs).toISOString(),
    });
    // Update the in-memory ledger so a later candidate in the same call diffs
    // against this freshly recorded state.
    latestByPath.set(key, contentAfter);
    recorded++;
  }
  return recorded;
}

/**
 * Reconcile the git working tree against the agent-edit ledger and record the
 * file changes this Bash command produced. Never throws — all failure modes log
 * to stderr and return what was recorded so far. See the module header for the
 * accuracy model.
 */
export async function captureBashEdits(
  input: BashEditCaptureInput,
): Promise<BashEditCaptureResult> {
  const deps = input.deps ?? {};
  const gitExec = deps.gitExec ?? defaultGitExec(input.gitRoot);
  const readFileBytes = deps.readFileBytes ?? defaultReadFileBytes;
  const selectDeps: SelectDeps = {
    statMtimeMs: deps.statMtimeMs ?? defaultStatMtimeMs,
    isSymlink: deps.isSymlink ?? defaultIsSymlink,
    realPath: deps.realPath ?? defaultRealPath,
  };
  const nowMs = deps.nowMs ?? Date.now();
  const openStore =
    deps.openStore ?? (() => openEditStore({ rootDir: input.editsRootDir }));

  try {
    // The committed-set synthesis (single-command write+commit) requires a REAL
    // command start time to window tightly. Without one we would fall back to
    // the 15s default, which re-admits foreign files a prior `git merge
    // --squash` left in the tree before this commit. So when there's no real
    // timing, skip the committed set entirely — the dirty-set pass on the
    // writing command already captured genuine agent edits.
    const hasRealTiming =
      (input.commandStartedAtMs != null &&
        Number.isFinite(input.commandStartedAtMs)) ||
      (input.durationMs != null && input.durationMs >= 0);
    const includeCommittedSet =
      input.isCommit && !input.skipCommittedSet && hasRealTiming;
    const { dirty, committed } = collectCandidatePaths(
      gitExec,
      includeCommittedSet,
    );
    if (dirty.length === 0 && committed.length === 0)
      return { recorded: 0, truncated: false };

    const realGitRoot = selectDeps.realPath(input.gitRoot);
    // Dirty files: loose window (slack covers hook latency + mtime granularity).
    const dirtyWindowStart = computeWindowStart({
      commandStartedAtMs: input.commandStartedAtMs,
      durationMs: input.durationMs,
      nowMs,
      slack: WINDOW_SLACK_MS,
    });
    // Committed files: tight window (≥ command start) so a prior materialize op's
    // leftovers aren't synthesized as agent-authored at commit time.
    const committedWindowStart = computeWindowStart({
      commandStartedAtMs: input.commandStartedAtMs,
      durationMs: input.durationMs,
      nowMs,
      slack: COMMITTED_WINDOW_SLACK_MS,
    });

    const freshSet = new Set<string>([
      ...selectFreshPaths(
        dirty,
        input.gitRoot,
        realGitRoot,
        selectDeps,
        dirtyWindowStart,
      ),
      ...selectFreshPaths(
        committed,
        input.gitRoot,
        realGitRoot,
        selectDeps,
        committedWindowStart,
      ),
    ]);
    let freshPaths = [...freshSet];
    if (freshPaths.length === 0) return { recorded: 0, truncated: false };

    let truncated = false;
    if (freshPaths.length > MAX_CANDIDATES) {
      truncated = true;
      process.stderr.write(
        `[bash-edit-capture] ${freshPaths.length} changed files exceed the ${MAX_CANDIDATES} per-command cap; attributing the first ${MAX_CANDIDATES} only.\n`,
      );
      freshPaths = freshPaths.slice(0, MAX_CANDIDATES);
    }

    const store = openStore();
    try {
      const recorded = await recordFreshEdits({
        store,
        freshPaths,
        input,
        gitExec,
        readFileBytes,
        nowMs,
      });
      return { recorded, truncated };
    } finally {
      store.close();
    }
  } catch (err) {
    process.stderr.write(
      `[bash-edit-capture] reconcile failed: ${(err as Error)?.message ?? err}\n`,
    );
    return { recorded: 0, truncated: false };
  }
}
