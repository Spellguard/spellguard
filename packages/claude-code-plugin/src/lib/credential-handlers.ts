// SPDX-License-Identifier: Apache-2.0

/**
 * Shared credential-event handlers for `AgentControlClient`.
 *
 * Extracted so both session-start.ts and the credential daemon
 * (`bin/spellguard-credential-daemon.ts`) can wire the same business
 * logic without creating a circular import.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConfigUpdatedFrame,
  CredentialDeliveredFrame,
  CredentialRevokedFrame,
  CredentialRotatedFrame,
  GithubCredentialDescriptor,
} from '@spellguard/agent-control';
import { isManagedBox } from '@spellguard/agent-control';
import type {
  GithubCredentialEntry,
  ReadConfigResult,
  SpellguardConfig,
} from './config-store';
import { clearGitConfigEnv, writeGitConfigEnv } from './env-file-writer';
import { clearGhSessionConfig, writeGhSessionConfig } from './gh-config-dir';
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

const RECOVERABLE_GITHUB_REVOKE_REASONS = new Set<
  CredentialRevokedFrame['reason']
>(['github_side_revoked', 'installation_revoked', 'refresh_token_expired']);

function githubReissueAfterFinalRevoke(
  frame: CredentialRevokedFrame,
): SpellguardConfig['githubReissue'] {
  return frame.provider === 'github' &&
    RECOVERABLE_GITHUB_REVOKE_REASONS.has(frame.reason)
    ? { pending: true }
    : undefined;
}

function finalGithubRevocationMessage(frame: CredentialRevokedFrame): string {
  return githubReissueAfterFinalRevoke(frame)
    ? 'Spellguard: GitHub credential revoked; git operations are blocked while Spellguard waits for a replacement credential.'
    : 'Spellguard: GitHub credential revoked; git operations are blocked. This terminal revocation will not request a replacement automatically.';
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
 * Unlink the LEGACY plaintext token file (`<configDir>/gh-token`) a pre-#767
 * plugin wrote on every delivery. Nothing writes or reads it any more — the
 * login-shell `GITHUB_TOKEN`/`GH_TOKEN` export it fed was removed because it
 * froze `gh` on a start-time snapshot — but a machine set up by an older plugin
 * still carries one, and every path that CLEARS the credential surface must
 * leave no readable token behind. Same one-shot cleanup `clearConfig` and the
 * superseded wipe perform. A no-op when no `configDir` is configured (older
 * callers).
 *
 * It swallows its own errors and every caller invokes it BEFORE the other
 * clears: this is fail-closed hygiene, so it must not be skipped because an
 * unrelated best-effort step (a gh-session clear, an env-file clear) threw
 * first, and it must not itself abort one.
 */
function removeLegacyGhTokenFile(deps: CredentialHandlerDeps): void {
  if (!deps.configDir) return;
  try {
    rmSync(join(deps.configDir, 'gh-token'), { force: true });
  } catch {
    /* best-effort — the file is normally already absent */
  }
}

/**
 * Re-assert the session's git credential-helper wiring after every GitHub token
 * has gone away, so git keeps routing through the Spellguard helper (which
 * fails closed once `git-tokens` is empty) instead of falling through to the
 * machine's ambient credentials. Mirrors the Codex plugin's
 * `installCodexCredentialHelper` re-install on the same path.
 *
 * Stands down on a managed box (R3-4 — the global placement is authoritative)
 * and when no `CLAUDE_ENV_FILE` is configured, matching
 * `handleCredentialUpdate`'s gates exactly.
 */
function reassertHelperWiring(
  deps: CredentialHandlerDeps,
  config: SpellguardConfig,
): void {
  const managed = (deps.isManagedBox ?? isManagedBox)();
  if (managed || !deps.envFilePath) return;
  writeGitConfigEnv({
    envFilePath: deps.envFilePath,
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
    ghConfigDir: deps.ghConfigDir,
    helperPath: deps.helperPath,
    sshRewriteRepo: deps.sshRewriteRepo,
  });
}

