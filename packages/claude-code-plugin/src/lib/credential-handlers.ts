// SPDX-License-Identifier: Apache-2.0

/**
 * Shared credential-event handlers for `AgentControlClient`.
 *
 * Extracted so both session-start.ts and the credential daemon
 * (`bin/spellguard-credential-daemon.ts`) can wire the same business
 * logic without creating a circular import.
 */

import type {
  ConfigUpdatedFrame,
  CredentialDeliveredFrame,
  CredentialRevokedFrame,
  CredentialRotatedFrame,
  GithubCredentialDescriptor,
} from '@spellguard/agent-control';
import type {
  GithubCredentialEntry,
  ReadConfigResult,
  SpellguardConfig,
} from './config-store';
import { clearGitConfigEnv, writeGitConfigEnv } from './env-file-writer';
import { clearGhSessionConfig, writeGhSessionConfig } from './gh-config-dir';
import { clearGhTokenFile, writeGhTokenFile } from './gh-token-file';
import type { RepoIdentity } from './git-insteadof-rules';
import { renderMessage } from './render-message';

/**
 * Phase C key for a GitHub credential in the org-keyed store: the lowercase
 * GitHub org login, or `__default` when the descriptor carries no
 * `github_org_login` (a pre-C / legacy single-org server).
 */
function githubEntryKey(orgLogin: string | undefined): string {
  return (orgLogin ?? '__default').toLowerCase();
}

/**
 * PR #338 review R2-016: rebuild the keyed credential map WITHOUT a stale
 * `__default` placeholder once a real org-keyed entry supersedes it. `__default`
 * is the legacy unkeyed slot (a descriptor with no github_org_login); once the
 * credential migrates to an org-keyed entry, a lingering `__default` inflates
 * keyedTotal to ≥2 and makes writeGitTokensFile suppress the single-org wildcard
 * (CR-004 gate), so legacy `path=`-less git fails closed for what is really a
 * single-org agent. Honor the rotation's `supersededId` when present; for an
 * unkeyed delivery (admin_reissue) the migration to a real org key is itself the
 * signal. Returns the map unchanged when there is nothing to drop. (Rebuilding
 * avoids the `delete` operator, which biome flags for the object-shape deopt.)
 */
function dropStaleDefaultKey(
  creds: Record<string, GithubCredentialEntry>,
  installedRealKey: boolean,
  supersededId: string | undefined,
): Record<string, GithubCredentialEntry> {
  const def = creds.__default as GithubCredentialEntry | undefined;
  const shouldDrop =
    Boolean(def) &&
    installedRealKey &&
    (supersededId === undefined || supersededId === def?.scopedTokenId);
  if (!shouldDrop) return creds;
  return Object.fromEntries(
    Object.entries(creds).filter(([key]) => key !== '__default'),
  );
}

/**
 * Keep the daemon-maintained `GH_TOKEN` file (`deps.ghTokenPath`) in lockstep
 * with the agent's current scoped token: write `token` when present, clear the
 * file otherwise. A no-op when no `ghTokenPath` is configured (older callers /
 * non-managed contexts). The managed login-shell snippet exports this file for
 * Claude Code's startup plugin-marketplace auto-update (see gh-token-file.ts).
 * Centralizing the write-or-clear here keeps the per-frame handlers below thin.
 */
function syncGhTokenFile(
  deps: CredentialHandlerDeps,
  token: string | undefined,
): void {
  if (!deps.ghTokenPath) return;
  if (token) writeGhTokenFile(deps.ghTokenPath, token);
  else clearGhTokenFile(deps.ghTokenPath);
}

