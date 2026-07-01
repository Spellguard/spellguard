// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Per-agent `gh` CLI config directory: `<configDir>/gh/<agentId>`.
 *
 * `gh` honors the `GH_CONFIG_DIR` env var (session-scoped, never the developer's
 * real `~/.config/gh`) and re-reads `hosts.yml` on EVERY invocation. So pointing
 * `GH_CONFIG_DIR` here and having the daemon rewrite `hosts.yml` on rotation makes
 * a fresh scoped token available to the next `gh` call with no restart — the gh
 * analog of the git credential helper's live-file read.
 *
 * Signature `(configDir, agentId)` so the per-framework isolation follow-up can
 * pass a framework-scoped `configDir` unchanged (`<frameworkDir>/gh/<agentId>`).
 */
export function ghConfigDirPath(configDir: string, agentId: string): string {
  return join(configDir, 'gh', agentId);
}

/**
 * Write/refresh the session `gh` config so `gh api` / `gh pr create` authenticate
 * with the scoped token.
 *
 * - `hosts.yml` carries the current token; rewritten ATOMICALLY (temp+rename) on
 *   every rotation so a concurrent `gh` read never sees a half-written file.
 * - `config.yml` carries a `version:` marker, written ONCE. Without it `gh` runs a
 *   one-time multi-account migration that makes a BLOCKING online `CurrentUser`
 *   API call — which fails for a server-to-server installation token and breaks
 *   every `gh` call in the session.
 */
export function writeGhSessionConfig(args: {
  dir: string;
  token: string;
  host?: string;
}): void {
  const host = args.host ?? 'github.com';
  mkdirSync(args.dir, { recursive: true, mode: 0o700 });

  const configYml = join(args.dir, 'config.yml');
  if (!existsSync(configYml)) {
    writeFileSync(configYml, 'version: "1"\n', { mode: 0o600 });
  }

  const hosts = `${host}:\n    oauth_token: ${args.token}\n    git_protocol: https\n`;
  const hostsTmp = join(args.dir, 'hosts.yml.tmp');
  writeFileSync(hostsTmp, hosts, { mode: 0o600 });
  renameSync(hostsTmp, join(args.dir, 'hosts.yml'));
}

/**
 * Remove the session token on revoke/reset. `gh` then has no login in this dir
 * (fails closed inside the agent only). `config.yml` is left so a later
 * re-provision needs no migration.
 */
export function clearGhSessionConfig(dir: string): void {
  try {
    rmSync(join(dir, 'hosts.yml'), { force: true });
  } catch {
    /* already gone */
  }
}
