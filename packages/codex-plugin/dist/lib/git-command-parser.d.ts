/**
 * Tokenized git-command detection.
 *
 * The earlier implementation used `cmd.includes('git push')` which would match
 * `echo "git push"`, `git pushover`, etc. This module tokenizes the command
 * on shell separators (`&&`, `;`, `|`), trims each segment, and matches each
 * segment's head against anchored regexes for git operations we care about.
 *
 * Known limitation: commands nested inside quoted strings (e.g.
 * `echo "git checkout -b foo"`) are NOT inspected by the quote-stripper. This
 * is acceptable — the parser is advisory; if a developer hand-rolls a shell
 * escape sequence to hide a git push, the emitted observation is still
 * optional (the Spellguard credential helper is the authoritative gate).
 */
export type GitOp = 'push' | 'checkout_new_branch' | 'switch_new_branch' | 'commit' | null;
export declare function detectGitOp(cmd: string): GitOp;
/**
 * True if any segment of the command is a tree-materializing git op (merge,
 * rebase, cherry-pick, revert, pull, reset, restore, stash pop/apply, or a
 * non-new-branch checkout/switch), accounting for `git -C`/`sudo`/`env`
 * prefixes. The capture skips entirely for these so it never credits foreign
 * content (a colleague's branch, a stash, an upstream pull) to the agent.
 */
export declare function detectTreeMaterializingGitOp(cmd: string): boolean;
/** True if a `git commit --amend` appears in the command. */
export declare function isAmendCommit(cmd: string): boolean;
