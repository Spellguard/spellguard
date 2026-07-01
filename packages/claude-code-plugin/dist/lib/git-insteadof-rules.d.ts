export interface GitConfigEntry {
    key: string;
    value: string;
}
export interface RepoIdentity {
    owner: string;
    repo: string;
}
/**
 * Rules 1 & 2 — host-level SSH->HTTPS conversion. Both SSH spellings of a
 * github.com remote map to the same HTTPS base. We use `insteadOf` (rewrites
 * BOTH fetch and push), not `pushInsteadOf`, so fetches/clones inside the
 * session also flow over HTTPS + the scoped token.
 */
export declare const SSH_TO_HTTPS_INSTEADOF: readonly GitConfigEntry[];
/**
 * Rules 3 & 4 — full-repo-path IDENTITY `insteadOf` + `pushInsteadOf`. These
 * out-specify a user's host/owner-level force-SSH rule via longest-prefix match
 * so the agent's repo stays HTTPS for both fetch and push. No-ops for users
 * without a force-SSH rule. `owner`/`repo` MUST preserve the remote's original
 * case (insteadOf matching is case-sensitive).
 */
export declare function repoIdentityInsteadOf(repo: RepoIdentity): GitConfigEntry[];
/**
 * The full ordered rule set to inject: rules 1 & 2 always, plus rules 3 & 4 when
 * the origin repo identity is known (i.e. we're handling a detected SSH remote).
 */
export declare function sshRewriteEntries(repo?: RepoIdentity): GitConfigEntry[];
/**
 * Whether the session-scoped SSH->HTTPS rewrite is enabled. Default ON — it is
 * strictly less invasive than the previous hard-stop and harmless for HTTPS
 * remotes (they don't match the SSH prefixes). Opt OUT by setting
 * `SPELLGUARD_SSH_REWRITE` to one of `0` / `off` / `false` / `no`
 * (case-insensitive); with the rewrite off, an SSH remote falls back to the
 * explicit "switch your remote to HTTPS" error, the prior behavior.
 */
export declare function isSshRewriteEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Build a `GIT_CONFIG_*` process-env map that applies ONLY the rewrite rules
 * (1-2, plus 3-4 when `repo` is given). Layer this over `process.env` and run
 * `git remote -v` to probe the EFFECTIVE remote URL the agent's git will see
 * (the rules combine with the user's own file config exactly as they will in the
 * real session). Used by the session-start backstop to decide whether the
 * rewrite actually takes effect or is defeated by an exotic rule / host alias.
 */
export declare function insteadOfGitConfigEnv(repo?: RepoIdentity): NodeJS.ProcessEnv;
