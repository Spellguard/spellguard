// SPDX-License-Identifier: Apache-2.0

import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SpellguardConfig, defaultConfigDir } from './config-store';

/**
 * Result shape for `ensureCredentialDaemonRunning`.
 */
export type DaemonResult =
  | { daemon: 'already-running'; pid: number }
  | { daemon: 'spawned' }
  | { daemon: 'skipped'; reason: string };

/**
 * Arguments for `ensureCredentialDaemonRunning`.
 *
 * Extracted from `src/hooks/session-start.ts` (2026-06-11) so the setup CLI
 * can start the daemon too — previously the session-start hook was the ONLY
 * spawner, which left a freshly-bootstrapped install with no credential
 * consumer until the next session boundary.
 *
 * Unlike the Claude Code variant, the Codex daemon needs no env-file path —
 * its credential handler updates `git config` directly — and no `--cwd`.
 */
export interface EnsureDaemonArgs {
  config: SpellguardConfig;
  /**
   * Credential daemon spawn: override for tests — inject a mock spawn
   * function. The production path (no override) calls `child_process.spawn`
   * with `detached: true, stdio: 'ignore'` and immediately `.unref()`s the
   * child so the calling process can exit cleanly.
   */
  spawnDaemon?: (execPath: string, args: string[], opts: SpawnOptions) => void;
  /**
   * Override the config directory used for PID file resolution. Defaults to
   * `defaultConfigDir()`. Tests pass an isolated temp dir.
   */
  configDir?: string;
}

/** Resolve the daemon script path relative to this module's install location. */
function daemonScriptPath(): string {
  // This module lives at packages/codex-plugin/src/lib/daemon-spawn.ts
  // The daemon lives at    packages/codex-plugin/bin/spellguard-credential-daemon.ts
  // After bundling:        dist/bin/<entry>.mjs → dist/bin/spellguard-credential-daemon.mjs
  //
  // We resolve relative to import.meta.url so the path stays correct
  // regardless of CWD. `__dirname` is unavailable in ESM; fileURLToPath +
  // dirname replicates it.
  const here = dirname(fileURLToPath(import.meta.url));
  // During development (unbundled): here = src/lib → ../../bin/
  // After build (bundled):          here = dist/bin → ./
  const devPath = join(
    here,
    '..',
    '..',
    'bin',
    'spellguard-credential-daemon.ts',
  );
  const builtPath = join(here, 'spellguard-credential-daemon.mjs');

  // When this module is running from dist/bin (shipped plugin install),
  // prefer the sibling built .mjs even if the source .ts exists on disk in
  // the same repo checkout — plain Node cannot execute TypeScript, so
  // spawning the .ts would exit immediately while the spawn syscall still
  // "succeeded".
  const runningFromDist =
    here.endsWith(`${sep}dist${sep}bin`) || here.endsWith('/dist/bin');
  if (runningFromDist && existsSync(builtPath)) return builtPath;

  // Development / unbundled — prefer the .ts source so changes are picked up
  // without a rebuild.
  if (existsSync(devPath)) return devPath;
  return builtPath;
}

/** Read the PID stored in the daemon's PID file, or null if absent/invalid. */
function readDaemonPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Returns true if `process.kill(pid, 0)` succeeds (process is alive). */
function isDaemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the persistent credential daemon for `config.agentId` unless a live
 * one is already registered in the PID file. The daemon is the sole consumer
 * of `credential_delivered` / `credential_rotated` frames — without it, a
 * pushed GitHub credential has no consumer and sits queued server-side.
 */
export function ensureCredentialDaemonRunning(
  args: EnsureDaemonArgs,
): DaemonResult {
  const { config } = args;

  // Only start when an agent secret and agentId are present.
  if (!config.agentSecret || !config.agentId) {
    return { daemon: 'skipped', reason: 'missing_credentials' };
  }

  const configDir = args.configDir ?? defaultConfigDir();
  const pidDir = join(configDir, 'agents');
  const pidPath = join(pidDir, `${config.agentId}.pid`);

  // Check if a live daemon is already running.
  const existingPid = readDaemonPid(pidPath);
  if (existingPid !== null && isDaemonAlive(existingPid)) {
    return { daemon: 'already-running', pid: existingPid };
  }

  // Spawn the daemon detached so it survives the calling process exiting.
  const scriptPath = daemonScriptPath();
  const spawnFn = args.spawnDaemon ?? defaultSpawnDaemon;
  spawnFn(process.execPath, [scriptPath, config.agentId], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      // Codex daemon does not need an env file path — it updates git config
      // directly via execFileSync in the credential handler.
    },
  });

  return { daemon: 'spawned' };
}

function defaultSpawnDaemon(
  execPath: string,
  args: string[],
  opts: SpawnOptions,
): void {
  const child = spawn(execPath, args, opts);
  child.unref();
}
