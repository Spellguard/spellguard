/**
 * /spellguard-reset — clean machine teardown (plan Task 0.2, I10).
 *
 * Until now there was NO way to cleanly tear an agent down from a machine:
 * local teardown meant kill-the-daemon + rm-the-config by hand, and the
 * server side needed manual SQL. This command does, in order:
 *
 *   1. `DELETE /v1/agents/self` (agent-secret auth) — soft-deletes the
 *      agent server-side, revokes its credentials, fans out
 *      credential_revoked frames. MUST run first: it needs the secret that
 *      step 3 deletes. 401/404/network failures are tolerated — the server
 *      side may already be gone (dashboard delete, env reset).
 *   2. Stop local credential daemons (pidfile-driven SIGTERM).
 *   3. Delete the local config.
 *
 * Idempotent and lost-secret tolerant by design: every step degrades to a
 * no-op rather than failing the teardown.
 */
import { type AuthSupersededCloseReason } from '@spellguard/agent-control';
import { installCodexCredentialHelper } from '../lib/codex-credential-helper-install';
import { type ReadConfigResult } from '../lib/config-store';
/**
 * Cause-specific message persisted on a self-wipe (P2-T6 / FR-10). Selected
 * from the 4409 close `cause` and written to `config.revokedMessage` so the
 * next SessionStart re-surfaces it.
 *
 * FR-10/FR-15/UT-008: `undefined` (absent or unrecognized cause) returns the
 * GENERIC message rather than the attached_elsewhere copy — the server sent a
 * code we don't recognise, so we must not assume which specific event occurred.
 */
export declare function supersededMessage(cause: AuthSupersededCloseReason | undefined): string;
export interface SupersededWipeArgs {
    cause: AuthSupersededCloseReason | undefined;
    /** Path to config.json (tests inject an isolated temp path). */
    configPath?: string;
    /**
     * Accepted for call-site parity with the Claude Code plugin's daemon (which
     * passes `CLAUDE_ENV_FILE` here). Codex has no per-session env file — it
     * clears its credential surface via `clearCodexCredentialHelper`
     * (`~/.codex/config.toml`) instead — so this is intentionally IGNORED.
     */
    envFilePath?: string;
    /** Per-agent gh session dir whose pinned hosts.yml is cleared. */
    ghConfigDir?: string;
    /** Override `~/.codex` / CODEX_HOME (tests). */
    codexHome?: string;
    /** Stable helper path supplied by the daemon. */
    helperPath?: string;
    /** Override the credential-wipe core (tests). */
    markConfigSupersededImpl?: (message: string) => void;
    /** Override the fail-closed Codex helper install (tests). */
    installCodexCredentialHelperImpl?: typeof installCodexCredentialHelper;
    /** Override the gh-session clear (tests). */
    clearGhSessionConfigImpl?: (dir: string) => void;
}
/**
 * NON-INTERACTIVE self-wipe of THIS machine's per-agent credentials, invoked
 * by the credential daemon from `onCredentialSuperseded` (the ONLY trigger —
 * close code 4409, NR-3). Unlike `runSpellguardReset` this performs NO server
 * deregistration (the server already superseded us — the move/reassign was
 * server-initiated) and NO daemon-stop (the daemon is the caller and closes
 * its own socket); it only clears the local credential surfaces the consuming
 * app reads and persists the cause message.
 *
 * Wipes ONLY this agent's credentials while preserving both identity and the
 * Codex-scoped helper/gh pin. Removing that policy here would let the next
 * Codex process start with ambient machine credentials before SessionStart can
 * rewrite config.toml. Explicit `$spellguard-reset` remains the only path that
 * removes the managed policy.
 */
export declare function wipeSupersededCredentials(args: SupersededWipeArgs): void;
export interface ResetArgs {
    fetchImpl?: typeof fetch;
    readConfigImpl?: () => ReadConfigResult;
    clearConfigImpl?: () => void;
    stopDaemons?: (opts?: {
        configDir?: string;
    }) => number[];
    configDir?: string;
}
export interface ResetResult {
    ok: boolean;
    reason?: string;
    /** True when the server acknowledged the deregistration. */
    deregistered: boolean;
    /** PIDs of daemons that were SIGTERMed. */
    stoppedDaemons: number[];
}
export declare function runSpellguardReset(args?: ResetArgs): Promise<ResetResult>;
