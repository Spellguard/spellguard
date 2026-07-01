// SPDX-License-Identifier: Apache-2.0

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

export type GitOp =
  | 'push'
  | 'checkout_new_branch'
  | 'switch_new_branch'
  | 'commit'
  | null;

// Split on shell segment separators. `|&` and `||` collapse to either `|` or
// `&&`; the regex below handles both compound and simple cases.
const SEGMENT_RE = /&&|\|\||;|\|/g;

// Anchored heads. `\b` would accept `git.push` etc.; `\s+` enforces an actual
// whitespace-delimited token after `git`. A `-b`/`-B` flag for checkout/switch
// requires at least one trailing argument (the branch name), enforced with a
// further `\s+`.
const PUSH_RE = /^git\s+push(?:\s|$)/;
const CHECKOUT_NEW_BRANCH_RE = /^git\s+checkout\s+-[bB]\s+\S/;
// `git switch -c <name>` is the modern spelling; older `git switch -b <name>`
// is accepted by git for compatibility, so we treat both as switch_new_branch.
const SWITCH_NEW_BRANCH_RE = /^git\s+switch\s+-[bBc]\s+\S/;
// `git commit` without --help/-h. The negative lookahead prevents matching
// help invocations which are not real operations.
const COMMIT_RE = /^git\s+commit(?:\s|$)/;
const COMMIT_HELP_RE = /(?:^|\s)(--help|-h)(?:\s|$)/;

export function detectGitOp(cmd: string): GitOp {
  if (typeof cmd !== 'string' || cmd.length === 0) return null;
  const segments = cmd.split(SEGMENT_RE);
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    if (PUSH_RE.test(segment)) return 'push';
    if (CHECKOUT_NEW_BRANCH_RE.test(segment)) return 'checkout_new_branch';
    if (SWITCH_NEW_BRANCH_RE.test(segment)) return 'switch_new_branch';
    if (COMMIT_RE.test(segment) && !COMMIT_HELP_RE.test(segment))
      return 'commit';
  }
  return null;
}

// Git operations that MATERIALIZE existing content into the working tree from
// git objects / other refs / stashes — i.e. content that was NOT authored by
// the agent typing this command. The Bash-edit capture must NOT attribute the
// files these touch to the agent: their working-tree mtime becomes "now" (so
// the mtime gate alone would wrongly capture them), but the content came from
// a colleague's branch, a human's stash, an upstream pull, etc.
//
// New-branch creation (`checkout -b` / `switch -c`) is intentionally NOT here —
// it only moves a ref and leaves the working tree unchanged, so it never
// materializes foreign content. Plain `checkout`/`switch`/`restore` (no
// new-branch flag) DO change working-tree files and are treated as
// materializing.
const MATERIALIZE_RES: RegExp[] = [
  /^git\s+merge(?:\s|$)/,
  /^git\s+rebase(?:\s|$)/,
  /^git\s+cherry-pick(?:\s|$)/,
  /^git\s+revert(?:\s|$)/,
  /^git\s+pull(?:\s|$)/,
  /^git\s+reset(?:\s|$)/,
  /^git\s+restore(?:\s|$)/,
  /^git\s+stash\s+(?:pop|apply)(?:\s|$)/,
];
const NEW_BRANCH_FLAG_RE = /\s-[bBcC](?:\s|$)/;
const CHECKOUT_RE = /^git\s+checkout(?:\s|$)/;
const SWITCH_RE = /^git\s+switch(?:\s|$)/;

// A leading `sudo ` and/or `env VAR=val ...` wrapper, then `git`, then any
// number of git GLOBAL options (`-C <dir>`, `--git-dir[=]`, `--work-tree[=]`,
// `--namespace[=]`, `-c <kv>`, `--no-pager`, `-p`/`--paginate`, `--bare`).
// Stripping these exposes the real subcommand so `git -C sub merge x` is
// detected as `merge`, not missed.
// Option-value matcher: a shell token that may embed quoted segments with
// spaces — bare chars and/or '...'/"..." runs. So `git -C "my dir" merge` and
// `git -c user.name='A B' pull` (key=quoted-value) both strip cleanly to the
// subcommand.
const OPT_VAL = `(?:[^\\s'"]|'[^']*'|"[^"]*")+`;
const GIT_GLOBAL_OPT_RE = new RegExp(
  `^(?:-C\\s+${OPT_VAL}|--git-dir(?:=${OPT_VAL}|\\s+${OPT_VAL})|--work-tree(?:=${OPT_VAL}|\\s+${OPT_VAL})|--namespace(?:=${OPT_VAL}|\\s+${OPT_VAL})|-c\\s+${OPT_VAL}|--no-pager|--paginate|-p|--bare)\\s+`,
);
const SUDO_ENV_PREFIX_RE = /^(?:sudo\s+)?(?:env\s+(?:\w+=\S+\s+)+)?/;

/** Collapse `sudo`/`env`/git-global-option prefixes so the subcommand is first. */
function stripGitGlobalPrefix(segment: string): string {
  const s = segment.replace(SUDO_ENV_PREFIX_RE, '');
  const m = /^git\s+/.exec(s);
  if (!m) return segment; // not a git command — leave untouched
  let rest = s.slice(m[0].length);
  let prev: string;
  do {
    prev = rest;
    rest = rest.replace(GIT_GLOBAL_OPT_RE, '');
  } while (rest !== prev);
  return `git ${rest}`;
}

/**
 * True if any segment of the command is a tree-materializing git op (merge,
 * rebase, cherry-pick, revert, pull, reset, restore, stash pop/apply, or a
 * non-new-branch checkout/switch), accounting for `git -C`/`sudo`/`env`
 * prefixes. The capture skips entirely for these so it never credits foreign
 * content (a colleague's branch, a stash, an upstream pull) to the agent.
 */
export function detectTreeMaterializingGitOp(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  for (const rawSegment of cmd.split(SEGMENT_RE)) {
    const segment = stripGitGlobalPrefix(rawSegment.trim());
    if (segment.length === 0) continue;
    if (MATERIALIZE_RES.some((re) => re.test(segment))) return true;
    // checkout/switch materialize unless they create a NEW branch.
    if (
      (CHECKOUT_RE.test(segment) || SWITCH_RE.test(segment)) &&
      !NEW_BRANCH_FLAG_RE.test(segment)
    )
      return true;
  }
  return false;
}

const AMEND_RE = /(?:^|\s)--amend(?:\s|$|=)/;

/** True if a `git commit --amend` appears in the command. */
export function isAmendCommit(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  for (const rawSegment of cmd.split(SEGMENT_RE)) {
    const segment = rawSegment.trim();
    if (COMMIT_RE.test(segment) && AMEND_RE.test(segment)) return true;
  }
  return false;
}
