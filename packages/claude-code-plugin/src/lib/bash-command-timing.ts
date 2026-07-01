// SPDX-License-Identifier: Apache-2.0

// PreToolUse → PostToolUse command-start timing handoff.
//
// The Bash-edit capture mtime-gates which files a command authored to a window
// [commandStart - slack, now]. The accurate `commandStart` is the moment the
// Bash command BEGAN, which only the PreToolUse hook knows. Claude Code does
// expose a `duration_ms` on PostToolUse, but it is documented OPTIONAL — so we
// do not depend on it. Instead PreToolUse(Bash) stamps the start time into a
// tiny sidecar keyed by the tool-use id (PreToolUse and PostToolUse for the
// same call share `tool_use_id`, PreToolUse is guaranteed to fire first, and
// tool calls are serialized), and PostToolUse(Bash) consumes it.
//
// All operations are best-effort and never throw — a missing/uncreatable
// sidecar just means the capture falls back to its duration_ms / default
// window. Files live under the plugin's own `<rootDir>/bash-timing/` dir
// (0700), never repo source.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const TIMING_SUBDIR = 'bash-timing';
// Stale sidecars (e.g. a PreToolUse that BLOCKED, so no PostToolUse consumed
// it) are pruned after this long so the dir can't grow unbounded.
const STALE_MS = 60 * 60 * 1000;

// tool_use_id is a model-supplied opaque string; constrain it to a safe
// filename so it can't traverse out of the timing dir.
function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200) || 'nokey';
}

function timingDir(rootDir: string): string {
  return join(rootDir, TIMING_SUBDIR);
}

/** Record the start time of a Bash command, keyed by its tool-use id. */
export function markBashCommandStart(input: {
  rootDir: string;
  key: string;
  nowMs: number;
}): void {
  try {
    const dir = timingDir(input.rootDir);
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort perms */
    }
    writeFileSync(join(dir, `${safeKey(input.key)}.txt`), String(input.nowMs), {
      mode: 0o600,
    });
  } catch {
    /* best-effort — capture falls back to its default window */
  }
}

/**
 * Read and remove the start time for a tool-use id. Returns the start time in
 * ms, or null if none was recorded. Also opportunistically prunes stale
 * sidecars left behind by blocked PreToolUse calls.
 */
export function consumeBashCommandStart(input: {
  rootDir: string;
  key: string;
  nowMs: number;
}): number | null {
  const dir = timingDir(input.rootDir);
  const file = join(dir, `${safeKey(input.key)}.txt`);
  let result: number | null = null;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const n = Number(raw);
    if (Number.isFinite(n)) result = n;
  } catch {
    result = null;
  }
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
  pruneStale(dir, input.nowMs);
  return result;
}

function pruneStale(dir: string, nowMs: number): void {
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      try {
        if (nowMs - statSync(p).mtimeMs > STALE_MS) rmSync(p, { force: true });
      } catch {
        /* ignore one bad entry */
      }
    }
  } catch {
    /* dir missing — nothing to prune */
  }
}