export interface CredentialHandlerDeps {
  /** Path to the CLAUDE_ENV_FILE that receives git credential-helper exports. */
  envFilePath: string;
  /** Persist updated config to disk. */
  writeConfigImpl: (cfg: SpellguardConfig) => void;
  /** Mark the stored config as revoked. */
  markConfigRevokedImpl: () => void;
  /** Read current config (re-read on each call to avoid clobbering concurrent updates). */
  readConfigImpl: () => ReadConfigResult;
  /**
   * Per-agent gh session config dir (`<configDir>/gh/<agentId>`). When set, the
   * daemon refreshes its `hosts.yml` on credential update and clears it on
   * revoke so the gh CLI tracks the scoped token. Absent in contexts with no gh
   * pinning (older callers).
   */
  ghConfigDir?: string;
  /**
   * Path to the daemon-maintained `GH_TOKEN` file (`<configDir>/gh-token`, from
   * `ghTokenFilePath`). When set, the daemon writes the current org's scoped
   * token here on credential update/rotation and clears it on revoke, so the
   * managed login-shell snippet can export `GH_TOKEN` for Claude Code's STARTUP
   * auto-update of a PRIVATE plugin marketplace (which runs without git
   * credential helpers — see gh-token-file.ts). Single-org only; absent in
   * contexts with no managed auto-update path (older callers). Never logged.
   */
  ghTokenPath?: string;
  /**
   * Stable, version-independent path to the git-helper (from `ensureStableHelper`,
   * computed by the daemon from its config dir). Baked into the env so a resumed
   * session survives a plugin upgrade. When absent, the env writer falls back to
   * the bundled (versioned) path.
   */
  helperPath?: string;
  /**
   * Origin repo identity (case-preserved owner/repo) for the daemon's working
   * tree, resolved once at handler-deps construction via `resolveSshRewriteRepo`.
   * Threaded into the credential-update env write so token ROTATION regenerates
   * the full SSH->HTTPS rule set (1-4) — without it a rotation re-emits only the
   * host-level rules 1/2 and a user's global force-SSH rule would re-defeat the
   * rewrite until the next session start. Undefined when the daemon has no cwd or
   * the repo has no SSH (or force-SSH-effective) github remote.
   */
  sshRewriteRepo?: RepoIdentity;
}

/**
 * Handle a `credential_delivered` or `credential_rotated` frame.
 * Both frames carry the same payload shape and require the same local
 * update (write new token + author info, re-export env-file).
 *
 * Phase C (decision D13 / D6): a frame may carry MULTIPLE github descriptors —
 * one per GitHub org. Each is keyed by its lowercase `github_org_login` (or
 * `__default` when absent) and merged into the org-keyed `githubCredentials`
 * map. The legacy top-level `scopedToken`/`scopedTokenId`/`expiresAt` fields
 * are mirrored from the FIRST entry for one release (old helper binaries +
 * session-start checks still read them). The revoked-resurrection guard is
 * applied PER ENTRY (a revoked org refuses overwrite; a fresh org installs
 * cleanly), replacing the whole-config guard.
 */
