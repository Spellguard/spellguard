import { type RepoIdentity } from './git-insteadof-rules';
/**
 * Copy the bundled (versioned) git-helper to a STABLE, version-independent path
 * under the per-framework config dir, and return that path. The session env bakes
 * THIS path — not the versioned plugin-install dir — so a resumed session survives
 * a plugin upgrade: the old version dir is deleted, but this copy persists. The
 * helper resolves `<framework>/git-tokens` by absolute XDG path, so it works
 * wherever it lives. Idempotent (overwrites each call, keeping the logic current).
 * Degrades to the bundled path on any copy failure — never break git auth over it.
 */
export declare function ensureStableHelper(configDir: string): string;
export interface EnvFileSpec {
    envFilePath: string;
    helperPath?: string;
    gitAuthorName?: string;
    gitAuthorEmail?: string;
    ghConfigDir?: string;
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
export declare function writeGitConfigEnv(spec: EnvFileSpec): void;
export declare function clearGitConfigEnv(envFilePath: string): void;
