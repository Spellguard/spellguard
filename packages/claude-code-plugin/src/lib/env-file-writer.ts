// SPDX-License-Identifier: Apache-2.0

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type RepoIdentity,
  isSshRewriteEnabled,
  sshRewriteEntries,
} from './git-insteadof-rules';

const HERE = dirname(fileURLToPath(import.meta.url));

function bundledHelperPath(): string {
  // packages/claude-code-plugin/src/lib/env-file-writer.ts -> ../../bin/spellguard-git-helper
  return resolve(HERE, '..', '..', 'bin', 'spellguard-git-helper');
}

/**
 * Copy the bundled (versioned) git-helper to a STABLE, version-independent path
 * under the per-framework config dir, and return that path. The session env bakes
 * THIS path — not the versioned plugin-install dir — so a resumed session survives
 * a plugin upgrade: the old version dir is deleted, but this copy persists. The
 * helper resolves `<framework>/git-tokens` by absolute XDG path, so it works
 * wherever it lives. Idempotent (overwrites each call, keeping the logic current).
 * Degrades to the bundled path on any copy failure — never break git auth over it.
 */
export function ensureStableHelper(configDir: string): string {
  const bundled = bundledHelperPath();
  try {
    const dest = join(configDir, 'bin', 'spellguard-git-helper');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(bundled, dest);
    chmodSync(dest, 0o755);
    return dest;
  } catch {
    return bundled;
  }
}

export interface EnvFileSpec {
  envFilePath: string; // value of CLAUDE_ENV_FILE
  helperPath?: string; // override for tests
  gitAuthorName?: string; // e.g. "nickf (Spellguard:demo-x)"
  gitAuthorEmail?: string; // e.g. "nick@example.com"
  ghConfigDir?: string; // value of GH_CONFIG_DIR — pins the gh CLI to the scoped token
  /**
   * Include the session-scoped SSH->HTTPS `insteadOf` rewrite slots so the
   * agent's git transparently uses HTTPS (and thus the Spellguard credential
   * helper + scoped token) even when the stored remote is SSH. Defaults to
   * `isSshRewriteEnabled()` (on unless `SPELLGUARD_SSH_REWRITE` is
   * 0/off/false/no). Harmless for HTTPS remotes — they don't match the SSH
   * prefixes and pass through unchanged. See `git-insteadof-rules.ts`.
   */
  sshRewrite?: boolean;
  /**
   * The origin repo identity (case-preserved owner/repo). When supplied AND
   * `sshRewrite` is on, adds the full-repo-path IDENTITY `insteadOf` /
   * `pushInsteadOf` rules (3 & 4) that out-specify a user's global force-SSH
   * rule. Set by session-start when handling a detected SSH remote; omitted on
   * the daemon-rotation path (host-level rules 1/2 still apply).
   */
  sshRewriteRepo?: RepoIdentity;
}

