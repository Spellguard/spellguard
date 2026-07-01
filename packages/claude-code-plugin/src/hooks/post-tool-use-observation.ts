// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync } from 'node:child_process';
/**
 * PostToolUse hook — emits `commit` observations after `git commit` Bash calls.
 *
 * Claude Code's runtime calls this hook after each tool execution returns.
 * We filter for `git commit` commands, shell out to `git rev-parse HEAD` to
 * capture the SHA that was just created, and emit a scope-filtered observation
 * via the observation pipeline.
 *
 * In addition to git observation emission, every PostToolUse event is also
 * forwarded to `recordEditFromToolUse`, which persists `Edit` and `Write`
 * tool calls into a local SQLite edit store. The store is opened/closed per
 * call; WAL mode in edit-store.ts keeps that cheap and concurrency-safe.
 *
 * This is the symmetric counterpart of the PreToolUse hook: PreToolUse blocks
 * revoked credentials before a push; PostToolUse records what the agent just
 * committed so the control plane has a full audit trail.
 *
 * Commit-attribution emit (added 2026-05-20): in addition to the lightweight
 * `/v1/observations` POST, this hook also drives `emitCommitObservation` for
 * `git commit` Bash calls. The richer payload (file/line attribution via the
 * edit-store + git-show diff) writes through to the `commits` +
 * `commit_plugin_observations` tables — without this call the broker only
 * ever sees the lightweight observation event, `commits.plugin_observed`
 * stays false, and downstream attribution joins (commit_agent_attribution,
 * commit_deviations) are unreachable. The credential daemon ALSO drives
 * this via the fs-watch commit-watcher; both paths are idempotent (server
 * `ON CONFLICT DO UPDATE`), and the daemon path catches commits made
 * outside an active Claude Code session.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { consumeBashCommandStart } from '../lib/bash-command-timing';
import { captureBashEdits } from '../lib/bash-edit-capture';
import { emitCommitObservation } from '../lib/commit-observation-emitter';
import { openEditStore } from '../lib/edit-store';
import {
  detectGitOp,
  detectTreeMaterializingGitOp,
  isAmendCommit,
} from '../lib/git-command-parser';
import { canonicalizeGitRemote } from '../lib/git-remote-canonicalizer';
import { resolveGitRoot } from '../lib/git-root';
import { parseShowDiff } from '../lib/git-show-parser';
import { ObservationQueue } from '../lib/observation-emitter';
import {
  type ObserveResult,
  observeGitOperation,
} from '../lib/observation-pipeline';
import { type ToolInput, recordEditFromToolUse } from './post-tool-use-edit';

export interface PostToolUseInput {
  toolName: string;
  toolArgs: string[];
  cwd: string;
  remoteUrl?: string;
  agentId: string;
  scopedTokenId: string;
  clientSessionId: string;
  endpoint: string;
  agentSecret: string;
  queue?: ObservationQueue;
  /** Test seam: override the child_process.execSync call. */
  execImpl?: (cmd: string, opts?: { cwd?: string }) => string;
  /**
   * Structured tool input from Claude Code's PostToolUse event. Used to
   * persist Edit/Write tool calls into the local edit store. Optional so
   * pre-existing callers (e.g. test fixtures that only exercise the git
   * commit path) keep working without modification.
   */
  toolInput?: Record<string, unknown>;
  /**
   * Override the rootDir under which the edit store is opened. Defaults to
   * `~/.spellguard`. Test-injectable so unit tests can use a temp dir and
   * avoid polluting the developer's real `~/.spellguard/edits.db`.
   */
  editsRootDir?: string;
  /**
   * PostToolUse `duration_ms` for the Bash command, when Claude Code provides
   * it. FALLBACK source for the Bash-edit capture's command window — the primary
   * source is the PreToolUse-stamped command start (see `toolUseId`). `duration_ms`
   * is documented OPTIONAL, so the capture never depends on it alone.
   */
  durationMs?: number;
  /**
   * The tool-use id (shared by PreToolUse and PostToolUse for the same call).
   * Used to look up the PreToolUse-stamped command start time so the capture's
   * mtime window covers the command's real runtime. Falls back to the session
   * id when absent.
   */
  toolUseId?: string;
}

export type PostToolUseDecision =
  | { decision: 'allow'; observation?: ObserveResult | null }
  | { decision: 'skip' };

/**
 * Runtime PostToolUse entrypoint registered in `plugin.json`. Emits a `commit`
 * observation after a `git commit` Bash call completes successfully.
 */
