// SPDX-License-Identifier: Apache-2.0

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createManagementClient } from '@spellguard/agent-control';
import type { StatusResponse } from '../hooks/session-start';
import { markConfigRevoked, readConfig } from '../lib/config-store';
import { clearGitConfigEnv } from '../lib/env-file-writer';
import { type RepoTuple, loadUserAllowlist } from '../lib/observation-scope';
import { renderMessage } from '../lib/render-message';
import {
  readScopeCache,
  shouldRefreshCache,
  writeScopeCache,
} from '../lib/scope-cache';

export interface MonitorTickDeps {
  fetchImpl?: typeof fetch;
  envFilePath?: string;
  scopeCachePath?: string;
  // Allow test / DI override; defaults to
  // $XDG_CONFIG_HOME/spellguard/observation.yaml (or ~/.config/... ).
  allowlistPath?: string;
}

export interface MonitorTickResult {
  status:
    | 'valid'
    | 'near_expiry'
    | 'expired'
    | 'revoked'
    | 'superseded'
    | 'unknown';
  scopeRefreshed: boolean;
}

interface ScopeResponse {
  server_scope: Array<{ owner: string; repo: string }>;
  refreshed_at: string;
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

export async function runMonitorTick(
  deps: MonitorTickDeps = {},
): Promise<MonitorTickResult> {
  const result = readConfig();
  if (!result.config) return { status: 'unknown', scopeRefreshed: false };
  if (result.config.revoked)
    return { status: 'revoked', scopeRefreshed: false };
  // Identity-only configs (post-bootstrap, before any GitHub
  // credential has arrived through the credential channel) have no
  // scopedTokenId to probe. The monitor is a no-op until the daemon
  // receives the credential and the config gains the scoped fields;
  // returning 'unknown' is the same shape as a missing config (the
  // caller — `runMonitorTick` consumers — already handles 'unknown' by
  // skipping the polling work).
  if (!result.config.scopedTokenId) {
    return { status: 'unknown', scopeRefreshed: false };
  }
  const scopedTokenIdValue = result.config.scopedTokenId;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = result.config.spellguardBaseUrl;
  const agentId = result.config.agentId;
  const agentSecret = result.config.agentSecret;
  const envFilePath = deps.envFilePath ?? process.env.CLAUDE_ENV_FILE ?? '';
  const scopeCachePath = deps.scopeCachePath ?? defaultScopeCachePath();

  // Attach the current scoped token so the server-side GitHub
  // liveness probe can detect GitHub-side revocation. Without
  // this header the probe branch never fires and the 60s monitor poll
  // returns DB-only state forever.
  const scopedToken = result.config.scopedToken;
  const api = createManagementClient({
    baseUrl,
    agentId,
    agentSecret,
    fetchImpl,
  });
  const { data: statusData, error: statusError } = await api.GET(
    '/credentials/github/status',
    {
      params: { query: { scoped_token_id: scopedTokenIdValue } },
      headers: scopedToken
        ? { 'X-Spellguard-Scoped-Token': scopedToken }
        : undefined,
    },
  );

  if (statusError) return { status: 'unknown', scopeRefreshed: false };

  const credStatus = (statusData as StatusResponse).status;

  if (credStatus === 'revoked') {
    markConfigRevoked();
    if (envFilePath) clearGitConfigEnv(envFilePath);
    renderMessage({
      level: 'error',
      message:
        'Spellguard: credential revoked; subsequent git operations will fail until you re-run `/spellguard-setup` or restart Claude Code.',
    });
  }

  // Scope-cache refresh: every 30 minutes during active session.
  const scopeRefreshed = await maybeRefreshScopeCache({
    baseUrl,
    agentId,
    agentSecret,
    fetchImpl,
    scopedTokenId: scopedTokenIdValue,
    scopeCachePath,
    allowlistPath: deps.allowlistPath ?? defaultAllowlistPath(),
  });

  return { status: credStatus, scopeRefreshed };
}

// Factored out of runMonitorTick to keep it under the cognitive-complexity
// budget. Returns true if the cache was refreshed.
async function maybeRefreshScopeCache(opts: {
  baseUrl: string;
  agentId: string;
  agentSecret: string;
  fetchImpl: typeof fetch;
  scopedTokenId: string;
  scopeCachePath: string;
  allowlistPath: string;
}): Promise<boolean> {
  const cache = readScopeCache(opts.scopeCachePath);
  if (!shouldRefreshCache(cache)) return false;

  const api = createManagementClient({
    baseUrl: opts.baseUrl,
    agentId: opts.agentId,
    agentSecret: opts.agentSecret,
    fetchImpl: opts.fetchImpl,
  });
  // scope query stays a cast against the COMMITTED contract: the checked-in
  // openapi.json/schema for this route is stale and omits the `scoped_token_id`
  // query (the route source declares it, identical to /status). `gen:clients`
  // regenerates it; until then the cast keeps the typed call compiling.
  const { data: scopeData, error: scopeError } = await api.GET(
    '/credentials/github/scope',
    { params: { query: { scoped_token_id: opts.scopedTokenId } } },
  );
  if (scopeError) return false;

  writeScopeCache(opts.scopeCachePath, {
    serverScope: (scopeData as ScopeResponse).server_scope as RepoTuple[],
    refreshedAt: Date.now(),
  });

  // Bump server-side telemetry + report current allowlist.
  // Missing/empty file → send []. Server accepts absent body for back-compat.
  try {
    const { allowlist } = loadUserAllowlist(opts.allowlistPath);
    // scope-ack body stays a cast: the route keeps a manual content-length size guard, so its body isn't declared in the contract.
    await api.PUT('/credentials/github/scope-ack', {
      body: { user_allowlist: allowlist } as never,
    });
  } catch {
    // Non-fatal — telemetry only; scope cache is still updated.
  }
  return true;
}