// Single-quote a value for safe inclusion in a bash assignment line.
// Claude Code sources CLAUDE_ENV_FILE as bash, so any value containing
// shell metacharacters (parens, spaces, quotes, etc.) must be quoted —
// otherwise `GIT_CONFIG_VALUE_2=nick (Spellguard:foo)` is parsed as a
// subshell call and bash exits with a syntax error.
function bashQuote(value: string): string {
  // Wrap in single quotes; escape any embedded single quotes via the
  // standard '\'' close-quote / escaped-quote / open-quote dance.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function writeGitConfigEnv(spec: EnvFileSpec): void {
  // Empty/unset CLAUDE_ENV_FILE (setup-CLI context, hook misconfig) — the
  // caller has already logged that env-file updates are skipped; attempting
  // writeFileSync('') here produced "error: ENOENT … open ''" daemon-log
  // noise (plan Task 2.3 Fix 1, I7).
  if (!spec.envFilePath) return;
  const helper = spec.helperPath ?? bundledHelperPath();
  // Use GIT_CONFIG_COUNT/KEY/VALUE so we override credential.helper without
  // touching the developer's persistent ~/.gitconfig.
  // Ordering: clear inherited helpers (empty value) then add ours.
  const hasAuthor =
    typeof spec.gitAuthorName === 'string' &&
    spec.gitAuthorName.length > 0 &&
    typeof spec.gitAuthorEmail === 'string' &&
    spec.gitAuthorEmail.length > 0;
  // Claude Code's contract: lines in CLAUDE_ENV_FILE must be `export VAR=VALUE`.
  // Without `export`, the assignment is shell-local when sourced and doesn't
  // propagate to child processes (git, gh, etc.) — which is the whole point.
  //
  // Why the URL-specific override (credential.https://github.com.helper):
  // Hosts often have `gh auth setup-git` registered as the URL-specific
  // helper for github.com, which beats the generic `credential.helper` we
  // set below. We need to clear+replace the URL-specific entry too,
  // otherwise gh's helper provides the host user's PAT instead of the
  // Spellguard scoped token, and pushes to the test org 403 on auth.
  // Phase C: `credential.https://github.com.useHttpPath=true` makes git pass
  // the repo `path=` (owner/repo) to the host-scoped helper on every get, so
  // the helper can route by the repo-owner segment to the right per-org token
  // (decision D13). Slot 6 is a single key/value (no clear+set needed — it's a
  // boolean we want set, not an inherited helper we're overriding).
  //
  // After the fixed slots 0-6 we APPEND, in order: the SSH->HTTPS `insteadOf`
  // rewrite slots (when enabled — see git-insteadof-rules.ts), then the author
  // identity slots (when present). Indices and GIT_CONFIG_COUNT are computed
  // from a running counter so the appended sections shift cleanly.
  const sshRewrite = spec.sshRewrite ?? isSshRewriteEnabled();
  const lines = [
    'export GIT_CONFIG_KEY_0=credential.helper',
    "export GIT_CONFIG_VALUE_0=''", // disables any inherited generic helper
    'export GIT_CONFIG_KEY_1=credential.helper',
    `export GIT_CONFIG_VALUE_1=${bashQuote(helper)}`,
    'export GIT_CONFIG_KEY_2=credential.https://github.com.helper',
    "export GIT_CONFIG_VALUE_2=''", // disables gh / other URL-specific helpers
    'export GIT_CONFIG_KEY_3=credential.https://github.com.helper',
    `export GIT_CONFIG_VALUE_3=${bashQuote(helper)}`,
    'export GIT_CONFIG_KEY_4=credential.https://gist.github.com.helper',
    "export GIT_CONFIG_VALUE_4=''",
    'export GIT_CONFIG_KEY_5=credential.https://gist.github.com.helper',
    `export GIT_CONFIG_VALUE_5=${bashQuote(helper)}`,
    'export GIT_CONFIG_KEY_6=credential.https://github.com.useHttpPath',
    'export GIT_CONFIG_VALUE_6=true',
  ];
  let idx = 7;
  if (sshRewrite) {
    // Transparently rewrite SSH github.com remotes to HTTPS for this session so
    // git uses the Spellguard helper. Rules 1/2 (host-level) always; rules 3/4
    // (full-repo-path IDENTITY insteadOf + pushInsteadOf) when the repo is known
    // — they out-specify a user's global force-SSH rule. See git-insteadof-rules.
    for (const rule of sshRewriteEntries(spec.sshRewriteRepo)) {
      lines.push(
        `export GIT_CONFIG_KEY_${idx}=${rule.key}`,
        `export GIT_CONFIG_VALUE_${idx}=${bashQuote(rule.value)}`,
      );
      idx++;
    }
  }
  if (hasAuthor) {
    lines.push(
      `export GIT_CONFIG_KEY_${idx}=user.name`,
      `export GIT_CONFIG_VALUE_${idx}=${bashQuote(spec.gitAuthorName as string)}`,
    );
    idx++;
    lines.push(
      `export GIT_CONFIG_KEY_${idx}=user.email`,
      `export GIT_CONFIG_VALUE_${idx}=${bashQuote(spec.gitAuthorEmail as string)}`,
    );
    idx++;
  }
  lines.unshift(`export GIT_CONFIG_COUNT=${idx}`);
  // Pin the gh CLI (gh api / gh pr create) to the scoped token via GH_CONFIG_DIR.
  // gh re-reads hosts.yml in this dir on every invocation, so the daemon
  // refreshing it on rotation is picked up transparently. Plain env var, NOT a
  // GIT_CONFIG_* key, so it does not affect GIT_CONFIG_COUNT.
  if (spec.ghConfigDir) {
    lines.push(`export GH_CONFIG_DIR=${bashQuote(spec.ghConfigDir)}`);
  }
  if (existsSync(spec.envFilePath)) {
    appendFileSync(spec.envFilePath, `\n${lines.join('\n')}\n`, 'utf-8');
  } else {
    writeFileSync(spec.envFilePath, `${lines.join('\n')}\n`, 'utf-8');
  }
}

export function clearGitConfigEnv(envFilePath: string): void {
  // Empty path → no env file to clear (see writeGitConfigEnv guard).
  if (!envFilePath) return;
  // For monitor-detected revocation: overwrite the env file with a single
  // GIT_CONFIG_COUNT=0 line so subsequent git operations have no Spellguard
  // helper. The developer's persistent config is still untouched.
  writeFileSync(envFilePath, 'export GIT_CONFIG_COUNT=0\n', 'utf-8');
}
