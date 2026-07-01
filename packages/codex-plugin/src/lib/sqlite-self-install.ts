// SPDX-License-Identifier: Apache-2.0

// Setup-time self-installer for the native SQLite fallback.
//
// A marketplace plugin install (a bare `git clone` of the committed `dist/`,
// no install step) lacks the vendored `better-sqlite3`, and on a Node version
// that doesn't expose `node:sqlite` flag-free there is no built-in fallback —
// so the per-line code-attribution feature degrades. This module is invoked
// from `/spellguard-setup`: when NO usable SQLite backend is available, it
// installs `better-sqlite3` (plus its two runtime transitives, `bindings` and
// `file-uri-to-path`) into the PLUGIN's own root (next to `dist/`), where
// edit-store's `createRequire(import.meta.url)` resolves it.
//
// The install relies on `better-sqlite3`'s `prebuild-install`, which downloads
// the correct prebuilt binary for the current platform/arch — NO source
// compile on common platforms, no native toolchain required.
//
// It is deliberately resilient: a missing/offline npm or a read-only plugin
// dir must NOT fail setup. The caller surfaces a friendly "attribution will be
// degraded" note and continues.
//
// IMPORTANT (parity): this file is byte-identical between the claude-code and
// codex plugins (see scripts/verify-codex-claude-parity.sh). Keep it neutral —
// no framework-specific strings.

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasUsableSqliteBackend } from './sqlite-backend';

// Only these three packages — better-sqlite3 + its runtime transitives — are
// installed. `bindings` is required by better-sqlite3/lib/database.js and it in
// turn requires `file-uri-to-path`. We pin major versions matching the
// plugin's declared dependency to avoid resolving a breaking new major.
const SELF_INSTALL_PACKAGES = [
  'better-sqlite3@^12',
  'bindings@^1',
  'file-uri-to-path@^1',
];

export interface SelfInstallResult {
  /** 'already' = a backend was already usable, no install attempted. */
  status: 'already' | 'installed' | 'skipped' | 'failed';
  /** The directory we installed into (plugin root), when applicable. */
  installDir?: string;
  /** Human-readable reason for skipped/failed. */
  reason?: string;
}

/**
 * Resolve the plugin root — the directory that contains `dist/` and where the
 * vendored `node_modules` lives. At runtime the setup CLI executes from
 * `dist/bin/run-spellguard-setup.mjs`, so the plugin root is two levels up from
 * this module's directory (`dist/lib` → `dist` → plugin root). In the
 * non-bundled (tsx/vitest) layout this module sits at `src/lib`, so the same
 * two-levels-up rule lands on the package root. An explicit override is
 * accepted for tests.
 */
export function resolvePluginRoot(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

/** Is `dir` writable (so we can create node_modules under it)? */
function isWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureOptions {
  /** Override the plugin root (tests). */
  pluginRoot?: string;
  /**
   * Test seam — replace the actual `npm install` spawn. Resolves to an exit
   * code (0 = success). When omitted, a real `npm install` is spawned.
   */
  runInstall?: (args: {
    cwd: string;
    packages: string[];
  }) => Promise<{ code: number; stderr: string }>;
  /** Test seam — override the backend-availability probe. */
  hasBackend?: () => boolean;
  /** Re-probe the backend after install (defaults to the real probe). */
  hasBackendAfter?: () => boolean;
}

/**
 * Ensure a usable SQLite backend exists, self-installing `better-sqlite3` into
 * the plugin root when none is available. NEVER throws — every failure mode
 * (no usable backend remains) is reported via the returned status so the setup
 * flow can print a friendly note and continue.
 */
export async function ensureSqliteBackend(
  opts: EnsureOptions = {},
): Promise<SelfInstallResult> {
  const hasBackend = opts.hasBackend ?? hasUsableSqliteBackend;
  if (hasBackend()) return { status: 'already' };

  const pluginRoot = resolvePluginRoot(opts.pluginRoot);

  // Make sure the target node_modules dir exists + the root is writable. A
  // read-only mount (e.g. a container bind-mount) must degrade gracefully.
  try {
    mkdirSync(resolve(pluginRoot, 'node_modules'), { recursive: true });
  } catch (err) {
    return {
      status: 'skipped',
      installDir: pluginRoot,
      reason: `plugin directory is not writable (${(err as Error).message})`,
    };
  }
  if (!isWritable(pluginRoot)) {
    return {
      status: 'skipped',
      installDir: pluginRoot,
      reason: 'plugin directory is not writable',
    };
  }

  const runInstall = opts.runInstall ?? defaultNpmInstall;
  let installOutcome: { code: number; stderr: string };
  try {
    installOutcome = await runInstall({
      cwd: pluginRoot,
      packages: SELF_INSTALL_PACKAGES,
    });
  } catch (err) {
    // spawn itself failed (npm missing / ENOENT) — degrade, don't throw.
    return {
      status: 'failed',
      installDir: pluginRoot,
      reason: `npm install could not run (${(err as Error).message}); is npm on PATH?`,
    };
  }

  if (installOutcome.code !== 0) {
    return {
      status: 'failed',
      installDir: pluginRoot,
      reason: `npm install exited ${installOutcome.code}${
        installOutcome.stderr ? `: ${installOutcome.stderr.trim()}` : ''
      }`,
    };
  }

  // Confirm the install actually produced a loadable backend (a green npm exit
  // with a broken binary would otherwise report false success — the type-4
  // "effect on the consuming surface" check).
  const hasAfter = opts.hasBackendAfter ?? hasUsableSqliteBackend;
  if (!hasAfter()) {
    return {
      status: 'failed',
      installDir: pluginRoot,
      reason:
        'better-sqlite3 installed but did not load (no prebuilt binary for this platform/arch?)',
    };
  }

  return { status: 'installed', installDir: pluginRoot };
}

/**
 * Spawn `npm install --no-save --no-audit --no-fund <packages>` in the plugin
 * root. `--no-save` because the plugin's own package.json is committed and we
 * don't want to mutate it; we install ONLY the named packages, not the plugin's
 * whole dependency tree. `prebuild-install` (better-sqlite3's install script)
 * downloads the prebuilt binary, so no compiler is needed on common platforms.
 *
 * `--ignore-scripts` is deliberately NOT passed — better-sqlite3 needs its
 * install script to fetch the prebuilt binary.
 */
function defaultNpmInstall(args: {
  cwd: string;
  packages: string[];
}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      'npm',
      [
        'install',
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        ...args.packages,
      ],
      {
        cwd: args.cwd,
        // Inherit stdout so prebuild-install progress is visible; capture
        // stderr so we can surface a concise reason on failure.
        stdio: ['ignore', 'inherit', 'pipe'],
        env: process.env,
      },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectP);
    child.on('close', (code) => resolveP({ code: code ?? 1, stderr }));
  });
}