export interface CredentialHandlerDeps {
  /** Path to the CLAUDE_ENV_FILE that receives git credential-helper exports. */
  envFilePath: string;
  /** Persist updated config to disk. */
  writeConfigImpl: (cfg: SpellguardConfig) => void;
  /** Mark the stored config as revoked. */
  markConfigRevokedImpl: () => void;
  /**
   * #1348: drop every placed credential but keep the identity (a 4423
   * suspension). Optional: only the daemon handles a suspension.
   */
  markConfigSuspendedImpl?: () => void;
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
   * The plugin's config dir (`<configDir>`, the parent of `gh/<agentId>`). Used
   * ONLY to unlink the LEGACY plaintext `gh-token` file on the paths that clear
   * the credential surface — see `removeLegacyGhTokenFile`. Absent in contexts
   * that never had one (older callers); no handler writes anything under it.
   */
  configDir?: string;
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
  /**
   * R3-4: positive managed-mode gate. Defaults to the real R3-1 marker reader
   * (`isManagedBox()` from `@spellguard/agent-control`). TRUE ⇒ the daemon's
   * per-session SCOPED env-file injection stands down (the global placement is
   * authoritative; double-writing conflicts); the on-disk credential state is
   * still persisted. FALSE (the default — absent OR corrupt marker) ⇒ the scoped
   * env-file write runs as before (fail-closed — R3-6). Signal is the marker,
   * never ambient env (NEG-7). Injected so tests can pin a temp root.
   */
  isManagedBox?: () => boolean;
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
): boolean {
  const ghCreds = frame.credentials.filter(
    (c): c is GithubCredentialDescriptor =>
      c.provider === 'github' && Boolean(c.scoped_token),
  );
  if (ghCreds.length === 0) return false; // redacted frame — auto-trigger handles it
  const cur = deps.readConfigImpl();
  if (!cur.config) return false;

  const hadKeyedMap =
    cur.config.githubCredentials !== undefined &&
    Object.keys(cur.config.githubCredentials).length > 0;
  // Legacy single-slot back-compat: a pre-C config marked whole-config revoked
  // (no keyed map) must NOT be resurrected — the per-entry guards below only
  // apply once the keyed map exists. (CR-R2-009 regression pin.)
  if (!hadKeyedMap && cur.config.revoked) return false;

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
    // Refuse to resurrect the SAME revoked credential — a stray
    // credential_delivered{cause:'admin_reissue'} for the token that was just
    // revoked (e.g. queued during the daemon's grace window, or replayed by
    // Resume reconciliation) must NOT bring the dead credential back to life.
    //
    // The guard is keyed on the TOKEN ID, not the org. Keying it on the org
    // alone made the revoked flag TERMINAL: once an org was revoked, no future
    // credential for that org could ever install — so a backend rotation
    // minted a healthy replacement that the plugin then silently discarded,
    // and rotation (the lever every operator reaches for first) could never
    // recover the machine. Observed on a live agent 2026-08-04.
    const incomingId = ghCred.scoped_token_id ?? ghCred.credential_id;
    const existing = githubCredentials[key];
    if (existing?.revoked && existing.scopedTokenId === incomingId) continue;
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
  if (firstInstalled === null) return false;

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
    githubReissue: undefined,
  });
  // R3-4 standdown: on a managed box the per-session SCOPED env-file injection
  // stands down (the global placement is authoritative — a second scoped helper
  // written alongside the global one conflicts). The on-disk credential state
  // was still persisted above; only this injection leg is skipped. On every
  // non-managed box it runs as before (fail-closed — R3-6). Marker, not env
  // (NEG-7).
  const managed = (deps.isManagedBox ?? isManagedBox)();
  // CLAUDE_ENV_FILE may be absent (daemon documents this as "skip env-file
  // updates"). Don't attempt a write to an empty path — the per-org token
  // selection lives in git-tokens, not the env-file.
  if (!managed && deps.envFilePath) {
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
  return true;
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
 * pushing. When no unrevoked github entry remains, the local token consumers
 * are emptied but the agent identity and the pinned git-credential helper
 * remain, so the daemon can consume a different-ID replacement.
 *
 * A `credential_revoked` frame revokes a CREDENTIAL, not the agent identity.
 * Marking the whole config `revoked` here used to be terminal: SessionStart
 * short-circuited before spawning the daemon and `checkExpiryAndRefresh` exited
 * the daemon on boot, so a single-org agent whose token was revoked during a
 * rotation could never receive the replacement the backend had already minted
 * (observed on a live agent 2026-08-04). Identity death arrives on its own
 * channel — a 4401 close → `handleAuthFailedClose`.
 *
 * @returns `recoverable` — `true` when the identity remains capable of
 *   receiving a replacement; `false` only when no readable config exists.
 */
export function handleCredentialRevoked(
  frame: CredentialRevokedFrame,
  deps: CredentialHandlerDeps,
): boolean {
  const cur = deps.readConfigImpl();
  const keyed = cur.config?.githubCredentials;

  if (!cur.config) return false;

  // #1283: this framework places only GitHub credentials (delivery keeps
  // `provider === 'github'`), so a revoke for any other provider, e.g. an
  // admin removing a manual Discord credential, has nothing here to revoke.
  // Handled as a GitHub revoke, it cleared a legacy config's GitHub token.
  if (frame.provider !== 'github') return true;

  // Legacy single-slot config (no keyed map): drop the credential but retain
  // the agent-control identity AND the env-file helper wiring, so git keeps
  // routing through the Spellguard helper (which fails closed) instead of
  // falling through to whatever ambient credentials the machine happens to
  // have.
  if (!keyed || Object.keys(keyed).length === 0) {
    deps.writeConfigImpl({
      ...cur.config,
      scopedToken: undefined,
      scopedTokenId: undefined,
      expiresAt: undefined,
      scopeSummary: undefined,
      revoked: false,
      githubReissue: githubReissueAfterFinalRevoke(frame),
    });
    // Unlink a legacy plaintext token file so no readable token survives.
    removeLegacyGhTokenFile(deps);
    try {
      if (deps.ghConfigDir) clearGhSessionConfig(deps.ghConfigDir);
      reassertHelperWiring(deps, cur.config);
    } catch {
      /* best-effort — an empty helper state still serves no token */
    }
    renderMessage({
      level: 'error',
      message: finalGithubRevocationMessage(frame),
    });
    return true;
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
      githubReissue: undefined,
    });
    // Even with a survivor, a legacy plaintext file would still hold the
    // REVOKED org's token (it was single-valued and nothing refreshes it now).
    removeLegacyGhTokenFile(deps);
    renderMessage({
      level: 'error',
      message: matched
        ? 'Spellguard: one GitHub org credential was revoked; pushes to that org will fail. Other orgs are unaffected.'
        : 'Spellguard: a credential revocation arrived for an unknown token; no local change.',
    });
    return true;
  }

  // No unrevoked entry remains. Persist the per-entry revoke and clear every
  // token consumer, but KEEP the agent identity and the helper wiring so the
  // daemon can install a different-ID replacement the moment one is delivered.
  // `revoked` stays false: this is a dead credential, not a dead agent.
  deps.writeConfigImpl({
    ...cur.config,
    githubCredentials: next,
    scopedToken: undefined,
    scopedTokenId: undefined,
    expiresAt: undefined,
    scopeSummary: undefined,
    revoked: false,
    githubReissue: githubReissueAfterFinalRevoke(frame),
  });
  // Unlink a legacy plaintext token file so the teardown leaves none at rest.
  removeLegacyGhTokenFile(deps);
  try {
    if (deps.ghConfigDir) clearGhSessionConfig(deps.ghConfigDir);
    reassertHelperWiring(deps, cur.config);
  } catch {
    /* best-effort — an empty helper state still serves no token */
  }
  renderMessage({
    level: 'error',
    message: finalGithubRevocationMessage(frame),
  });
  return true;
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
  // The server disowned this agent — unlink a legacy plaintext token file too,
  // so a dead token cannot stay readable on disk.
  removeLegacyGhTokenFile(deps);
  try {
    clearGitConfigEnv(deps.envFilePath);
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
 * Handle an AGENT_SUSPENDED (4423) close (#1348): the agent is quarantined.
 *
 * Unlike a 4401, the agent is not gone: a release brings it back. Drop every
 * GitHub credential this plugin placed (config, `git-tokens`, the V5
 * authority, the gh session config, a legacy plaintext token file) and keep
 * the identity and the helper wiring, so git keeps routing through the helper
 * (which now serves nothing) and the daemon, which stays running, picks up
 * whatever the server delivers after the release. Returns false when there is
 * nothing wired to drop the config with.
 */
export function handleSuspended(deps: CredentialHandlerDeps): boolean {
  if (!deps.markConfigSuspendedImpl) return false;
  deps.markConfigSuspendedImpl();
  removeLegacyGhTokenFile(deps);
  try {
    if (deps.ghConfigDir) clearGhSessionConfig(deps.ghConfigDir);
  } catch {
    /* best-effort — the helper already serves nothing */
  }
  renderMessage({
    level: 'error',
    message:
      'Spellguard: this agent is quarantined. Its credentials were removed from this machine; it reconnects by itself once an admin releases it.',
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
