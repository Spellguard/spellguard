// SPDX-License-Identifier: Apache-2.0

// Commit observation emitter — integrates the diff-overlap attribution
// algorithm, the local edit store, and the commit watcher into a single
// POST to the Spellguard control plane.
//
// Path normalization: the edit store records
// `filePath` workingDir-relative, while the diff provider returns paths
// from git that may carry leading `./` or non-canonical separators. Both
// sides of `computeAttribution`'s input are normalized via posix.normalize
// (after stripping leading `./`) so the line-set lookup keys align.
//
// CRLF/LF normalization: edits written on Windows
// hosts may contain `\r\n` line endings; the diff provider's `addedLines`
// are split on `\n` and never contain `\r`. We strip `\r` from
// `contentAfter` before feeding `computeAttribution`.

import { posix } from 'node:path';
import { createManagementClient } from '@spellguard/agent-control';
import type { paths } from '@spellguard/management-api-types';
import type { CommitEvent } from '../monitors/commit-watcher';
import { type CommitDiffFile, computeAttribution } from './diff-overlap';
import type { openEditStore } from './edit-store';
import { canonicalizeGitRemote } from './git-remote-canonicalizer';

// The typed request body for POST /v1/observations/commit, sourced from the
// generated contract so this emitter's wire shape stays pinned to the route's
// Zod schema (`CommitObservationBody`).
type CommitObservationRequestBody = NonNullable<
  paths['/observations/commit']['post']['requestBody']
>['content']['application/json'];

