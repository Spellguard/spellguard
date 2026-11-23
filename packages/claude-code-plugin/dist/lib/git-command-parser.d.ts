/**
 * Shell-aware git-command parsing.
 *
 * The first implementation substring-matched (`cmd.includes('git push')`), the
 * second split the raw string on `&&|;|\|` and anchored a regex at each piece.
 * Both read the command as TEXT. That is the defect behind #793: the separator
 * split runs BEFORE any quote handling, so it cuts inside single-quoted
 * arguments and heredoc bodies, and a `git push` that is only ever DATA —
 * a markdown table cell being written to a file, a script handed to
 * `tmux send-keys` — is classified as a real mutation. A doc mentioning two
 * pushes then looked like two mutation targets, attribution failed, and the
 * hook blocked a command that never touched GitHub while reporting a
 * credential problem that did not exist.
 *
 * So: TOKENIZE FIRST, then segment. `tokenizeShellCommand` walks the command
 * once, honouring quotes (including `$'…'`), backslash escapes, `#` comments,
 * `$(...)`/backtick substitution, redirections, heredoc bodies and subshell
 * parentheses, and emits a list of segments, each a list of expanded words.
 * Every classifier here — and the mutation-target resolver in
 * `github-command-target.ts`, which used to carry its own copy of the
 * separator regex — reads those segments, so both agree on what a command
 * actually runs.
 *
 * FAIL CLOSED WHEN THE TOKENIZER CANNOT PARSE. `tokenizeShellCommand` returns
 * `null` for a command it cannot read (an unterminated quote or substitution).
 * `null` means "I do not know what this runs", NEVER "nothing here": every
 * classifier below falls back to a cheap raw-text scan and answers
 * conservatively — `detectGitOp` returns the distinct `'unparseable'` op, which
 * the hook turns into an ATTRIBUTION block, and the two Bash-edit-capture
 * predicates return `true` so the capture skips rather than crediting foreign
 * content to the agent.
 *
 * Scope, deliberately: a word is inspected only in COMMAND POSITION, with one
 * level of unwrapping for `sh|bash|zsh|dash|ksh -c <script>` (including the
 * bundled `-lc` / `-ec` / `-xc` spellings) and `eval`. A git
 * mutation reached any other indirect way is not classified here and is not
 * meant to be. Command position does see through the common prefixes
 * (`command`, `exec`, `time`, `timeout N`, `nohup`, `sudo`, `env`, `xargs`)
 * and the reserved words that open a command (`{ …; }`, `!`, `if`/`then`/
 * `else`/`elif`, `do`, `while`/`until`); see `commandWordIndex` (#821). The
 * known non-classified class is interpreter-wrapped calls (`python -c`,
 * `node -e` and the like), which only the helper sees. This parser decides
 * what to OBSERVE and what to attribute a credential to; the Spellguard git
 * credential helper, which git itself invokes per (owner, repository), remains
 * the authoritative gate.
 */
export type GitOp = 'push' | 'checkout_new_branch' | 'switch_new_branch' | 'commit'
/** The command could not be tokenized but its text mentions a git mutation. */
 | 'unparseable' | null;
/** One `&&`/`||`/`;`/`|`/newline-delimited piece of a command, tokenized. */
export interface ShellSegment {
    /** Words in order, quotes removed, redirections and heredocs stripped. */
    words: string[];
    /**
     * Segments of a `sh -c <script>` / `eval` payload, tokenized one level deep.
     * They run in a subshell, so a directory change inside them does not escape.
     */
    nested?: ShellSegment[];
    /**
     * A subshell boundary rather than a command. `(` opens and `)` closes, and a
     * `cd` between them does not survive the closing paren.
     */
    subshell?: 'open' | 'close';
}
/**
 * Tokenize a shell command into separator-delimited segments of words.
 *
 * Returns `null` when the command cannot be tokenized. Callers must treat
 * `null` as "I do not know what this runs" and fail closed.
 *
 * `depth` is internal: a `-c` payload is unwrapped exactly one level, so a
 * script that spawns a shell that spawns a shell stops being followed.
 */
export declare function tokenizeShellCommand(command: string, depth?: number): ShellSegment[] | null;
/**
 * Index of `name` in command position. Returns -1 when the segment runs
 * something else.
 *
 * Skipped before the command word, in any order and repeated: leading
 * `VAR=value` assignments, the opening reserved words above, and the prefix
 * commands `sudo`, `env`, `command`, `exec`, `time`, `nohup`, `timeout <n>`
 * and `xargs`, with their options (#821). `xargs <cmd>` runs `<cmd>` with
 * arguments read from stdin that this parser can't see, so only the visible
 * ones inform attribution. `command -v` / `-V` only looks a command up
 * without running it, so it answers -1.
 */
export declare function commandWordIndex(words: string[], name: string): number;
export interface GitCommandHead {
    /** Directories named by `-C`, in order, each relative to the previous. */
    chdirs: string[];
    /**
     * True when a global option other than `-C` and the paging flags was
     * present. Those can rewrite `remote.<name>.url`, relocate the git dir, or
     * install a different credential helper, so a mutation carrying one cannot
     * be attributed to a remote read from the working directory.
     */
    redirected: boolean;
    /** The git subcommand, or undefined when the segment is only options. */
    subcommand?: string;
    /** Words after the subcommand. */
    args: string[];
}
/** Parse a tokenized segment as a `git` invocation, or return null. */
export declare function parseGitCommand(words: string[]): GitCommandHead | null;
/** Every segment, including the ones inside an unwrapped `-c` payload. */
export declare function flattenShellSegments(segments: ShellSegment[]): ShellSegment[];
/**
 * Segment the command and classify the first git mutation in COMMAND position.
 * A command whose text merely mentions a mutation — inside a quoted argument, a
 * heredoc body, a `#` comment, or a command substitution — is not a mutation.
 *
 * Returns `'unparseable'` when the command could not be tokenized at all AND
 * its raw text mentions a git mutation. That is not the same as "no git op":
 * the caller must block on it rather than wave the command through.
 */
export declare function detectGitOp(cmd: string): GitOp;
/**
 * True when a segment runs `gh pr create` in command position — or when the
 * command could not be tokenized and its raw text mentions one.
 */
export declare function detectGhPrCreate(cmd: string): boolean;
/** True when the tokenized segment runs `gh pr create`. */
export declare function isGhPrCreate(words: string[]): boolean;
/**
 * True if any segment of the command is a tree-materializing git op (merge,
 * rebase, cherry-pick, revert, pull, reset, restore, stash pop/apply, or a
 * non-new-branch checkout/switch), accounting for `git -C`/`sudo`/`env`
 * prefixes. The capture skips entirely for these so it never credits foreign
 * content (a colleague's branch, a stash, an upstream pull) to the agent.
 *
 * An unreadable command whose text mentions one of those subcommands answers
 * `true`: skipping a capture costs an attribution, crediting a colleague's
 * merged work to the agent is a wrong one.
 */
export declare function detectTreeMaterializingGitOp(cmd: string): boolean;
/**
 * True if a `git commit --amend` appears in the command, or if the command is
 * unreadable and its text carries both. `true` makes the capture skip the
 * committed-set synthesis, which is the conservative direction.
 */
export declare function isAmendCommit(cmd: string): boolean;
