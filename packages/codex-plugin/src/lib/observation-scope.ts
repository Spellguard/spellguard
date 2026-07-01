// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

export interface RepoTuple {
  owner: string;
  repo: string;
}

export interface ScopeContext {
  serverScope: RepoTuple[];
  userAllowlist: RepoTuple[];
  cacheRefreshedAt: number; // ms epoch; SessionStart pulls fresh, monitor refreshes every 30 min
}

export interface AllowlistResult {
  allowlist: RepoTuple[];
  parseError?: string;
}

const STALENESS_MS = 24 * 60 * 60 * 1000;

function tupleKey(t: RepoTuple): string {
  return `${t.owner.toLowerCase()}/${t.repo.toLowerCase()}`;
}

export function isInEffectiveScope(
  target: RepoTuple,
  ctx: ScopeContext,
): boolean {
  // Fail-closed: stale cache is never in-scope.
  const ageMs = Date.now() - ctx.cacheRefreshedAt;
  if (ageMs >= STALENESS_MS) return false;

  const key = tupleKey(target);
  const inServer = ctx.serverScope.some((t) => tupleKey(t) === key);
  if (!inServer) return false;
  // Empty allowlist means "no further narrowing" (server scope is the filter).
  if (ctx.userAllowlist.length === 0) return true;
  return ctx.userAllowlist.some((t) => tupleKey(t) === key);
}

export function loadUserAllowlist(path: string): AllowlistResult {
  if (!existsSync(path)) return { allowlist: [] };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return {
      allowlist: [],
      parseError: `read failed: ${(e as Error).message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    return {
      allowlist: [],
      parseError: `yaml parse failed: ${(e as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== 'object') return { allowlist: [] };
  const list = (parsed as { allowlist?: unknown }).allowlist;
  if (!Array.isArray(list)) return { allowlist: [] };
  const out: RepoTuple[] = [];
  for (const entry of list) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as RepoTuple).owner === 'string' &&
      typeof (entry as RepoTuple).repo === 'string'
    ) {
      out.push({
        owner: (entry as RepoTuple).owner.toLowerCase(),
        repo: (entry as RepoTuple).repo.toLowerCase(),
      });
    }
  }
  return { allowlist: out };
}
