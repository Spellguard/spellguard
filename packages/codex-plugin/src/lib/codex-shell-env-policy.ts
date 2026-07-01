// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  type RepoIdentity,
  isSshRewriteEnabled,
  sshRewriteEntries,
} from './git-insteadof-rules';

/**
 * Codex credential injection via `~/.codex/config.toml`
 * `[shell_environment_policy]` — the Codex analogue of Claude Code's
 * `CLAUDE_ENV_FILE`.
 *
 * Codex applies `shell_environment_policy.set` as an additive env map to every
 * command it spawns, so the SAME `GIT_CONFIG_*`→helper slots the Claude Code
 * env-file writes (see `claude-code-plugin/src/lib/env-file-writer.ts`) drive
 * git's credential resolution here too — but scoped to Codex. This REPLACES the
 * old `git config --global` mutation, which clobbered the user's machine-global
 * `~/.gitconfig` and bricked plain-shell git after a revoke (2026-06-15 leak).
 *
 * Design invariants:
 *   - NEVER touches `~/.gitconfig` or `~/.config/gh`. The only file written is
 *     `<codexHome>/config.toml`, which is Codex-scoped.
 *   - `inherit = "core"` so a stray parent `GIT_CONFIG_COUNT` (e.g. from a
 *     nested Claude Code session) can't bleed into our slot mapping.
 *   - Rotation-safe by indirection: the env values are STATIC (helper path, gh
 *     config-dir path). The rotating token lives in `config.json` (the helper
 *     reads it live) and in the gh session `hosts.yml` (the daemon rewrites it;
 *     gh re-reads per call). No token is ever baked into config.toml.
 *   - Surgical merge: the user's unrelated config.toml keys, tables, and `set`
 *     vars are preserved. Only the keys we manage are added/removed.
 *
 * Tradeoff: a full smol-toml parse/stringify round-trip does NOT preserve
 * comments. We accept this — a hand-rolled sentinel block would risk emitting a
 * SECOND `[shell_environment_policy]` table (a duplicate-table TOML error that
 * would break Codex) when the user already has one. Correct merge > comments.
 */

/** Env-var names that compose the git credential-helper slot mapping. Slots run
 * 0-12 at the maximum: 0-6 credential-helper, 7-10 the SSH->HTTPS rewrite (rules
 * 1-4: 2 host-level insteadOf + 2 full-repo-path identity insteadOf/pushInsteadOf
 * when the repo is known), 11-12 author identity. We always enumerate the full
 * range so a transition (rewrite toggled, repo/author dropped) removes stale
 * higher slots on the next install. */
function gitSlotKeys(): string[] {
  const keys: string[] = ['GIT_CONFIG_COUNT'];
  for (let i = 0; i <= 12; i++) {
    keys.push(`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`);
  }
  return keys;
}

/** Every env-var name Spellguard manages inside `shell_environment_policy.set`. */
const MANAGED_SET_KEYS: readonly string[] = [...gitSlotKeys(), 'GH_CONFIG_DIR'];

function configTomlPath(codexHome?: string): string {
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'config.toml');
}

/** Return a shallow copy of `obj` with `keys` removed (avoids the `delete`
 * operator, which biome flags for the object-shape deopt). */
function omit(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !drop.has(k)));
}

/**
 * Build the ordered `GIT_CONFIG_*` slot map (string values, since env vars are
 * strings). Mirrors `env-file-writer.ts` exactly: clear inherited helpers
 * (empty value) then add ours; `useHttpPath` so the helper routes per-org by
 * the repo-owner path segment; then (when enabled) the SSH->HTTPS rewrite slots
 * (rules 1/2 host-level always; rules 3/4 full-repo-path identity when the repo
 * is known), then author identity. Indices and GIT_CONFIG_COUNT are computed
 * from a running counter so the appended sections shift cleanly:
 *   0-6   credential-helper slots
 *   7-10  SSH->HTTPS rewrite (2 or 4, when `sshRewrite`)
 *   next  user.name / user.email (when both author fields supplied)
 */
