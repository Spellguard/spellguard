export interface CommitEvent {
    sha: string;
    branch: string;
    authoredAt: string;
    authorName: string | null;
    authorEmail: string | null;
    committedAt: string | null;
    committerName: string | null;
    committerEmail: string | null;
    message: string;
    parentSha: string | null;
    parentShas: string[];
    workingDir: string;
}
/**
 * Resolve the absolute path of `.git/logs/HEAD` for the given working
 * directory using `git rev-parse --git-path`. This is worktree-safe: in a
 * `git worktree add` checkout `.git` is a FILE (not a directory), so the
 * naive `join(workingDir, '.git', 'logs', 'HEAD')` path does not exist. Git's
 * `--git-path` plumbing resolves through the gitdir pointer and returns the
 * real path in the main repo's `.git/worktrees/<name>/logs/HEAD`.
 *
 * Returns `null` if git is not available or the directory is not a git repo.
 *
 * Exposed for byte-offset reflog tracking so it can reuse the same
 * resolution logic without duplicating the rev-parse call.
 */
export declare function resolveReflogPath(workingDir: string): string | null;
export declare function startCommitWatcher(input: {
    workingDir: string;
    onCommit: (e: CommitEvent) => Promise<void>;
}): Promise<() => Promise<void>>;
