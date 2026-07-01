// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  type RepoIdentity,
  insteadOfGitConfigEnv,
} from './git-insteadof-rules';
import { canonicalizeGitRemote } from './git-remote-canonicalizer';
import { parseSshRemote } from './ssh-remote-parse';

export interface SshDetectionResult {
  hasSsh: boolean;
  sshRemoteUrl?: string;
}

function detectSshRemoteFromOutput(output: string): SshDetectionResult {
  const lines = output.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    // git remote -v output: "name<TAB>url (fetch|push)"
    const match = line.match(/^\S+\s+(\S+)\s+\(/);
    if (!match) continue;
    const url = match[1];
    const canon = canonicalizeGitRemote(url);
    if (canon?.isSsh) {
      return { hasSsh: true, sshRemoteUrl: url };
    }
    // Also flag SSH URLs whose host isn't github.com (still SSH and still bypasses helper).
    if (/^git@[\w.-]+:/.test(url) || url.startsWith('ssh://')) {
      return { hasSsh: true, sshRemoteUrl: url };
    }
  }
  return { hasSsh: false };
}

export function detectSshRemote(cwd: string): SshDetectionResult {
  try {
    const out = execFileSync('git', ['remote', '-v'], {
      encoding: 'utf-8',
      cwd,
    });
    return detectSshRemoteFromOutput(out);
  } catch {
    return { hasSsh: false };
  }
}

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
export function detectSshRemoteAfterRewrite(
  cwd: string,
  repo?: RepoIdentity,
): SshDetectionResult {
  try {
    const out = execFileSync('git', ['remote', '-v'], {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, ...insteadOfGitConfigEnv(repo) },
    });
    return detectSshRemoteFromOutput(out);
  } catch {
    return { hasSsh: true };
  }
}

/**
 * Derive the case-preserved `{owner, repo}` identity from an already-computed
 * SSH detection result. This is the SINGLE source of truth for the full-repo-
 * path IDENTITY rules (3 & 4): both session-start (with its possibly-mocked
 * detection result) and the daemon (`resolveSshRewriteRepo`) route through it so
 * they produce identical rules for the same repo. Returns `undefined` when no
 * SSH (or force-SSH-effective) github remote is present, or when the URL can't
 * be parsed (e.g. an SSH host alias).
 */
export function repoIdentityFromSshDetection(
  result: SshDetectionResult,
): RepoIdentity | undefined {
  if (!result.hasSsh || !result.sshRemoteUrl) return undefined;
  const parsed = parseSshRemote(result.sshRemoteUrl);
  return parsed ? { owner: parsed.owner, repo: parsed.repo } : undefined;
}

/**
 * Resolve the origin repo identity for a working tree by running the SSH-remote
 * detection and parsing the result. Used by the credential daemon so that token
 * ROTATION regenerates the full rule set (1-4) — without this, a rotation would
 * re-emit only the host-level rules 1/2 and a user's global force-SSH rule would
 * re-defeat the rewrite until the next session start. The daemon is
 * single-cwd-per-agent (see its header), so deriving from the spawn `cwd` is
 * exact for the repo it serves.
 */
export function resolveSshRewriteRepo(cwd: string): RepoIdentity | undefined {
  return repoIdentityFromSshDetection(detectSshRemote(cwd));
}
