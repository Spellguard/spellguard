// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The daemon-maintained `GH_TOKEN` file: `<configDir>/gh-token`, mode 0600.
 *
 * WHY this exists (distinct from the gh `hosts.yml` and the git-tokens TSV):
 * Claude Code's STARTUP auto-update for a PRIVATE plugin marketplace reads its
 * GitHub credential from the `GH_TOKEN` / `GITHUB_TOKEN` ENVIRONMENT — it runs
 * WITHOUT git credential helpers (an interactive prompt would block startup), so
 * neither the `spellguard-git-helper` (credential.helper) nor the per-agent gh
 * `GH_CONFIG_DIR` pin covers it. The managed login-shell snippet
 * (`credplace.WriteClaudeManagedGitProfile` → /etc/profile.d/spellguard-git.sh)
 * conditionally exports `GH_TOKEN` from THIS file, so every `claude` launch
 * inherits a fresh token and the box can pull the private marketplace's latest
 * revision. The daemon keeps the file in lockstep with the agent's scoped token
 * (write on delivery/rotation, clear on revoke) exactly the way it maintains the
 * git-tokens TSV and the gh `hosts.yml`.
 *
 * SINGLE-ORG caveat (a FLAGGED LIMITATION): `GH_TOKEN` is a SINGLE token; it
 * covers exactly the GitHub org whose installation minted it. For the primary
 * managed use case — a long-lived agent working on the SAME repo/org the plugin
 * marketplace lives in (e.g. `Spellguard/spellguard@main`) — the
 * delivered token already covers the marketplace repo, so it serves both `gh`
 * and the startup auto-update with no downgrade. A MULTI-ORG / CROSS-ORG agent is
 * NOT covered: no single `GH_TOKEN` spans GitHub orgs, so a marketplace in a
 * DIFFERENT org than the token's would not auto-update. We write the FIRST
 * installed org's token (the same one mirrored into hosts.yml + the git-tokens
 * wildcard), which is unambiguous only for the single-org agent.
 *
 * The token is NEVER logged.
 */
export function ghTokenFilePath(configDir: string): string {
  return join(configDir, 'gh-token');
}

/**
 * Write/refresh the GH_TOKEN file with the current scoped token. Atomic
 * (temp+rename) so a concurrent `claude` launch reading it never sees a
 * half-written file, and 0600 regardless of the process umask. An empty token is
 * a no-op (never write a zero-byte file — it would defeat the consumer's
 * `[ -s "$file" ]` guard and could export an empty GH_TOKEN).
 */
export function writeGhTokenFile(path: string, token: string): void {
  if (!token) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp`;
  if (platform() !== 'win32') {
    // open(2) applies `mode & ~umask`; chmod forces exactly 0600 afterwards so a
    // restrictive OR permissive umask cannot widen/narrow the credential file.
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, token, 0, 'utf-8');
    } finally {
      closeSync(fd);
    }
    chmodSync(tmpPath, 0o600);
  } else {
    writeFileSync(tmpPath, token, 'utf-8');
  }
  renameSync(tmpPath, path);
}

/**
 * Remove the GH_TOKEN file on revoke/reset/self-wipe so a torn-down agent never
 * leaves a live token on disk for the next `claude` launch to export. Tolerant
 * of an already-absent file.
 */
export function clearGhTokenFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}