export async function runPostToolUse(
  input: PostToolUseInput,
): Promise<PostToolUseDecision> {
  // Persist Edit/Write tool calls into the local edit store. We guard on
  // the tool name *before* opening the SQLite store so non-Edit/Write
  // tools (Read/Glob/Grep/Bash/etc.) don't pay the open cost. The store
  // opens with a 24h auto-prune (see edit-store.ts) so retention is
  // enforced at the natural call site.
  if (input.toolName === 'Edit' || input.toolName === 'Write') {
    const editStore = openEditStore({
      rootDir: input.editsRootDir ?? join(homedir(), '.spellguard'),
    });
    try {
      try {
        // Key edits by git toplevel so the SessionStart watcher's
        // emit-time queryByDir lookup aligns with what `git show` emits
        // (repo-root-relative paths). resolveGitRoot falls back to cwd
        // when not in a git repo, preserving existing non-repo behavior.
        const workingDir = resolveGitRoot(input.cwd);
        await recordEditFromToolUse({
          store: editStore,
          sessionContext: {
            sessionId: input.clientSessionId,
            agentId: input.agentId,
            workingDir,
          },
          toolName: input.toolName,
          toolInput: (input.toolInput ?? {}) as ToolInput,
        });
      } catch (err) {
        // Edit-store failures must not break the unrelated git-commit
        // observation path below. Log and continue.
        console.error('[post-tool-use] edit-store record failed:', err);
      }
    } finally {
      editStore.close();
    }
  }

  if (input.toolName !== 'Bash' && input.toolName !== 'bash') {
    return { decision: 'skip' };
  }

  const cmd = input.toolArgs.join(' ');
  const op = detectGitOp(cmd);
  const isCommit = op === 'commit';

  // Capture Bash-authored file changes into the edit store so diff-overlap can
  // attribute them (see captureBashEditsForCommand). Non-fatal — it never throws.
  await captureBashEditsForCommand(input, cmd, isCommit);

  if (!isCommit) return { decision: 'skip' };

  const exec =
    input.execImpl ??
    ((c: string, opts?: { cwd?: string }) =>
      execSync(c, { ...opts, encoding: 'utf8' })
        .toString()
        .trim());

  let sha: string;
  let branch: string;
  let message: string;
  try {
    sha = exec('git rev-parse HEAD', { cwd: input.cwd });
    branch = exec('git rev-parse --abbrev-ref HEAD', { cwd: input.cwd });
    message = exec('git log -1 --pretty=%B', { cwd: input.cwd });
  } catch {
    // If git commands fail (e.g., no commits yet, not a repo), skip silently.
    return { decision: 'skip' };
  }

  const remoteUrl =
    input.remoteUrl ??
    (() => {
      try {
        return exec('git config --get remote.origin.url', { cwd: input.cwd });
      } catch {
        return null;
      }
    })() ??
    null;
  if (!remoteUrl) return { decision: 'skip' };

  const canon = canonicalizeGitRemote(remoteUrl);
  if (!canon || canon.isSsh) return { decision: 'skip' };

  const queue = input.queue ?? new ObservationQueue({ capacity: 100 });
  const baseUrl = input.endpoint.replace(/\/v1\/observations\/?$/, '');

  const observation = await observeGitOperation(
    {
      operationType: 'commit',
      remoteUrl,
      agentId: input.agentId,
      scopedTokenId: input.scopedTokenId,
      clientSessionId: input.clientSessionId,
      branch,
      headSha: sha,
      commitMessage: message,
    },
    {
      spellguardBaseUrl: baseUrl,
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      queue,
    },
  );

  // Drive the commit-attribution emit (POST /v1/observations/commit) so
  // the commits + commit_plugin_observations tables actually get written.
  // The credential daemon's commit-watcher does this too, but (a) it
  // depends on the daemon being healthy AND in the right cwd, and (b)
  // in cloud-agent envs (Codespaces, Daytona, fresh containers) the
  // daemon may not start before the agent's first commit. Driving it
  // from the hook process guarantees the rich emit runs in-band with
  // the commit, while the daemon path remains as a backstop for
  // commits that happen outside an active Claude Code session.
  // Non-fatal — any failure is logged inside the emitter and skipped.
  try {
    const editStoreRoot = input.editsRootDir ?? join(homedir(), '.spellguard');
    const commitStore = openEditStore({ rootDir: editStoreRoot });
    try {
      const gitRoot = resolveGitRoot(input.cwd);
      await emitCommitObservation({
        store: commitStore,
        diffProvider: async (s: string) => {
          try {
            const out = execFileSync('git', ['show', s], {
              cwd: gitRoot,
              encoding: 'utf8',
              maxBuffer: 64 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'ignore'],
            });
            return parseShowDiff(out);
          } catch {
            return {};
          }
        },
        fetch,
        apiBase: baseUrl,
        agentId: input.agentId,
        agentSecret: input.agentSecret,
        workingDir: gitRoot,
        remoteUrl,
        commitEvent: {
          sha,
          branch,
          // Pull authored/committed-at + author/committer identity from git
          // so the row carries the same metadata as the daemon-watcher path
          // would. `git log -1 --pretty=...%n` produces fields separated by
          // a fixed delimiter that's unlikely to appear in any of them.
          authoredAt: tryGitField(exec, input.cwd, '%aI'),
          authorName: tryGitFieldOptional(exec, input.cwd, '%an'),
          authorEmail: tryGitFieldOptional(exec, input.cwd, '%ae'),
          committedAt: tryGitFieldOptional(exec, input.cwd, '%cI'),
          committerName: tryGitFieldOptional(exec, input.cwd, '%cn'),
          committerEmail: tryGitFieldOptional(exec, input.cwd, '%ce'),
          message,
          parentSha:
            tryGitFieldOptional(exec, input.cwd, '%P')?.split(' ')[0] ?? null,
          parentShas:
            tryGitFieldOptional(exec, input.cwd, '%P')
              ?.split(' ')
              .filter((s) => s.length > 0) ?? [],
          workingDir: gitRoot,
        },
        sessionContext: {
          sessionId: input.clientSessionId,
          agentId: input.agentId,
        },
      });
    } finally {
      commitStore.close();
    }
  } catch (err) {
    // Surface to stderr — Claude Code captures hook stderr in the
    // session transcript so operator can see emit failures while still
    // letting the tool execution proceed.
    process.stderr.write(
      `[post-tool-use] emitCommitObservation failed: ${(err as Error)?.message ?? err}\n`,
    );
  }

  return { decision: 'allow', observation };
}