function normalizePath(p: string): string {
  // posix.normalize collapses redundant `./` and double-slashes; we then
  // strip a leading `./` (posix.normalize keeps a single one) so plain
  // relative paths and `./`-prefixed paths share a key.
  return posix.normalize(p).replace(/^\.\//, '');
}

export async function emitCommitObservation(input: {
  store: ReturnType<typeof openEditStore>;
  diffProvider: (sha: string) => Promise<Record<string, CommitDiffFile>>;
  fetch: typeof fetch;
  apiBase: string;
  agentId: string;
  agentSecret: string;
  workingDir: string;
  remoteUrl: string;
  commitEvent: CommitEvent;
  sessionContext: { sessionId: string; agentId: string };
}): Promise<void> {
  // Org scope is derived server-side from the authenticated agent
  // (agent-id + agent-secret); we intentionally do NOT carry an
  // org_id field in the payload.
  // C1 fix: use the canonicalizer (URL-based, host-anchored, alias-checked)
  // instead of the previous substring regex. This rejects evilgithub.com,
  // honors uppercase GITHUB.com, and strips query/credentials cleanly.
  const canon = canonicalizeGitRemote(input.remoteUrl);
  if (!canon) return; // non-GitHub or unparseable — skip silently
  const repoFullName = `${canon.owner}/${canon.repo}`;

  // C2 fix: wrap the diff provider — transient git failures should not
  // propagate to the watcher (which swallows them with .catch(() => {})).
  let rawCommitDiff: Record<string, CommitDiffFile>;
  try {
    rawCommitDiff = await input.diffProvider(input.commitEvent.sha);
  } catch (err) {
    console.error(
      '[commit-observation-emitter] diffProvider failed:',
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err,
    );
    return;
  }
  const commitDiffByFile: Record<string, CommitDiffFile> = {};
  for (const [k, v] of Object.entries(rawCommitDiff)) {
    commitDiffByFile[normalizePath(k)] = v;
  }

  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // C2 fix: wrap the edit-store query for the same reason as diffProvider.
  let edits: Awaited<ReturnType<typeof input.store.queryByDir>>;
  try {
    edits = await input.store.queryByDir({
      workingDir: input.workingDir,
      sinceIso,
    });
  } catch (err) {
    console.error(
      '[commit-observation-emitter] store.queryByDir failed:',
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err,
    );
    return;
  }
  const agentEditsByFile: Record<
    string,
    { contentBefore: string; contentAfter: string; timestamp: string }[]
  > = {};
  for (const e of edits) {
    const key = normalizePath(e.filePath);
    agentEditsByFile[key] ??= [];
    agentEditsByFile[key].push({
      // Carry contentBefore through to computeAttribution so it
      // can derive "lines this edit actually added" (and not over-attribute
      // boilerplate the agent merely preserved).
      contentBefore: e.contentBefore.replace(/\r\n/g, '\n'),
      contentAfter: e.contentAfter.replace(/\r\n/g, '\n'),
      timestamp: e.timestamp,
    });
  }

  const attribution = computeAttribution({
    commitDiffByFile,
    agentEditsByFile,
  });

  // The emitter must NOT short-circuit on overallPercentage===0, which would
  // drop the "developer reviewed the agent's work and hand-committed locally"
  // case — exactly the audience this feature exists to serve. The commit must
  // still arrive so commits.plugin_observed
  // flips true (and the author/committer metadata lands) even when no agent
  // attribution attaches. We omit agent_id + agent_attribution from the
  // payload when overall is 0% so the server skips the attribution upsert
  // entirely instead of writing a misleading 0% row.
  const hasAgentAttribution = attribution.overallPercentage > 0;
  const payload: Record<string, unknown> = {
    kind: 'commit_observation',
    commit_sha: input.commitEvent.sha,
    repo_full_name: repoFullName,
    branch: input.commitEvent.branch,
    parent_sha: input.commitEvent.parentSha,
    // `parentShas` carries every parent for merge commits, alongside
    // `parent_sha`, so the server endpoint can record all parents.
    parent_shas: input.commitEvent.parentShas,
    authored_at: input.commitEvent.authoredAt,
    // Author/committer metadata flows through the plugin path so
    // the activity feed can render meaningful "by <name>" text on commits
    // that never get audit-log expansion (e.g. SSH push from a non-Enterprise
    // org). Read from the local git via readCommitMeta in commit-watcher.
    author_name: input.commitEvent.authorName,
    author_email: input.commitEvent.authorEmail,
    committed_at: input.commitEvent.committedAt,
    committer_name: input.commitEvent.committerName,
    committer_email: input.commitEvent.committerEmail,
    message: input.commitEvent.message,
    session_id: input.sessionContext.sessionId,
  };
  if (hasAgentAttribution) {
    payload.agent_id = input.sessionContext.agentId;
    payload.agent_attribution = {
      overall_percentage: attribution.overallPercentage,
      agent_attributed_lines: attribution.agentAttributedLines,
      total_changed_lines: attribution.totalChangedLines,
      // Server schema is z.array(PerFileAttributionEntry) keyed on
      // `path`. The diff-overlap algorithm returns Record<path, ...> for
      // O(1) lookup; convert here at the wire boundary.
      per_file: Object.entries(attribution.perFile).map(([path, v]) => ({
        path,
        agentLines: v.attributedLines,
        totalLines: v.totalLines,
        percentage: v.percentage,
      })),
    };
  }

  // C2 fix: previously this was a bare `await input.fetch(...)`. A non-2xx
  // response succeeded silently (no res.ok check) and any network error
  // bubbled up into the commit watcher's `.catch(() => {})`, so every
  // failure mode resulted in silent data loss. Now: try/catch, status
  // check, structured log without leaking the bearer token. (A retry
  // queue for lost observations is a possible future enhancement.)
  // `input.apiBase` is the origin (no `/v1`); the typed client appends `/v1`
  // and the `/observations/commit` path, matching the legacy URL exactly.
  const api = createManagementClient({
    baseUrl: input.apiBase,
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    fetchImpl: input.fetch,
  });
  try {
    // `payload` is assembled as a Record (conditional agent_* fields), so cast
    // to the typed request body at the wire boundary. The fields written above
    // match `CommitObservationRequestBody` exactly.
    const { error, response } = await api.POST('/observations/commit', {
      body: payload as CommitObservationRequestBody,
    });
    if (error) {
      console.error('[commit-observation-emitter] POST failed:', {
        status: response.status,
        sha: input.commitEvent.sha,
        repo_full_name: repoFullName,
      });
      return;
    }
  } catch (err) {
    console.error(
      '[commit-observation-emitter] POST failed:',
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err,
    );
    return;
  }
}
