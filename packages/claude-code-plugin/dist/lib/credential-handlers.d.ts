/**
 * Shared credential-event handlers for `AgentControlClient`.
 *
 * Extracted so both session-start.ts and the credential daemon
 * (`bin/spellguard-credential-daemon.ts`) can wire the same business
 * logic without creating a circular import.
 */
import type { ConfigUpdatedFrame, CredentialDeliveredFrame, CredentialRevokedFrame, CredentialRotatedFrame } from '@spellguard/agent-control';
import type { ReadConfigResult, SpellguardConfig } from './config-store';
import type { RepoIdentity } from './git-insteadof-rules';
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
export declare function handleCredentialUpdate(frame: CredentialDeliveredFrame | CredentialRotatedFrame, deps: CredentialHandlerDeps): void;
/**
 * Handle a `config_updated` frame by persisting the new provider
 * configuration descriptor to the local config-store under `providerConfig`.
 *
 * The caller is responsible for the follow-up rotation-timeout logic
 * (10s `setTimeout` → `requestRefresh` if no `credential_rotated` arrives).
 * This helper only performs the disk write.
 */
export declare function handleConfigUpdate(frame: ConfigUpdatedFrame, deps: CredentialHandlerDeps): void;
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
export declare function handleCredentialRevoked(frame: CredentialRevokedFrame, deps: CredentialHandlerDeps): boolean;
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
export declare function handleAuthFailedClose(code: number, deps: CredentialHandlerDeps): boolean;
/**
 * Recognize a WebSocket UPGRADE-time auth rejection (leg-B finding from the
 * 2026-06-11 deployed acceptance run): a DELETED agent's reconnect is
 * rejected by the HTTP lobby with a plain 401/403 BEFORE the socket ever
 * upgrades — the `ws` client surfaces it as an Error("Unexpected server
 * response: 401") and NO 4401 close frame arrives, so `onFatalClose` can
 * never fire. The daemon counts consecutive hits of this shape and treats
 * them as auth failure (the offline backstop's real-world path).
 */
export declare function isHandshakeAuthRejection(err: Error): boolean;
