// SPDX-License-Identifier: Apache-2.0

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the OpenClaw-side Spellguard credential directory.
 *
 * Precedence:
 *   1. `OPENCLAW_SPELLGUARD_CONFIG_DIR` env var (explicit override; tests / CI)
 *   2. `XDG_CONFIG_HOME`/spellguard-openclaw  (Linux default)
 *   3. `~/.config/spellguard-openclaw`        (POSIX fallback)
 *
 * We deliberately use a separate subdir from the Spellguard plugin's
 * `spellguard/` so an operator running both on the same machine never
 * confuses the two credential stores.
 */
export function defaultCredentialDir(): string {
  const explicit = process.env.OPENCLAW_SPELLGUARD_CONFIG_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'spellguard-openclaw');
  return join(homedir(), '.config', 'spellguard-openclaw');
}

export function credentialStorePath(dir = defaultCredentialDir()): string {
  return join(dir, 'credentials.json');
}

export function pluginLogPath(dir = defaultCredentialDir()): string {
  return join(dir, 'plugin.log');
}
