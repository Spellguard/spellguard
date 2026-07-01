import { type RepoIdentity } from './git-insteadof-rules';
export interface SshDetectionResult {
    hasSsh: boolean;
    sshRemoteUrl?: string;
}
export declare function detectSshRemote(cwd: string): SshDetectionResult;
/**
 * Re-detect SSH remotes as the agent's git will actually see them — i.e. with
 * the session-scoped SSH->HTTPS rewrite rules layered over the user's real git
 * config. `git remote -v` reports the EFFECTIVE (post-rewrite) URL for both
 * fetch and push, so this faithfully predicts the in-session result. Pass the
 * parsed origin `repo` so the probe includes the full-repo-path IDENTITY rules
 * (3 & 4) and correctly predicts a WIN over a user's global force-SSH rule.
 *
 * Used by the session-start backstop: when an SSH remote is detected, this tells
 * us whether the rewrite actually converts it to HTTPS for fetch AND push
 * (proceed) or is still SSH — defeated by a same-specificity force-SSH rule or
 * an SSH host alias like `git@github-work:` (fall back to the explicit
 * switch-your-remote error).
 *
 * Fails closed: if the probe `git` invocation throws, we report `hasSsh: true`
 * so the caller surfaces the actionable error rather than silently proceeding.
 */
export declare function detectSshRemoteAfterRewrite(cwd: string, repo?: RepoIdentity): SshDetectionResult;
/**
 * Derive the case-preserved `{owner, repo}` identity from an already-computed
 * SSH detection result. This is the SINGLE source of truth for the full-repo-
 * path IDENTITY rules (3 & 4): both session-start (with its possibly-mocked
 * detection result) and the daemon (`resolveSshRewriteRepo`) route through it so
 * they produce identical rules for the same repo. Returns `undefined` when no
 * SSH (or force-SSH-effective) github remote is present, or when the URL can't
 * be parsed (e.g. an SSH host alias).
 */
export declare function repoIdentityFromSshDetection(result: SshDetectionResult): RepoIdentity | undefined;
/**
 * Resolve the origin repo identity for a working tree by running the SSH-remote
 * detection and parsing the result. Used by the credential daemon so that token
 * ROTATION regenerates the full rule set (1-4) — without this, a rotation would
 * re-emit only the host-level rules 1/2 and a user's global force-SSH rule would
 * re-defeat the rewrite until the next session start. The daemon is
 * single-cwd-per-agent (see its header), so deriving from the spawn `cwd` is
 * exact for the repo it serves.
 */
export declare function resolveSshRewriteRepo(cwd: string): RepoIdentity | undefined;
