// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfigDir } from './config-store';

/**
 * Stop every locally-running credential daemon by reading
 * `<configDir>/agents/*.pid` and SIGTERM-ing each pid. Best-effort by
 * design: a dead pid (ESRCH), a garbage pidfile, or a missing directory are
 * all silently skipped. Used by /spellguard-reset and before a fresh
 * bootstrap so a stale-identity daemon can't race config writes against the
 * new identity (plan Task 2.10, 2026-06-11).
 */
export function stopLocalDaemons(opts?: {
  configDir?: string;
  killImpl?: (pid: number, signal: NodeJS.Signals) => boolean;
}): number[] {
  const dir = join(opts?.configDir ?? defaultConfigDir(), 'agents');
  const kill = opts?.killImpl ?? process.kill.bind(process);
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.pid'));
  } catch {
    return [];
  }
  const stopped: number[] = [];
  for (const f of entries) {
    const p = join(dir, f);
    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(p, 'utf8').trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch {
      /* ESRCH etc — already dead */
    }
    try {
      unlinkSync(p);
    } catch {
      /* daemon's own SIGTERM handler may have removed it */
    }
  }
  return stopped;
}
