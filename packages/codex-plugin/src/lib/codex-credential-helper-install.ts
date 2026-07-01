// SPDX-License-Identifier: Apache-2.0

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearCodexShellEnvPolicy,
  installCodexShellEnvPolicy,
} from './codex-shell-env-policy';
import type { RepoIdentity } from './git-insteadof-rules';

/**
 * Install / clear the Spellguard git credential helper + author identity for
 * Codex.
 *
 * HISTORY (2026-06-15 leak fix): this used to run `git config --global
 * --replace-all credential.https://github.com.helper <helper>`, which clobbered
 * the user's MACHINE-GLOBAL `~/.gitconfig`. On a revoke the helper returned
 * nothing and plain-shell `git pull` (in every other terminal) fell back to a
 * username/password prompt — the credential was bricked machine-wide.
 *
 * It now writes a Codex-scoped `[shell_environment_policy]` block in
 * `~/.codex/config.toml` instead (`codex-shell-env-policy.ts`) — the Codex
 * analogue of Claude Code's `CLAUDE_ENV_FILE`. Nothing outside Codex is touched.
 * These thin wrappers keep the public names so the call sites need only thread
 * `ghConfigDir`. A one-time session restart after setup is required for Codex to
 * read the new config (called out in onboarding); token rotation after that
 * needs no restart (the helper reads the live token from `config.json`).
 */

/** Absolute path to the bundled `spellguard-git-helper`. Resolves correctly
 * from both the source tree (`src/lib/...` → ../.. = plugin root) and the built
 * bin bundles (`dist/bin/...` → ../.. = plugin root). */
function bundledHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'bin', 'spellguard-git-helper');
}

export function installCodexCredentialHelper(args: {
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  /** Per-agent gh config dir (`GH_CONFIG_DIR`) — pins the gh CLI to the scoped token. */
  ghConfigDir?: string;
  /** Override the helper path (tests). */
  helperPath?: string;
  /**
   * Include the session-scoped SSH->HTTPS `insteadOf` rewrite slots. Defaults to
   * `isSshRewriteEnabled()` (on unless `SPELLGUARD_SSH_REWRITE` is
   * 0/off/false/no). See `git-insteadof-rules.ts`.
   */
  sshRewrite?: boolean;
  /**
   * Origin repo identity (case-preserved). When supplied AND `sshRewrite` is on,
   * adds the full-repo-path IDENTITY rules (3 & 4). See `git-insteadof-rules.ts`.
   */
  sshRewriteRepo?: RepoIdentity;
  /** Override `~/.codex` / CODEX_HOME (tests). */
  codexHome?: string;
}): void {
  // Best-effort: a SessionStart hook must never crash the user's Codex session.
  // A write failure leaves git with no Spellguard helper, so it fails closed
  // (safe) rather than leaking a host credential.
  try {
    installCodexShellEnvPolicy({
      helperPath: args.helperPath ?? bundledHelperPath(),
      ghConfigDir: args.ghConfigDir,
      gitAuthorName: args.gitAuthorName,
      gitAuthorEmail: args.gitAuthorEmail,
      sshRewrite: args.sshRewrite,
      sshRewriteRepo: args.sshRewriteRepo,
      codexHome: args.codexHome,
    });
  } catch {
    /* best-effort — config.toml unwritable; git fails closed */
  }
}

export function clearCodexCredentialHelper(args?: {
  codexHome?: string;
}): void {
  // Clearing our Codex-scoped block can NEVER remove a human's real git
  // identity or helper — those live in `~/.gitconfig`, which we no longer
  // touch. The old `--get`/`--unset`-guarded identity dance is therefore gone.
  try {
    clearCodexShellEnvPolicy({ codexHome: args?.codexHome });
  } catch {
    /* best-effort — config.toml unwritable / already clean */
  }
}
