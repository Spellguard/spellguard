// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Best-effort detection of whether the user has enabled the Codex hooks
 * feature flag. The flag lives at `~/.codex/config.toml` under the key
 * `[features] codex_hooks = true`. Without it, Codex silently ignores
 * every plugin's hooks/hooks.json registrations — the SessionStart hook
 * never fires, no observations land, and Spellguard appears broken.
 *
 * This helper is used by the SessionStart hook to print a one-shot
 * banner to the user with copy-pasteable instructions if the flag is
 * disabled. It's deliberately lenient: any read error → assume enabled
 * (we don't want a malformed config.toml to also break the banner).
 */
export type CodexHooksFlagResult =
  | { state: 'enabled' }
  | { state: 'disabled' }
  | { state: 'unknown'; reason: string };

export function probeCodexHooksFlag(
  opts: {
    /** Override the config path for tests. */
    configPath?: string;
    /** Override homedir for tests. */
    homeDirOverride?: string;
  } = {},
): CodexHooksFlagResult {
  const path =
    opts.configPath ??
    join(opts.homeDirOverride ?? homedir(), '.codex', 'config.toml');
  if (!existsSync(path)) {
    // Codex always writes config.toml on first run; absence means the user
    // has never run Codex on this machine, which is fine — they'll see the
    // banner once they do.
    return { state: 'unknown', reason: 'config.toml absent' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return { state: 'unknown', reason: `read failed: ${String(err)}` };
  }
  // Cheap TOML scan — we only need to find `codex_hooks = true` under
  // `[features]`. The well-formed-TOML parse is overkill; substring +
  // section-anchor is plenty.
  const lines = raw.split('\n');
  let inFeaturesSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    if (trimmed.startsWith('[')) {
      inFeaturesSection = trimmed === '[features]';
      continue;
    }
    if (inFeaturesSection) {
      // Match `codex_hooks = true` (with optional whitespace + quotes).
      const m = /^codex_hooks\s*=\s*(true|false|"true"|"false")$/i.exec(
        trimmed,
      );
      if (m) {
        return m[1].toLowerCase().includes('true')
          ? { state: 'enabled' }
          : { state: 'disabled' };
      }
    }
  }
  // Default-on changed between Codex versions; absence is "unknown" and
  // we don't false-positive an alarm.
  return { state: 'unknown', reason: 'codex_hooks key not present' };
}
