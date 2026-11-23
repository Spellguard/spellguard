// SPDX-License-Identifier: Apache-2.0

/**
 * R3-1 — the managed-mode MARKER reader (TypeScript side).
 *
 * A "managed box" is a genuine Spellguard-provisioned box whose nonce-authed
 * `spellguard managed-bootstrap` flow (the Go CLI, `internal/cli/managed.go` →
 * `internal/plugin/managed_marker.go`) has written a product-owned marker file.
 * That marker — NOT any ambient env var (`SPELLGUARD_AGENT_ID` /
 * `SPELLGUARD_BOOTSTRAP_NONCE`) — is the SOLE primary signal that credential
 * placement should go GLOBAL rather than scoped. The default everywhere is
 * non-managed (scoped / fail-closed).
 *
 * This reader lives in the neutral `@spellguard/agent-control` package so BOTH
 * plugins (Claude Code, Codex, OpenClaw) AND the credential daemon share ONE copy
 * — a divergent per-plugin reader would be exactly the cross-language drift R3-1
 * warns about. (This is the T3.1 READER; the placement/rotation code that consumes
 * it lands in T3.3–T3.5.)
 *
 * CROSS-LANGUAGE PATH PARITY (R3-1): the marker path MUST resolve to the exact
 * same absolute string as the Go writer (`plugin.SharedConfigRoot` +
 * `plugin.ManagedMarkerPath`). Both HONOR `XDG_CONFIG_HOME`: the shared root is
 * `<XDG_CONFIG_HOME>/spellguard` when that env var is set and non-empty, else
 * `<home>/.config/spellguard`; the marker basename is `.managed`. This is the SAME
 * formula the plugins' own `spellguardRootDir()` (config-store.ts) already uses, so
 * the marker sits at the shared root alongside the per-framework config subdirs.
 */

import { type Stats, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fixed basename of the managed-mode marker, at the SHARED config root. */
export const MANAGED_MARKER_BASENAME = '.managed';

/** The JSON stamp the Go writer stores. Diagnostic identity only — no secrets. */
export interface ManagedMarker {
  agent_id: string;
  bootstrap_at?: string;
  cli_version?: string;
  frameworks?: string[];
}

export interface ManagedMarkerResult {
  /** The parsed stamp when present + valid; undefined otherwise. */
  marker?: ManagedMarker;
  /** True ONLY for a present, parseable marker carrying a non-empty agent id. */
  managed: boolean;
  /** Non-empty when the marker is present but unreadable / corrupt / invalid. */
  diagnostic?: string;
}

/**
 * The shared Spellguard config ROOT — parent of the per-framework config subdirs
 * and home of the managed-mode marker. `<XDG_CONFIG_HOME>/spellguard` when set +
 * non-empty, else `<home>/.config/spellguard`. Byte-identical to the Go
 * `plugin.SharedConfigRoot` and the plugins' own `spellguardRootDir()`.
 *
 * `env`/`home` are injectable so the parity + reader tests can pin concrete paths
 * without touching the real environment or `~/.config/spellguard`.
 */
export function spellguardRootDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'spellguard') : join(home, '.config', 'spellguard');
}

/** Absolute marker path for a resolved shared root. */
export function managedMarkerPath(root: string = spellguardRootDir()): string {
  return join(root, MANAGED_MARKER_BASENAME);
}

/**
 * Read + validate the managed-mode marker at the shared root. Present + parseable
 * + agent id → managed. Absent → non-managed, no diagnostic (the default case).
 * Present but unreadable / corrupt / missing-agent-id → non-managed + a diagnostic
 * (fail TOWARD scoped; never activate managed mode on a bad marker). NEVER gates on
 * ambient env (NEG-7) — it only ever reads this file.
 */
export function readManagedMarker(
  root: string = spellguardRootDir(),
): ManagedMarkerResult {
  const path = managedMarkerPath(root);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { managed: false };
    return {
      managed: false,
      diagnostic: `managed marker unreadable at ${path}: ${e.message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      managed: false,
      diagnostic: `managed marker corrupt at ${path}: ${(err as Error).message}`,
    };
  }
  const marker = parsed as ManagedMarker;
  if (
    !marker ||
    typeof marker !== 'object' ||
    typeof marker.agent_id !== 'string' ||
    marker.agent_id === ''
  ) {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} missing agent_id`,
    };
  }
  // FIX A (code review, LOW) — marker integrity. A same-uid process on a NON-managed
  // box could plant a well-formed marker to flip managed mode + stand down the
  // fail-closed masking. The GENUINE marker is written by ROOT at 0644 (owner-
  // write only). Fail TOWARD non-managed when the marker is group/world-writable,
  // or — for a non-root reader, where the platform exposes it — owned by a
  // FOREIGN unprivileged uid (neither root nor the reader). (Node can't portably
  // assert "owned by root"; the mode-bits check is the portable guard, plus the
  // owner-uid check where `statSync().uid` / `process.getuid()` are available.)
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch (err) {
    return {
      managed: false,
      diagnostic: `managed marker unstatable at ${path}: ${(err as Error).message}`,
    };
  }
  const perm = stats.mode & 0o777;
  if (perm & 0o022) {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} is group/world-writable (mode ${perm.toString(8)}); refusing to honor`,
    };
  }
  const readerUid =
    typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (
    readerUid !== undefined &&
    readerUid !== 0 &&
    typeof stats.uid === 'number' &&
    stats.uid !== 0 &&
    stats.uid !== readerUid
  ) {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} owned by untrusted uid ${stats.uid} (reader uid ${readerUid}, not root); refusing to honor`,
    };
  }
  return { marker, managed: true };
}

/**
 * Positive managed-mode gate: true ONLY when the shared root holds a present,
 * parseable marker with a non-empty agent id. Absent OR corrupt → false
 * (non-managed / scoped / fail-closed).
 */
export function isManagedBox(root: string = spellguardRootDir()): boolean {
  return readManagedMarker(root).managed;
}
