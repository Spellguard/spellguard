// SPDX-License-Identifier: Apache-2.0

// Canonicalize git remote URLs to (host, owner, repo) tuples.
// Returns null for non-github.com hosts. Sets isSsh true for ssh:// or git@host: forms.
// All comparisons downstream use lowercase owner/repo (GitHub repos are case-insensitive).

export interface CanonicalRemote {
  host: 'github.com';
  owner: string; // lowercase
  repo: string; // lowercase, .git stripped
  isSsh: boolean;
}

const GITHUB_HOST_ALIASES = new Set(['github.com', 'ssh.github.com']);

export function canonicalizeGitRemote(raw: string): CanonicalRemote | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  // SSH "git@host:owner/repo" form (no scheme)
  const sshShortMatch = trimmed.match(
    /^git@([\w.-]+):([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (sshShortMatch) {
    const host = sshShortMatch[1].toLowerCase();
    if (!GITHUB_HOST_ALIASES.has(host)) return null;
    return {
      host: 'github.com',
      owner: sshShortMatch[2].toLowerCase(),
      repo: sshShortMatch[3].toLowerCase(),
      isSsh: true,
    };
  }

  // Anything with a scheme: parse via URL
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!GITHUB_HOST_ALIASES.has(host)) return null;

  const isSsh = url.protocol === 'ssh:';
  if (!isSsh && url.protocol !== 'https:' && url.protocol !== 'http:')
    return null;

  // Path: /owner/repo[.git]
  const segments = url.pathname.replace(/^\/+/, '').split('/');
  if (segments.length < 2) return null;
  const [owner, repoRaw] = segments;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/i, '');

  return {
    host: 'github.com',
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    isSsh,
  };
}
