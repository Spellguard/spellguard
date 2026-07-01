// SPDX-License-Identifier: Apache-2.0

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

// user@host:owner/repo(.git) — host may be an alias like `github-work`.
const SCP_RE = /^[\w.-]+@([\w.-]+):([^/]+)\/([^/]+?)(?:\.git)?$/;
// ssh://user@host/owner/repo(.git)
const SSH_URL_RE = /^ssh:\/\/[\w.-]+@([\w.-]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/;

export function parseSshRemote(remote: string): ParsedSshRemote | null {
  if (typeof remote !== 'string' || remote.length === 0) return null;
  const trimmed = remote.trim();
  let m = SCP_RE.exec(trimmed);
  if (m) {
    const [, , owner, repo] = m;
    if (owner && repo) return { owner, repo };
  }
  m = SSH_URL_RE.exec(trimmed);
  if (m) {
    const [, , owner, repo] = m;
    if (owner && repo) return { owner, repo };
  }
  return null;
}
