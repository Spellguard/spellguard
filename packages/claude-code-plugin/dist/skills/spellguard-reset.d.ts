import { type AuthSupersededCloseReason } from '@spellguard/agent-control';
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
    /** CLAUDE_ENV_FILE path whose Spellguard git-helper exports are cleared. */
    envFilePath?: string;
    /** Per-agent gh session dir whose pinned hosts.yml is cleared. */
    ghConfigDir?: string;
    /**
     * LEGACY plaintext token file (`<configDir>/gh-token`) to unlink. Nothing
     * writes it since #767 — the login-shell export it fed was removed because it
     * froze `gh` on a start-time token — but a machine set up by an older plugin
     * still carries one, and a superseded agent must not leave it on disk.
     */
    legacyGhTokenFile?: string;
    /** Override the credential-wipe core (tests). */
    markConfigSupersededImpl?: (message: string) => void;
    /** Override the env-file clear (tests). */
    clearGitConfigEnvImpl?: (envFilePath: string) => void;
    /** Override the gh-session clear (tests). */
    clearGhSessionConfigImpl?: (dir: string) => void;
    /** Override the legacy token-file unlink (tests). */
    clearGhTokenFileImpl?: (path: string) => void;
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
 * Reuses the same wipe internals as the interactive reset
 * (`markConfigSuperseded` → `writeConfig`/`writeGitTokensFile`,
 * `clearGitConfigEnv`, `clearGhSessionConfig`) rather than re-implementing the
 * wipe. Wipes ONLY this agent's credentials (identity is preserved so
 * `/spellguard-setup` can re-attach this machine).
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
