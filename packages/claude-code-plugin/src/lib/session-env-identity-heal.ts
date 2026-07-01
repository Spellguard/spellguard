// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Single-quote a value for a bash assignment line. Mirrors env-file-writer's
// (unexported) bashQuote — the capture files are sourced as bash, so a value
// with shell metacharacters (the `(Spellguard:…)` identity has parens + spaces)
// must be single-quoted or bash treats it as a subshell call.
function bashQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Rewrite the identity slots in ONE capture file to the given lines, but only if
// it actually carries our identity slot. Best-effort: any read/write failure is
// swallowed so one bad sibling can't abort the rest. Function replacements keep a
// `$` in the (quoted) identity from being read as a JS replacement token.
function healOneCapture(file: string, name: string, email: string): void {
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  // Match by KEY, not by a fixed slot index: the author slot index is NOT fixed
  // (it shifts when the SSH->HTTPS `insteadOf` rewrite is on — author at 9/10 —
  // vs off — author at 7/8). We find each `GIT_CONFIG_KEY_<n>=user.name` line,
  // immediately followed by its `GIT_CONFIG_VALUE_<n>=` line (the writer always
  // emits them as a consecutive key→value pair), and rewrite the value. The
  // `\2` backreference ties the VALUE index to its KEY index so we never touch
  // an unrelated slot (e.g. the `insteadOf` rewrite slots, which would corrupt
  // the SSH rewrite). Skip captures that carry no author slot at all.
  if (!/^export GIT_CONFIG_KEY_\d+=user\.name$/m.test(content)) return;
  // `/gm`, not `/m`: SessionStart APPENDS a fresh block to the same capture file
  // on each invocation (early-mask + success-path, and again on resume), so one
  // file accumulates several author blocks. Bash sources them last-wins, so we
  // must rewrite EVERY occurrence — fixing only the first leaves a later stale
  // line that wins. Function replacements keep a `$` in the (quoted) identity
  // from being read as a JS replacement token.
  const healed = content
    .replace(
      /^(export GIT_CONFIG_KEY_(\d+)=user\.name\nexport GIT_CONFIG_VALUE_\2=).*$/gm,
      (_m, prefix) => `${prefix}${bashQuote(name)}`,
    )
    .replace(
      /^(export GIT_CONFIG_KEY_(\d+)=user\.email\nexport GIT_CONFIG_VALUE_\2=).*$/gm,
      (_m, prefix) => `${prefix}${bashQuote(email)}`,
    );
  if (healed === content) return;
  try {
    writeFileSync(file, healed, 'utf-8');
  } catch {
    /* best-effort — leave the rest to the next run */
  }
}

/**
 * Heal stale git identity in Claude Code's per-session SessionStart capture files.
 *
 * Claude Code captures each SessionStart hook run to its own file
 * `<session-env-dir>/sessionstart-hook-N.sh` and sources ALL of them (in
 * filename order, last-wins) before every Bash command. On a RESUMED session the
 * hook re-runs and writes a fresh capture with the current identity — but the
 * ORIGINAL startup capture persists and, sorting after the resume capture,
 * overrides it. So after a re-provision a resumed session authors commits with
 * the stale `(Spellguard:<old-agent>)` marker even though config.json (and this
 * run's fresh capture) carry the current one. Empirically confirmed 2026-06-16.
 *
 * This rewrites the `user.name`/`user.email` value lines (located by their key,
 * whatever slot index they occupy) in EVERY sibling capture in the session-env
 * dir to the current identity, so the current value wins regardless of source
 * order. It is deliberately surgical and fail-safe:
 *  - Only the two identity value lines are touched; the stable helper path, the
 *    SSH->HTTPS `insteadOf` rewrite slots, `GH_CONFIG_DIR`, `GIT_CONFIG_COUNT`,
 *    and every other export are left intact (we rewrite, never prune — a
 *    whole-file delete would drop those).
 *  - Only `sessionstart-hook-*.sh` files that carry our identity slot change.
 *  - Every failure is swallowed: the session-env layout is a Claude Code
 *    internal, so if it ever changes this becomes a no-op. The fresh capture this
 *    run already wrote is untouched either way — there is no regression path.
 *
 * @param envFilePath this run's CLAUDE_ENV_FILE; its directory holds the siblings.
 */
export function healSessionEnvIdentity(
  envFilePath: string,
  gitAuthorName?: string,
  gitAuthorEmail?: string,
): void {
  // Without a path or a full identity there is nothing to normalize toward.
  if (!envFilePath || !gitAuthorName || !gitAuthorEmail) return;

  try {
    const dir = dirname(envFilePath);
    for (const entry of readdirSync(dir)) {
      if (/^sessionstart-hook-.*\.sh$/.test(entry)) {
        healOneCapture(join(dir, entry), gitAuthorName, gitAuthorEmail);
      }
    }
  } catch {
    /* best-effort: session-env dir is a Claude Code internal */
  }
}