function tryGitField(
  exec: (cmd: string, opts?: { cwd?: string }) => string,
  cwd: string,
  fmt: string,
): string {
  try {
    return exec(`git log -1 --pretty=tformat:${fmt}`, { cwd }).trim();
  } catch {
    return '';
  }
}

function tryGitFieldOptional(
  exec: (cmd: string, opts?: { cwd?: string }) => string,
  cwd: string,
  fmt: string,
): string | null {
  const v = tryGitField(exec, cwd, fmt);
  return v.length === 0 ? null : v;
}

/**
 * Capture Bash-authored file changes into the edit store so diff-overlap can
 * attribute them. Without this, anything the agent writes via Bash (heredocs,
 * code generators, sed, formatters) is invisible to attribution and the commit
 * surfaces as 0% / human. Runs for EVERY Bash call (not just commits) so the
 * writing command captures the change while the file is still dirty; the commit
 * command's `isCommit` pass additionally covers the write-and-commit-in-one
 * case. Always consumes the PreToolUse-stamped command start to clean up the
 * sidecar, even when the command is a tree-materializing git op (skipped).
 */
async function captureBashEditsForCommand(
  input: PostToolUseInput,
  cmd: string,
  isCommit: boolean,
): Promise<void> {
  const editsRoot = input.editsRootDir ?? join(homedir(), '.spellguard');
  const commandStartedAtMs =
    consumeBashCommandStart({
      rootDir: editsRoot,
      key: input.toolUseId || input.clientSessionId,
      nowMs: Date.now(),
    }) ?? undefined;
  // Tree-materializing git ops (merge/rebase/pull/stash pop/checkout/...) bring
  // in FOREIGN content with a fresh mtime — never attribute those to the agent.
  if (detectTreeMaterializingGitOp(cmd)) return;
  // Merge and amend commits have an ambiguous baseline (combined diff /
  // multi-parent / pre-amend span) — skip the committed-set synthesis for them;
  // the writing command's dirty-set pass already captured real edits.
  const skipCommittedSet =
    isCommit && (isAmendCommit(cmd) || headHasMultipleParents(input.cwd));
  await captureBashEdits({
    editsRootDir: editsRoot,
    gitRoot: resolveGitRoot(input.cwd),
    sessionId: input.clientSessionId,
    agentId: input.agentId,
    isCommit,
    commandStartedAtMs,
    durationMs: input.durationMs,
    skipCommittedSet,
  });
}

/**
 * True if HEAD is a merge commit (has a 2nd parent). `git rev-parse --verify
 * --quiet HEAD^2` exits 0 when a 2nd parent exists and non-zero otherwise
 * (execFileSync throws). Best-effort: any failure → treat as non-merge.
 */
function headHasMultipleParents(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^2'], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export default runPostToolUse;
