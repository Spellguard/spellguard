import type { RepoIdentity } from './git-insteadof-rules';
export declare function installCodexCredentialHelper(args: {
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
}): void;
export declare function clearCodexCredentialHelper(args?: {
    codexHome?: string;
}): void;