export function handleCredentialUpdate(
  frame: CredentialDeliveredFrame | CredentialRotatedFrame,
  deps: CredentialHandlerDeps,
): void {
  const ghCreds = frame.credentials.filter(
    (c): c is GithubCredentialDescriptor =>
      c.provider === 'github' && Boolean(c.scoped_token),
  );
  if (ghCreds.length === 0) return; // redacted frame — auto-trigger handles it
  const cur = deps.readConfigImpl();
  if (!cur.config) return;

  const hadKeyedMap =
    cur.config.githubCredentials !== undefined &&
    Object.keys(cur.config.githubCredentials).length > 0;
  // Legacy single-slot back-compat: a pre-C config marked whole-config revoked
  // (no keyed map) must NOT be resurrected — the per-entry guards below only
  // apply once the keyed map exists. (CR-R2-009 regression pin.)
  if (!hadKeyedMap && cur.config.revoked) return;

  const githubCredentials: Record<string, GithubCredentialEntry> = {
    ...(cur.config.githubCredentials ?? {}),
  };

  let firstInstalled: {
    entry: GithubCredentialEntry;
    authorName: string;
    authorEmail: string;
  } | null = null;

  for (const ghCred of ghCreds) {
    const key = githubEntryKey(ghCred.github_org_login);
    // Refuse to resurrect a revoked org entry. A stray
    // credential_delivered{cause:'admin_reissue'} for an org that was just
    // revoked (e.g. queued during the daemon's grace window) must NOT bring
    // the dead per-org credential back to life.
    if (githubCredentials[key]?.revoked) continue;
    const entry: GithubCredentialEntry = {
      scopedToken: ghCred.scoped_token,
      scopedTokenId: ghCred.scoped_token_id ?? ghCred.credential_id,
      expiresAt: ghCred.expires_at,
      scopeSummary: ghCred.scope_summary,
      installationId: ghCred.installation_id,
      revoked: false,
    };
    githubCredentials[key] = entry;
    if (firstInstalled === null) {
      firstInstalled = {
        entry,
        authorName: ghCred.provider_data.git_author_name,
        authorEmail: ghCred.provider_data.git_author_email,
      };
    }
  }

  // Nothing installed (every descriptor targeted an already-revoked org) —
  // don't touch disk; the per-entry guards held.
  if (firstInstalled === null) return;

  // PR #338 review R2-016: drop a stale `__default` placeholder once a real
  // org-keyed entry supersedes it (see dropStaleDefaultKey) — a lingering legacy
  // entry inflates keyedTotal to ≥2 and suppresses the single-org wildcard
  // (CR-004 gate), failing closed for `path=`-less git.
  const supersededId =
    'superseded_scoped_token_id' in frame
      ? frame.superseded_scoped_token_id
      : undefined;
  const installedRealKey = ghCreds.some(
    (c) => githubEntryKey(c.github_org_login) !== '__default',
  );
  const finalGithubCredentials = dropStaleDefaultKey(
    githubCredentials,
    installedRealKey,
    supersededId,
  );

  // Mirror the FIRST freshly-installed entry into the legacy top-level fields
  // (back-compat shim — D6). Author identity stays single/global (D7): the
  // first credential's author info is the machine-wide git identity.
  deps.writeConfigImpl({
    ...cur.config,
    githubCredentials: finalGithubCredentials,
    scopedToken: firstInstalled.entry.scopedToken,
    scopedTokenId: firstInstalled.entry.scopedTokenId,
    expiresAt: firstInstalled.entry.expiresAt,
    scopeSummary: firstInstalled.entry.scopeSummary,
    agentId: ghCreds[0].agent_id,
    gitAuthorName: firstInstalled.authorName,
    gitAuthorEmail: firstInstalled.authorEmail,
    revoked: false,
  });
  // CLAUDE_ENV_FILE may be absent (daemon documents this as "skip env-file
  // updates"). Don't attempt a write to an empty path — the per-org token
  // selection lives in git-tokens, not the env-file.
  if (deps.envFilePath) {
    writeGitConfigEnv({
      envFilePath: deps.envFilePath,
      gitAuthorName: firstInstalled.authorName,
      gitAuthorEmail: firstInstalled.authorEmail,
      ghConfigDir: deps.ghConfigDir,
      helperPath: deps.helperPath,
      // Rotation must regenerate the full rule set, incl. the repo-specific
      // rules 3/4 (out-specify a force-SSH rule); else a force-SSH user reverts
      // to host-level rules after rotation. See git-insteadof-rules.ts.
      sshRewriteRepo: deps.sshRewriteRepo,
    });
  }
  // Pin the gh CLI to the scoped token: refresh the session hosts.yml with the
  // first installed org's token (gh holds one token per host). Rotation-safe —
  // gh re-reads this file on every invocation.
  if (deps.ghConfigDir && firstInstalled.entry.scopedToken) {
    writeGhSessionConfig({
      dir: deps.ghConfigDir,
      token: firstInstalled.entry.scopedToken,
    });
  }
  // Refresh the GH_TOKEN file with the FIRST installed org's token (the same one
  // mirrored into hosts.yml + the git-tokens wildcard) so the managed
  // login-shell snippet can export it for Claude Code's STARTUP auto-update of a
  // PRIVATE plugin marketplace. Single-org caveat documented in gh-token-file.ts.
  syncGhTokenFile(deps, firstInstalled.entry.scopedToken);
}

