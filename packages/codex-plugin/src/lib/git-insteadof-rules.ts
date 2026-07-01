// SPDX-License-Identifier: Apache-2.0

// Session-scoped SSH->HTTPS git remote rewrite.
//
// An SSH GitHub remote (`git@github.com:owner/repo.git` or
// `ssh://git@github.com/owner/repo.git`) authenticates with SSH keys, so it
// bypasses git's HTTPS credential-helper chain entirely — which means the
// Spellguard scoped GitHub token is never used and a push goes out under
// whatever SSH key the host happens to have. Rather than hard-stop and make the
// user rewrite their stored remote, we inject git `insteadOf` / `pushInsteadOf`
// rules alongside the credential-helper override (env-file `GIT_CONFIG_*` for
// Claude Code; the `[shell_environment_policy]` block for Codex). git then
// transparently rewrites SSH GitHub URLs to HTTPS for the AGENT's git
// operations only — the user's stored remote, `~/.gitconfig`, and manual-shell
// git workflow are untouched.
//
// We inject FOUR rules (verified against real git 2.43 and the git-config man
// page — "When more than one insteadOf strings match a given URL, the longest
// match is used"; the same applies to pushInsteadOf):
//
//   1. insteadOf      git@github.com:           -> https://github.com/        (scp-style SSH; the base feature)
//   2. insteadOf      ssh://git@github.com/     -> https://github.com/        (ssh:// URL form)
//   3. insteadOf      https://github.com/<owner>/<repo> -> itself (IDENTITY)  (out-specify a host/owner-level force-SSH insteadOf)
//   4. pushInsteadOf  https://github.com/<owner>/<repo> -> itself (IDENTITY)  (out-specify a force-SSH pushInsteadOf — REQUIRED: pushInsteadOf wins for PUSH, so an insteadOf-only guard leaves PUSH on SSH)
//
// Rules 3 & 4 exist for the user who has a GLOBAL force-SSH rule
// (`url."git@github.com:".insteadOf/pushInsteadOf = https://github.com/`, common
// for Go private modules + submodules). Because git applies the LONGEST-matching
// rule once with no chaining, a full-repo-path IDENTITY rule (strictly longer
// than the user's host/owner-level prefix) WINS arbitration, so their force-SSH
// rule never fires for the agent's repo — fetch AND push stay HTTPS. We use the
// full repo path (not host- or owner-level) so we never rely on the UNDOCUMENTED
// equal-length tie-break. Rules 3 & 4 are pure no-ops for users without a
// force-SSH rule (the IDENTITY rewrite changes nothing). They are built from the
// actual parsed owner/repo of the origin remote, preserving its case (insteadOf
// matching is case-SENSITIVE), so they are only injected when we know the repo.
//
// Empirically verified git semantics (git 2.43):
//   - `insteadOf` is longest-prefix-match-and-replace, applied ONCE with no
//     chaining. An already-HTTPS remote does not match the SSH prefixes (rules
//     1/2), so it passes through UNCHANGED — existing HTTPS/PAT/`gh` users are
//     unaffected.
//   - A multi-valued key (two `insteadOf` values for one `url.<base>.` key) is
//     honored: both SSH spellings below are matched.
//   - `pushInsteadOf` takes precedence over `insteadOf` for the PUSH url; with
//     no `pushInsteadOf` set, push falls back to `insteadOf`. Hence rule 4.
//   - git ignores `pushInsteadOf` when an explicit `remote.<name>.pushurl` is
//     set (man page) — but `insteadOf` (rule 1) still rewrites an SSH pushurl of
//     the `git@github.com:` form, so that case is also covered. Only a pushurl
//     using an SSH HOST ALIAS escapes (handled by the backstop).
//   - git applies `protocol.allow` to the REWRITTEN url; HTTPS is allowed by
//     default, so the rewrite is unaffected (relevant only for submodules).
//
// The session-start BACKSTOP (`detectSshRemoteAfterRewrite`) re-probes the
// EFFECTIVE remote (`git remote -v`, fetch AND push) with the full rule set
// applied. With rules 1-4 this only still resolves to SSH for two genuinely
// exotic cases: (a) a force-SSH rule at equal-or-greater specificity on this
// exact repo path (a true tie we deliberately don't gamble on), or (b) an SSH
// HOST ALIAS (`git@github-work:`, a custom `~/.ssh/config` Host) that doesn't
// map to github.com. Those fall back to the explicit "switch your remote" error.

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
export const SSH_TO_HTTPS_INSTEADOF: readonly GitConfigEntry[] = [
  { key: 'url.https://github.com/.insteadOf', value: 'git@github.com:' },
  { key: 'url.https://github.com/.insteadOf', value: 'ssh://git@github.com/' },
];

/**
 * Rules 3 & 4 — full-repo-path IDENTITY `insteadOf` + `pushInsteadOf`. These
 * out-specify a user's host/owner-level force-SSH rule via longest-prefix match
 * so the agent's repo stays HTTPS for both fetch and push. No-ops for users
 * without a force-SSH rule. `owner`/`repo` MUST preserve the remote's original
 * case (insteadOf matching is case-sensitive).
 */
export function repoIdentityInsteadOf(repo: RepoIdentity): GitConfigEntry[] {
  const base = `https://github.com/${repo.owner}/${repo.repo}`;
  return [
    { key: `url.${base}.insteadOf`, value: base },
    { key: `url.${base}.pushInsteadOf`, value: base },
  ];
}

/**
 * The full ordered rule set to inject: rules 1 & 2 always, plus rules 3 & 4 when
 * the origin repo identity is known (i.e. we're handling a detected SSH remote).
 */
export function sshRewriteEntries(repo?: RepoIdentity): GitConfigEntry[] {
  const entries: GitConfigEntry[] = [...SSH_TO_HTTPS_INSTEADOF];
  if (repo) entries.push(...repoIdentityInsteadOf(repo));
  return entries;
}

/**
 * Whether the session-scoped SSH->HTTPS rewrite is enabled. Default ON — it is
 * strictly less invasive than the previous hard-stop and harmless for HTTPS
 * remotes (they don't match the SSH prefixes). Opt OUT by setting
 * `SPELLGUARD_SSH_REWRITE` to one of `0` / `off` / `false` / `no`
 * (case-insensitive); with the rewrite off, an SSH remote falls back to the
 * explicit "switch your remote to HTTPS" error, the prior behavior.
 */
export function isSshRewriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.SPELLGUARD_SSH_REWRITE;
  if (raw === undefined || raw.trim() === '') return true;
  return !/^(0|off|false|no)$/i.test(raw.trim());
}

/**
 * Build a `GIT_CONFIG_*` process-env map that applies ONLY the rewrite rules
 * (1-2, plus 3-4 when `repo` is given). Layer this over `process.env` and run
 * `git remote -v` to probe the EFFECTIVE remote URL the agent's git will see
 * (the rules combine with the user's own file config exactly as they will in the
 * real session). Used by the session-start backstop to decide whether the
 * rewrite actually takes effect or is defeated by an exotic rule / host alias.
 */
export function insteadOfGitConfigEnv(repo?: RepoIdentity): NodeJS.ProcessEnv {
  const entries = sshRewriteEntries(repo);
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach((entry, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = entry.key;
    env[`GIT_CONFIG_VALUE_${i}`] = entry.value;
  });
  return env;
}
