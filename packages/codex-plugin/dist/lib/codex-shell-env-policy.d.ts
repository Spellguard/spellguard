import { type RepoIdentity } from './git-insteadof-rules';
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
export declare function installCodexShellEnvPolicy(args: CodexShellEnvPolicyArgs): void;
/**
 * Remove the Spellguard-managed keys on a full revoke / reset. Only our keys go
 * — the user's unrelated `set` vars and tables survive. When nothing of the
 * user's remains in the block, the whole `[shell_environment_policy]` table is
 * dropped so we leave no footprint.
 */
export declare function clearCodexShellEnvPolicy(args?: {
    codexHome?: string;
}): void;
