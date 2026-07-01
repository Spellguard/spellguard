// SPDX-License-Identifier: Apache-2.0

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { defaultConfigDir, legacyConfigDir } from './config-store';
import { stopLocalDaemons } from './stop-daemons';

/**
 * One-time migration of a legacy single-slot `<root>/config.json` (pre
 * per-framework isolation, B1) into THIS framework's subdir
 * (`<root>/<framework>/`). Without it, an upgraded machine reads the new
 * framework path and looks unconfigured even though its identity is on disk.
 *
 * MOVE, never copy — a copied identity would leave the same agentId/agentSecret
 * live in two slots (two daemons, one secret), worse than the bug it fixes.
 *
 * Decision: when BOTH frameworks are installed, the FIRST to start after upgrade
 * claims the legacy identity (writes the shared `.migrated` marker); the other
 * starts empty and must re-run setup. Rare, and the legacy identity belonged to
 * whatever was last set up. The marker lives at the SHARED root so both
 * frameworks see it — a second framework's start (or a second call) is a no-op.
 *
 * Best-effort and idempotent; never overwrites a framework that already has its
 * own config.json (that framework's legacy config is left for an as-yet-empty
 * framework to claim later).
 *
 * NOTE: byte-identical to `packages/claude-code-plugin/src/lib/migrate-legacy-config.ts`
 * — keep the two mirrored (verify-codex-claude-parity).
 */
export interface MigrateLegacyConfigResult {
  migrated: boolean;
  reason:
    | 'migrated'
    | 'already-migrated'
    | 'no-legacy-config'
    | 'framework-already-configured'
    | 'move-failed';
}

/** Move src→dst (same filesystem); copy+unlink fallback for a cross-device
 * rename. Returns true when the move happened. */
function moveFile(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  try {
    renameSync(src, dst);
    return true;
  } catch {
    try {
      copyFileSync(src, dst);
      rmSync(src, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

export function migrateLegacyConfig(
  opts: {
    legacyDir?: string;
    frameworkDir?: string;
    /** Injectable for tests; defaults to `stopLocalDaemons({ configDir })`. */
    stopLegacyDaemons?: (dir: string) => void;
  } = {},
): MigrateLegacyConfigResult {
  const legacyDir = opts.legacyDir ?? legacyConfigDir();
  const frameworkDir = opts.frameworkDir ?? defaultConfigDir();
  const marker = join(legacyDir, '.migrated');

  // The legacy identity has already been claimed by some framework — never
  // re-run (stops a second framework double-claiming the same config).
  if (existsSync(marker))
    return { migrated: false, reason: 'already-migrated' };

  const legacyConfig = join(legacyDir, 'config.json');
  if (!existsSync(legacyConfig)) {
    return { migrated: false, reason: 'no-legacy-config' };
  }

  // This framework already has its own identity — don't clobber it, and leave
  // the legacy config for an as-yet-empty framework to claim.
  const frameworkConfig = join(frameworkDir, 'config.json');
  if (existsSync(frameworkConfig)) {
    return { migrated: false, reason: 'framework-already-configured' };
  }

  // Stop any daemon registered under the legacy dir BEFORE the move so its open
  // fd / pidfile don't outlive it — otherwise the moved inode would be written
  // by both the old daemon and the framework daemon session-start respawns.
  const stop =
    opts.stopLegacyDaemons ??
    ((dir: string) => stopLocalDaemons({ configDir: dir }));
  try {
    stop(legacyDir);
  } catch {
    /* best-effort */
  }

  mkdirSync(frameworkDir, { recursive: true, mode: 0o700 });

  // config.json is the identity — it MUST move for the migration to count.
  if (!moveFile(legacyConfig, frameworkConfig)) {
    return { migrated: false, reason: 'move-failed' }; // no marker → retry next session
  }

  // git-tokens regenerates from config.json on daemon boot and agents/ pidfiles
  // are transient, so move them best-effort (nothing stale left at the root).
  moveFile(join(legacyDir, 'git-tokens'), join(frameworkDir, 'git-tokens'));
  const legacyAgents = join(legacyDir, 'agents');
  if (existsSync(legacyAgents)) {
    try {
      renameSync(legacyAgents, join(frameworkDir, 'agents'));
    } catch {
      /* best-effort — the daemon recreates agents/ on respawn */
    }
  }

  writeFileSync(
    marker,
    'spellguard: legacy single-slot config migrated into a per-framework dir\n',
    { mode: 0o600 },
  );
  return { migrated: true, reason: 'migrated' };
}