function buildGitSlots(
  helperPath: string,
  gitAuthorName?: string,
  gitAuthorEmail?: string,
  sshRewrite: boolean = isSshRewriteEnabled(),
  sshRewriteRepo?: RepoIdentity,
): Record<string, string> {
  const hasAuthor = Boolean(gitAuthorName) && Boolean(gitAuthorEmail);
  const set: Record<string, string> = {
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: helperPath,
    GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_3: helperPath,
    GIT_CONFIG_KEY_4: 'credential.https://gist.github.com.helper',
    GIT_CONFIG_VALUE_4: '',
    GIT_CONFIG_KEY_5: 'credential.https://gist.github.com.helper',
    GIT_CONFIG_VALUE_5: helperPath,
    GIT_CONFIG_KEY_6: 'credential.https://github.com.useHttpPath',
    GIT_CONFIG_VALUE_6: 'true',
  };
  let idx = 7;
  if (sshRewrite) {
    for (const rule of sshRewriteEntries(sshRewriteRepo)) {
      set[`GIT_CONFIG_KEY_${idx}`] = rule.key;
      set[`GIT_CONFIG_VALUE_${idx}`] = rule.value;
      idx++;
    }
  }
  if (hasAuthor) {
    set[`GIT_CONFIG_KEY_${idx}`] = 'user.name';
    set[`GIT_CONFIG_VALUE_${idx}`] = gitAuthorName as string;
    idx++;
    set[`GIT_CONFIG_KEY_${idx}`] = 'user.email';
    set[`GIT_CONFIG_VALUE_${idx}`] = gitAuthorEmail as string;
    idx++;
  }
  // GIT_CONFIG_COUNT first for byte-stable, deterministic output.
  return { GIT_CONFIG_COUNT: String(idx), ...set };
}

/** Parse the existing config.toml, or `{}` when absent / unparseable (we never
 * clobber a malformed file — see install/clear guards). */
function readConfig(path: string): {
  cfg: Record<string, unknown>;
  exists: boolean;
  parsed: boolean;
} {
  if (!existsSync(path)) return { cfg: {}, exists: false, parsed: true };
  try {
    return {
      cfg: parse(readFileSync(path, 'utf-8')) as Record<string, unknown>,
      exists: true,
      parsed: true,
    };
  } catch {
    return { cfg: {}, exists: true, parsed: false };
  }
}

/** Atomic write (temp + rename) so a concurrent Codex startup never reads a
 * half-written config.toml. New files are 0600 (owner-only). */
