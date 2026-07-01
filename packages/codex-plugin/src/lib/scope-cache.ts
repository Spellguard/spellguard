// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';
import type { RepoTuple } from './observation-scope';

export interface CachedScope {
  serverScope: RepoTuple[];
  refreshedAt: number; // ms epoch
}

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function readScopeCache(path: string): CachedScope | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as CachedScope;
    if (
      !Array.isArray(parsed.serverScope) ||
      typeof parsed.refreshedAt !== 'number'
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeScopeCache(path: string, scope: CachedScope): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(scope), { mode: 0o600 });
  // writeFileSync's `mode` only applies when the file is created;
  // rewrites keep any prior (potentially laxer) perms. chmod unconditionally
  // so the cache is always 0o600 on POSIX.
  if (platform() !== 'win32') {
    chmodSync(path, 0o600);
  }
}

export function shouldRefreshCache(
  cache: CachedScope | null,
  now = Date.now(),
): boolean {
  if (!cache) return true;
  return now - cache.refreshedAt >= REFRESH_INTERVAL_MS;
}