/**
 * Handle a `config_updated` frame by persisting the new provider
 * configuration descriptor to the local config-store under `providerConfig`.
 *
 * The caller is responsible for the follow-up rotation-timeout logic
 * (10s `setTimeout` → `requestRefresh` if no `credential_rotated` arrives).
 * This helper only performs the disk write.
 */
export function handleConfigUpdate(
  frame: ConfigUpdatedFrame,
  deps: CredentialHandlerDeps,
): void {
  const cur = deps.readConfigImpl();
  if (!cur.config) return;
  const providerConfig = {
    ...(cur.config.providerConfig ?? {}),
    [frame.config.provider]: frame.config,
  };
  deps.writeConfigImpl({ ...cur.config, providerConfig });
}

/**
 * Handle a `credential_revoked` frame.
 *
 * Phase C: revocation is PER ENTRY. The frame's `scoped_token_id` selects the
 * one org entry to mark revoked; the `git-tokens` file is regenerated (via the
 * config write) so only that org's line disappears while sibling orgs keep
 * pushing. The env-file is cleared and the WHOLE config marked revoked ONLY
 * when no unrevoked github entry remains.
 *
 * @returns `anyRemaining` — `true` if at least one unrevoked github entry
 *   survives (the daemon stays alive); `false` when the last entry died (the
 *   daemon's `onCredentialRevoked` then calls `shutdown()`).
 */
export function handleCredentialRevoked(
  frame: CredentialRevokedFrame,
  deps: CredentialHandlerDeps,
): boolean {
  const cur = deps.readConfigImpl();
  const keyed = cur.config?.githubCredentials;

  // Legacy single-slot config (no keyed map) — preserve the pre-C behaviour:
  // a revoke nukes the whole config. anyRemaining=false.
  if (!cur.config || !keyed || Object.keys(keyed).length === 0) {
    deps.markConfigRevokedImpl();
    try {
      clearGitConfigEnv(deps.envFilePath);
      if (deps.ghConfigDir) clearGhSessionConfig(deps.ghConfigDir);
      // Drop the GH_TOKEN file so no live token survives for the next `claude`
      // launch to export into auto-update.
      syncGhTokenFile(deps, undefined);
    } catch {
      /* ignore — env file may already be gone */
    }
    renderMessage({
      level: 'error',
      message:
        'Spellguard: credential revoked (push); subsequent git operations will fail until you re-run `/spellguard-setup` or restart Claude Code.',
    });
    return false;
  }

  // Mark ONLY the matching entry (by scoped_token_id) revoked.
  const next: Record<string, GithubCredentialEntry> = {};
  let matched = false;
  for (const [org, entry] of Object.entries(keyed)) {
    if (entry.scopedTokenId === frame.scoped_token_id) {
      matched = true;
      next[org] = { ...entry, revoked: true };
    } else {
      next[org] = entry;
    }
  }

  const anyRemaining = Object.values(next).some((e) => !e.revoked);

  if (anyRemaining) {
    // A sibling org survives: persist the per-entry revoke (this regenerates
    // git-tokens, dropping only the revoked org's line) and keep the daemon +
    // env-file alive. Do NOT mark the whole config revoked.
    //
    // PR #338 review M2: re-derive the legacy top-level mirror from the FIRST
    // surviving entry (OpenClaw's mirrorFirstGithubEntry semantics). The
    // revoked org may BE the mirrored one — spreading cur.config unchanged
    // would leave its revoked scopedToken on disk, where session-start /
    // knownCredentials consumers (and any legacy reader) still present it.
    const survivor = Object.values(next).find((e) => !e.revoked);
    deps.writeConfigImpl({
      ...cur.config,
      githubCredentials: next,
      scopedToken: survivor?.scopedToken,
      scopedTokenId: survivor?.scopedTokenId,
      expiresAt: survivor?.expiresAt,
      scopeSummary: survivor?.scopeSummary,
    });
    // Re-point the GH_TOKEN file at the surviving org's token (same re-derivation
    // as the legacy top-level mirror above) so it never keeps serving the REVOKED
    // org's token to a `claude` startup auto-update. If the survivor carries no
    // token, the helper drops the file. (Cross-org caveat applies — see
    // gh-token-file.ts: the survivor may not cover the marketplace repo's org.)
    syncGhTokenFile(deps, survivor?.scopedToken);
    renderMessage({
      level: 'error',
      message: matched
        ? 'Spellguard: one GitHub org credential was revoked; pushes to that org will fail. Other orgs are unaffected.'
        : 'Spellguard: a credential revocation arrived for an unknown token; no local change.',
    });
    return true;
  }

  // No unrevoked entry remains — tear the whole thing down (legacy semantics).
  deps.writeConfigImpl({ ...cur.config, githubCredentials: next });
  deps.markConfigRevokedImpl();
  try {
    clearGitConfigEnv(deps.envFilePath);
    // Drop the GH_TOKEN file so no live token survives the full teardown.
    syncGhTokenFile(deps, undefined);
  } catch {
    /* ignore — env file may already be gone */
  }
  renderMessage({
    level: 'error',
    message:
      'Spellguard: credential revoked (push); subsequent git operations will fail until you re-run `/spellguard-setup` or restart Claude Code.',
  });
  return false;
}