function writeConfig(path: string, cfg: Record<string, unknown>): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.spellguard.tmp`;
  writeFileSync(tmp, stringify(cfg), { mode: 0o600 });
  renameSync(tmp, path);
}

export interface CodexShellEnvPolicyArgs {
  /** Absolute path to the bundled `spellguard-git-helper`. */
  helperPath: string;
  /**
   * Per-agent gh config dir (`GH_CONFIG_DIR`). When supplied it is (re)written;
   * when omitted an existing pin is PRESERVED (the daemon's rotation path may
   * refresh the git slots without re-deriving the gh dir). Cleared by
   * `clearCodexShellEnvPolicy`.
   */
  ghConfigDir?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  /**
   * Include the session-scoped SSH->HTTPS `insteadOf` rewrite slots. Defaults to
   * `isSshRewriteEnabled()` (on unless `SPELLGUARD_SSH_REWRITE` is
   * 0/off/false/no). See `git-insteadof-rules.ts`.
   */
  sshRewrite?: boolean;
  /**
   * Origin repo identity (case-preserved owner/repo). When supplied AND
   * `sshRewrite` is on, adds the full-repo-path IDENTITY rules (3 & 4) that
   * out-specify a user's global force-SSH rule. Set by session-start when
   * handling a detected SSH remote. See `git-insteadof-rules.ts`.
   */
  sshRewriteRepo?: RepoIdentity;
  /** Override `~/.codex` (CODEX_HOME) — tests point this at a temp dir. */
  codexHome?: string;
}

/**
 * Install / refresh the Spellguard `[shell_environment_policy]` block. Idempotent
 * — a second identical call yields a byte-identical config.toml.
 */
export function installCodexShellEnvPolicy(
  args: CodexShellEnvPolicyArgs,
): void {
  const path = configTomlPath(args.codexHome);
  const { cfg, exists, parsed } = readConfig(path);
  // Refuse to clobber a config.toml we couldn't parse — Codex itself can't run
  // with a malformed config, so the user has a louder signal already.
  if (exists && !parsed) return;

  const sepRaw = cfg.shell_environment_policy;
  const sep =
    sepRaw && typeof sepRaw === 'object'
      ? (sepRaw as Record<string, unknown>)
      : {};
  const existingSet =
    sep.set && typeof sep.set === 'object'
      ? (sep.set as Record<string, unknown>)
      : {};

  // Keep the user's own `set` vars; drop every key we manage (canonical
  // ordering, and so an author→no-author transition removes stale slots 7/8).
  const userVars = omit(existingSet, MANAGED_SET_KEYS);
  const existingGh = existingSet.GH_CONFIG_DIR;
  const effectiveGh =
    args.ghConfigDir ??
    (typeof existingGh === 'string' ? existingGh : undefined);

  // Fixed key order: user vars, then our git slots, then GH_CONFIG_DIR last —
  // makes repeated identical installs byte-stable (idempotency).
  const nextSet: Record<string, unknown> = {
    ...userVars,
    ...buildGitSlots(
      args.helperPath,
      args.gitAuthorName,
      args.gitAuthorEmail,
      args.sshRewrite,
      args.sshRewriteRepo,
    ),
  };
  if (effectiveGh) nextSet.GH_CONFIG_DIR = effectiveGh;

  cfg.shell_environment_policy = {
    ...omit(sep, ['inherit', 'set']),
    inherit: 'core',
    set: nextSet,
  };

  writeConfig(path, cfg);
}

/**
 * Remove the Spellguard-managed keys on a full revoke / reset. Only our keys go
 * — the user's unrelated `set` vars and tables survive. When nothing of the
 * user's remains in the block, the whole `[shell_environment_policy]` table is
 * dropped so we leave no footprint.
 */
export function clearCodexShellEnvPolicy(args?: { codexHome?: string }): void {
  const path = configTomlPath(args?.codexHome);
  const { cfg, exists, parsed } = readConfig(path);
  if (!exists || !parsed) return; // nothing to clear / don't touch malformed

  const sepRaw = cfg.shell_environment_policy;
  if (!sepRaw || typeof sepRaw !== 'object') return;
  const sep = sepRaw as Record<string, unknown>;

  const existingSet =
    sep.set && typeof sep.set === 'object'
      ? (sep.set as Record<string, unknown>)
      : {};
  const userVars = omit(existingSet, MANAGED_SET_KEYS);

  // Rebuild the block without our managed `set` keys (and without `set` at all
  // when only ours were there).
  const rebuilt: Record<string, unknown> =
    Object.keys(userVars).length > 0
      ? { ...sep, set: userVars }
      : omit(sep, ['set']);

  // If only our `inherit = "core"` is left (no `set`, no user keys), drop the
  // whole table — full footprint removal. (stringify can't serialize an
  // `undefined`, so omit the key entirely rather than nulling it.)
  const nonInherit = Object.keys(rebuilt).filter((k) => k !== 'inherit');
  const cleaned =
    nonInherit.length === 0
      ? omit(cfg, ['shell_environment_policy'])
      : { ...cfg, shell_environment_policy: rebuilt };

  writeConfig(path, cleaned);
}
