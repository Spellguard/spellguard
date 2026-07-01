/**
 * Parse an SSH-style git remote URL and extract the GitHub
 * owner/repo pair. Covers:
 *   - `git@github.com:owner/repo.git`
 *   - `git@github.com:owner/repo` (no .git suffix)
 *   - `git@github-work:owner/repo.git` (SSH alias via ~/.ssh/config)
 *   - `ssh://git@github.com/owner/repo.git`
 *
 * Returns `null` for anything that doesn't cleanly yield an `owner/repo`.
 */
export interface ParsedSshRemote {
    owner: string;
    repo: string;
}
export declare function parseSshRemote(remote: string): ParsedSshRemote | null;
