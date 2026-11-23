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
    /**
     * Unused on Codex — retained for shape parity with the Claude Code
     * handler signature so future shared-package refactors can hoist a
     * single Deps type. The Codex handler installs the credential helper into
     * `~/.codex/config.toml` (`[shell_environment_policy]`), not an env file.
     */
    envFilePath: string;
    /**
     * Per-agent gh config dir (`GH_CONFIG_DIR`) — passed through to
     * `installCodexCredentialHelper` so a credential refresh that rewrites the
     * git slots keeps the gh pin. Omitted by callers that don't manage gh (an
     * existing pin is preserved); the daemon supplies it (see A5).
     */
    ghConfigDir?: string;
    /**
     * Stable, version-independent path to the git-helper (from `ensureStableHelper`,
     * computed by the daemon). Baked into the config.toml shell_environment_policy so
     * a resumed session survives a plugin upgrade. Falls back to the bundled path.
     */
    helperPath?: string;
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
     * Origin repo identity (case-preserved owner/repo) for the daemon's working
     * tree, resolved once at handler-deps construction via `resolveSshRewriteRepo`.
     * Threaded into the credential-update helper write so token ROTATION
     * regenerates the full SSH->HTTPS rule set (1-4) — without it a rotation
     * re-emits only the host-level rules 1/2 and a user's global force-SSH rule
     * would re-defeat the rewrite until the next session start. Undefined when the
     * daemon has no cwd or the repo has no SSH (or force-SSH-effective) github
     * remote. See `git-insteadof-rules.ts`.
     */
    sshRewriteRepo?: RepoIdentity;
    /**
     * R3-4: positive managed-mode gate. Defaults to the real R3-1 marker reader
     * (`isManagedBox()` from `@spellguard/agent-control`). TRUE ⇒ the daemon's
     * per-session SCOPED config.toml credential-helper install stands down (the
     * global placement is authoritative; double-writing conflicts); the on-disk
     * credential state is still persisted. FALSE (the default — absent OR corrupt
     * marker) ⇒ the scoped install runs as before (fail-closed — R3-6). Signal is
     * the marker, never ambient env (NEG-7). Injected so tests can pin a temp root.
     */
    isManagedBox?: () => boolean;
}
/**
 * Handle a `credential_delivered` or `credential_rotated` frame.
 * Both frames carry the same payload shape and require the same local
 * update (write new token + author info, install the credential helper).
 *
 * Phase C (decision D13 / D6): a frame may carry MULTIPLE github descriptors —
 * one per GitHub org. Each is keyed by its lowercase `github_org_login` (or
 * `__default` when absent) and merged into the org-keyed `githubCredentials`
 * map. The legacy top-level `scopedToken`/`scopedTokenId`/`expiresAt` fields
 * are mirrored from the FIRST entry for one release (old helper binaries +
 * session-start checks still read them). The revoked-resurrection guard is
 * applied PER ENTRY (a revoked org refuses overwrite; a fresh org installs
 * cleanly), replacing the whole-config guard.
 *
 * Codex installs routing via `git config --global` (the github.com-namespaced
 * helper + `useHttpPath=true`) rather than the env-file Claude Code uses; the
 * per-org token selection itself lives in the git-tokens file.
 */
export declare function handleCredentialUpdate(frame: CredentialDeliveredFrame | CredentialRotatedFrame, deps: CredentialHandlerDeps): boolean;
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
 * pushing. When no unrevoked github entry remains, the local token consumers
 * are emptied but the agent identity and pinned Codex helper remain so the
 * daemon can consume a different-ID replacement.
 *
 * @returns `recoverable` — `true` when the identity remains capable of
 *   receiving a replacement; `false` only when no readable config exists.
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
 * config revoked so the next `@spellguard-setup` goes straight to fresh
 * provisioning and the session-start banner fires deterministically.
 *
 * Returns true when the close was a 4401 it acted on (caller still owns
 * process exit policy).
 */
export declare function handleAuthFailedClose(code: number, deps: CredentialHandlerDeps): boolean;
/**
 * Handle an AGENT_SUSPENDED (4423) close (#1348): the agent is quarantined.
 *
 * Unlike a 4401, the agent is not gone: a release brings it back. Drop every
 * GitHub credential this plugin placed (config, `git-tokens`, the V5
 * authority, the gh session config) and keep the identity and the helper
 * wiring, so git keeps routing through the helper (which now serves nothing)
 * and the daemon, which stays running, picks up whatever the server delivers
 * after the release. Returns false when there is nothing wired to drop the
 * config with.
 */
export declare function handleSuspended(deps: CredentialHandlerDeps): boolean;
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