/**
 * Handle a fatal 4401 AUTH_FAILED close.
 *
 * 4401 on an established secret-mode channel means the server no longer
 * recognizes this agent (row deleted, or secret revoked). This is the
 * OFFLINE counterpart of `handleCredentialRevoked`: a daemon that wasn't
 * connected when the deletion happened never receives the frame — it learns
 * on the reconnect's auth failure instead (I12, plan Task 2.6). Mark the
 * config revoked so the next `/spellguard-setup` goes straight to fresh
 * provisioning and the SessionStart banner fires deterministically.
 *
 * Returns true when the close was a 4401 it acted on (caller still owns
 * process exit policy).
 */
export function handleAuthFailedClose(
  code: number,
  deps: CredentialHandlerDeps,
): boolean {
  if (code !== 4401) return false;
  deps.markConfigRevokedImpl();
  try {
    clearGitConfigEnv(deps.envFilePath);
    // The server no longer recognizes this agent — drop the GH_TOKEN file too so
    // a `claude` launch can't keep exporting the dead token into auto-update.
    syncGhTokenFile(deps, undefined);
  } catch {
    /* ignore — env file may already be gone */
  }
  renderMessage({
    level: 'error',
    message:
      'Spellguard: the server no longer recognizes this agent (auth failed). Local credentials were marked revoked — run `/spellguard-setup` to reconnect.',
  });
  return true;
}

/**
 * Recognize a WebSocket UPGRADE-time auth rejection (leg-B finding from the
 * 2026-06-11 deployed acceptance run): a DELETED agent's reconnect is
 * rejected by the HTTP lobby with a plain 401/403 BEFORE the socket ever
 * upgrades — the `ws` client surfaces it as an Error("Unexpected server
 * response: 401") and NO 4401 close frame arrives, so `onFatalClose` can
 * never fire. The daemon counts consecutive hits of this shape and treats
 * them as auth failure (the offline backstop's real-world path).
 */
export function isHandshakeAuthRejection(err: Error): boolean {
  return /Unexpected server response: 40[13]\b/.test(err?.message ?? '');
}
