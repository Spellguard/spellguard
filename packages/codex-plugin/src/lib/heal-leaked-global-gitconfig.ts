// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One-time heal for machines already affected by the OLD Codex plugin leak
 * (pre-2026-06-15). The old `installCodexCredentialHelper` wrote, into the
 * developer's MACHINE-GLOBAL `~/.gitconfig`:
 *   - `credential.https://github.com.helper` = <spellguard-git-helper>
 *     (+ `credential.https://github.com.useHttpPath = true`), and
 *   - a `(Spellguard:<agent>)`-suffixed `user.name` / `user.email`.
 *
 * On revoke the helper returned nothing and plain-shell `git pull` (in EVERY
 * terminal) fell back to a username/password prompt — the credential was bricked
 * machine-wide. The config.toml-scoped plugin (A4) stops NEW leaks but does not
 * remove the entries an OLD version already wrote, so an upgraded machine stays
 * broken until those global entries are cleared.
 *
 * This removes EXACTLY our footprint, once (guarded by a marker file), and only
 * values that are unmistakably ours:
 *   - the github.com helper, only when it points at a `spellguard-git-helper`
 *     (a `gh auth setup-git` PAT helper or a user's own helper is left alone);
 *     the `useHttpPath` flag we set alongside it is reversed in the same case.
 *   - global `user.name`/`user.email`, only when `user.name` carries the
 *     `(Spellguard:<agent>)` / legacy `(spellguard:<agent>)` annotation.
 *
 * Best-effort: any git/fs failure is swallowed (a heal must never break a
 * session), and the marker is written so the git probes run at most once.
 */

const SPELLGUARD_HELPER_MARK = 'spellguard-git-helper';
// Matches both the new `(Spellguard:` and the legacy lowercase `(spellguard:`.
const SPELLGUARD_AUTHOR_RE = /\(spellguard:/i;

function readGlobal(key: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--global', '--get', key], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return undefined; // key unset / git unavailable
  }
}

function unsetGlobalAll(key: string): void {
  try {
    execFileSync('git', ['config', '--global', '--unset-all', key], {
      stdio: 'ignore',
    });
  } catch {
    /* best-effort — already absent */
  }
}

/**
 * Run the one-time heal. `markerPath` is a file under the Spellguard config dir;
 * once it exists the function short-circuits without probing git.
 */
export function healLeakedGlobalGitConfig(markerPath: string): void {
  if (existsSync(markerPath)) return;

  try {
    // 1. The leaked github.com helper (only if it is OURS) + its useHttpPath.
    const helper = readGlobal('credential.https://github.com.helper');
    if (helper?.includes(SPELLGUARD_HELPER_MARK)) {
      unsetGlobalAll('credential.https://github.com.helper');
      unsetGlobalAll('credential.https://github.com.useHttpPath');
    }

    // 2. The leaked suffixed identity (only if user.name is OURS). The old leak
    // wrote name + email together, so clear the pair.
    const name = readGlobal('user.name');
    if (name && SPELLGUARD_AUTHOR_RE.test(name)) {
      unsetGlobalAll('user.name');
      unsetGlobalAll('user.email');
    }
  } catch {
    /* best-effort — never break the session over a heal */
  }

  // Mark done so the probes run at most once per machine.
  try {
    mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      markerPath,
      'spellguard codex: one-time global ~/.gitconfig leak heal complete\n',
      { mode: 0o600 },
    );
  } catch {
    /* best-effort — if we can't mark it, we re-probe next session (idempotent) */
  }
}
