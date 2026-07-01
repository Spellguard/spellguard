// SPDX-License-Identifier: Apache-2.0

import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeGitRemote } from './git-remote-canonicalizer';
import {
  type ObservationEvent,
  type ObservationQueue,
  type OperationType,
  buildObservationEvent,
  emitOrQueue,
} from './observation-emitter';
import { isInEffectiveScope, loadUserAllowlist } from './observation-scope';
import { readScopeCache } from './scope-cache';

export interface ObserveInput {
  operationType: OperationType;
  remoteUrl: string; // raw URL from git remote -v OR git push <url> override
  branch?: string;
  headSha?: string;
  prNumber?: number;
  commitsCount?: number;
  /** Commit message for `commit` observations (PostToolUse hook). */
  commitMessage?: string;
  agentId: string;
  scopedTokenId: string;
  clientSessionId: string;
}

export interface ObservePipelineDeps {
  spellguardBaseUrl: string;
  agentId: string;
  agentSecret: string;
  fetchImpl?: typeof fetch;
  scopeCachePath?: string;
  allowlistPath?: string;
  queue: ObservationQueue;
}

function defaultScopeCachePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(
    xdg ?? join(homedir(), '.config'),
    'spellguard',
    'observation-scope.json',
  );
}

function defaultAllowlistPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(
    xdg ?? join(homedir(), '.config'),
    'spellguard',
    'observation.yaml',
  );
}

export interface ObserveResult {
  emitted: boolean;
  reason?:
    | 'out_of_scope'
    | 'invalid_remote'
    | 'stale_cache'
    | 'delivered'
    | 'queued';
  event?: ObservationEvent;
}

export async function observeGitOperation(
  input: ObserveInput,
  deps: ObservePipelineDeps,
): Promise<ObserveResult> {
  const canon = canonicalizeGitRemote(input.remoteUrl);
  if (!canon) return { emitted: false, reason: 'invalid_remote' };
  // SSH-remote git ops shouldn't reach here (SessionStart fails first), but
  // be defensive: SSH bypasses the helper, so we treat it as out-of-scope.
  if (canon.isSsh) return { emitted: false, reason: 'invalid_remote' };

  const cache = readScopeCache(deps.scopeCachePath ?? defaultScopeCachePath());
  if (!cache) return { emitted: false, reason: 'stale_cache' };
  const allowlist = loadUserAllowlist(
    deps.allowlistPath ?? defaultAllowlistPath(),
  ).allowlist;

  const inScope = isInEffectiveScope(
    { owner: canon.owner, repo: canon.repo },
    {
      serverScope: cache.serverScope,
      userAllowlist: allowlist,
      cacheRefreshedAt: cache.refreshedAt,
    },
  );
  if (!inScope) return { emitted: false, reason: 'out_of_scope' };

  const event = buildObservationEvent({
    agentId: input.agentId,
    scopedTokenId: input.scopedTokenId,
    operationType: input.operationType,
    target: {
      owner: canon.owner,
      repo: canon.repo,
      branch: input.branch,
      head_sha: input.headSha,
      pr_number: input.prNumber,
      commits_count: input.commitsCount,
      commit_message: input.commitMessage,
    },
    clientSessionId: input.clientSessionId,
  });

  const result = await emitOrQueue(event, deps.queue, {
    endpoint: `${deps.spellguardBaseUrl.replace(/\/$/, '')}/v1/observations`,
    agentId: deps.agentId,
    agentSecret: deps.agentSecret,
    fetchImpl: deps.fetchImpl,
  });

  return {
    emitted: true,
    reason: result.delivered ? 'delivered' : 'queued',
    event,
  };
}
