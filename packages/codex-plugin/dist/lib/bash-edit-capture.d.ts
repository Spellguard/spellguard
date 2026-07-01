import { openEditStore } from './edit-store';
type Store = ReturnType<typeof openEditStore>;
export interface BashEditCaptureDeps {
    /** Runs `git <args>` in the repo root; returns stdout or null on failure. */
    gitExec?: (args: string[]) => string | null;
    /** Reads a file as raw bytes; returns null if it can't be read. */
    readFileBytes?: (absPath: string) => Buffer | null;
    /** Returns a file's mtime in ms since epoch, or null if it doesn't exist. */
    statMtimeMs?: (absPath: string) => number | null;
    /** True if the path is a symlink (capture refuses to follow symlinks). */
    isSymlink?: (absPath: string) => boolean;
    /** Resolves a path to its canonical (symlink-free) form, or null on failure. */
    realPath?: (p: string) => string | null;
    /** Opens the edit store (lazily — only when there is something to record). */
    openStore?: () => Store;
    /** Current time in ms; injectable for deterministic tests. */
    nowMs?: number;
}
export interface BashEditCaptureInput {
    /** Root dir under which the edit store lives (e.g. `~/.spellguard`). */
    editsRootDir: string;
    /** Repository root (resolveGitRoot of the hook cwd). */
    gitRoot: string;
    sessionId: string;
    agentId: string;
    /** True when the Bash command that just ran created a commit. */
    isCommit: boolean;
    /**
     * Real start time of the Bash command (ms), captured by the PreToolUse hook.
     * Primary source for the command window — robust to `duration_ms` being
     * absent. When set, the window is [commandStartedAtMs - slack, now].
     */
    commandStartedAtMs?: number;
    /** PostToolUse `duration_ms` for the command — fallback window source only. */
    durationMs?: number;
    /**
     * Skip the committed-file candidate set (the `isCommit` HEAD diff). Set for
     * MERGE commits (combined diff / multi-parent baseline is ambiguous and the
     * downstream parser can't read it) and AMEND commits (HEAD^ spans the
     * pre-amend commit). The dirty-set pass on the writing command already
     * captured genuine agent edits; only the commit-time synthesis is skipped.
     */
    skipCommittedSet?: boolean;
    deps?: BashEditCaptureDeps;
}
export interface BashEditCaptureResult {
    recorded: number;
    truncated: boolean;
}
/**
 * Parse `git status --porcelain=v1 -z --no-renames` output into the set of
 * paths with working-tree content worth reconciling (modified, added,
 * untracked). Skipped: pure deletions (no content to attribute) and UNMERGED
 * conflict states (`U` in either column, plus `AA`/`DD`) — a conflict's content
 * comes from the merge, not from the agent typing this command.
 */
export declare function parsePorcelainZ(out: string): string[];
/**
 * Reconcile the git working tree against the agent-edit ledger and record the
 * file changes this Bash command produced. Never throws — all failure modes log
 * to stderr and return what was recorded so far. See the module header for the
 * accuracy model.
 */
export declare function captureBashEdits(input: BashEditCaptureInput): Promise<BashEditCaptureResult>;
export {};
