// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { GithubCredentialScope } from '@spellguard/agent-control';
import { FRAMEWORK_SLUG } from './framework-slug';

/**
 * Phase C: one GitHub credential, keyed by lowercase GitHub org login.
 * The keyed `githubCredentials` map (below) lets a single agent machine hold
 * N tokens — one per org — at once; the legacy top-level
 * `scopedToken`/`scopedTokenId`/`expiresAt` fields are MIRRORED from the first
 * entry for back-compat (decision D13 / D6).
 */
export interface GithubCredentialEntry {
  scopedToken?: string;
  scopedTokenId: string;
  expiresAt: string;
  scopeSummary?: GithubCredentialScope;
  installationId?: number;
  revoked?: boolean;
}

/**
 * Durable liveness marker for a recoverable final GitHub revocation.
 *
 * The retry schedule itself is process-local and bounded; only the fact that
 * fresh issuance is still needed crosses daemon restarts (including a restart
 * performed by `spellguard doctor --repair`). A successful secret-bearing
 * GitHub delivery removes this marker in the same atomic config write that
 * installs the replacement credential.
 */
export interface GithubReissueMarker {
  pending: true;
}

export interface SpellguardConfig {
  /**
   * GitHub credential fields. Populated either by the legacy
   * bootstrap-bundled path (older servers) or, under the
   * provider-agnostic protocol, by the persistent credential
   * daemon when it receives a `credential_delivered` frame for the
   * `github` provider. Setup writes the surrounding identity-only fields
   * (`agentId`, `agentSecret`, `agentName`, `spellguardBaseUrl`) and
   * leaves these undefined until the GitHub credential lands.
   */
  scopedToken?: string;
  scopedTokenId?: string;
  expiresAt?: string;
  scopeSummary?: GithubCredentialScope;
  agentId: string;
  /**
   * Agent secret issued at bootstrap (`credential_delivered{cause:'bootstrap'}`).
   * The plugin uses this for both the persistent socket (URL query
   * `?agent_secret=`) and REST routes (`X-Spellguard-Agent-Id` +
   * `X-Spellguard-Agent-Secret` headers). It is the only credential the
   * server needs to authenticate the agent end-to-end.
   */
  agentSecret: string;
  spellguardBaseUrl: string;
  revoked?: boolean;
  /**
   * Human-readable, cause-specific reason this credential was torn down,
   * persisted so the next SessionStart can re-surface it to the user.
   * Written by the self-wipe path (P2-T6) when the server supersedes this
   * agent's secret (close code 4409 — attached elsewhere / reassigned). The
   * background daemon often performs the wipe while no interactive session is
   * open, so a one-shot stderr line would be lost; this field survives on disk
   * and SessionStart reads it the same way it reads `revoked`.
   */
  revokedMessage?: string;
  /** Provided in the bootstrap frame by the server. */
  agentName?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  /**
   * Highest server `seq` the plugin has durably applied.
   * Persisted to disk after every successful frame handler so the
   * agent-control client can send `Resume{last_server_seq}` on
   * reconnect and receive missed frames from the server's ring buffer.
   * Decimal string (uint64). Optional — absent on first run before any
   * frame has been processed.
   */
  lastServerSeq?: string;
  /**
   * Cached projection of credentials the plugin currently holds,
   * sent to the server in `Resume.known_credentials` so divergence
   * detection compares against a real client view rather than an empty
   * one. Without this, every daemon restart trips
   * `maybeEmitAdminReissue` (server's live row vs empty client set =
   * divergence) and silently rotates the GitHub installation token. Only
   * the (provider, scoped_token_id) tuple is needed; the actual
   * `scoped_token` is kept separate for security.
   */
  knownCredentials?: Array<{ provider: string; scoped_token_id: string }>;
  githubReissue?: GithubReissueMarker;
  /**
   * Server-pushed provider configuration descriptors, keyed by
   * provider name (e.g. 'github'). Written when the daemon receives a
   * `config_updated` frame. The shape per provider is opaque — it mirrors
   * `agents.provider_config` server-side and is forwarded as-is.
   */
  providerConfig?: Record<string, unknown>;
  /**
   * Phase C: GitHub credentials keyed by lowercase GitHub org login.
   * The legacy top-level scopedToken/scopedTokenId/expiresAt fields are
   * MIRRORED from the first entry for one release (old helper binaries and
   * session-start checks read them); writers must keep both in sync.
   */
  githubCredentials?: Record<string, GithubCredentialEntry>;
}

/** Public alias for consumers who import from the plugin index. */
export type PluginConfig = SpellguardConfig;

/**
 * The shared spellguard root (honors `XDG_CONFIG_HOME`). Pre-isolation this WAS
 * the config dir; it is now only the parent of the per-framework subdirs and the
 * source path the one-time legacy migration reads from.
 */
function spellguardRootDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? join(xdg, 'spellguard')
    : join(homedir(), '.config', 'spellguard');
}

/**
 * The legacy single-slot config dir — the shared root with NO framework segment,
 * what an old (pre-isolation) plugin version used. Source of the one-time
 * legacy→framework migration (`migrate-legacy-config.ts`).
 */
export function legacyConfigDir(): string {
  return spellguardRootDir();
}

export function defaultConfigDir(): string {
  return join(spellguardRootDir(), FRAMEWORK_SLUG);
}

export function defaultConfigPath(): string {
  return join(defaultConfigDir(), 'config.json');
}

/**
 * Read a protected credential/config artifact without following a final-path
 * symlink. Generation callers may traverse the intentional `current` pointer,
 * but the selected state/token file itself must remain a private regular file.
 */
export function readPrivateConfigFile(path: string): string {
  const flags =
    fsConstants.O_RDONLY |
    (platform() === 'win32' ? 0 : fsConstants.O_NOFOLLOW);
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('protected config path is not a file');
    if (platform() !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('protected config file permissions are too broad');
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Phase C (decision D13): the daemon-maintained companion file the POSIX-sh
 * git helper reads to select a token by repo-owner — NO JSON parsing in sh.
 * Lives next to config.json, mode 0600, one `<orgLoginLower>\t<token>` line
 * per unrevoked entry plus a `*\t<token>` wildcard fallback line.
 */
export function gitTokensPath(dir = defaultConfigDir()): string {
  return join(dir, 'git-tokens');
}

/**
 * The GitHub tokens a config actually serves (#1282). A revoked config serves
 * none; a keyed entry serves its token unless it is revoked; the legacy
 * top-level `scopedToken` counts only as the single-slot credential of a config
 * with no keyed map, or as the mirror of a live keyed entry.
 */
function servedTokens(config: SpellguardConfig): Set<string> {
  const served = new Set<string>();
  if (config.revoked) return served;
  const entries = Object.values(config.githubCredentials ?? {});
  for (const entry of entries) {
    if (!entry.revoked && entry.scopedToken) served.add(entry.scopedToken);
  }
  if (
    config.scopedToken &&
    (entries.length === 0 || served.has(config.scopedToken))
  ) {
    served.add(config.scopedToken);
  }
  return served;
}

/**
 * Drop every GitHub token that is not in `keep`, leaving the rest of the config
 * intact. Keyed entries stay (their ids back the per-entry resurrection guard in
 * the credential handlers); only the token material goes.
 */
function keepTokens(
  config: SpellguardConfig,
  keep: ReadonlySet<string>,
): SpellguardConfig {
  // Rebuild key by key so every kept field stays where it was: config.json is
  // byte-compared with the Go writer's output (credplace TestGoldenEquivalence).
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'scopedToken') {
      // An empty placeholder (identity-only / managed bootstrap) is not a token.
      const token = value as string | undefined;
      if (token !== undefined && (!token || keep.has(token))) {
        kept[key] = token;
      }
    } else if (key === 'githubCredentials' && value) {
      kept[key] = Object.fromEntries(
        Object.entries(
          value as NonNullable<SpellguardConfig['githubCredentials']>,
        ).map(([org, entry]) => {
          if (!entry.scopedToken || keep.has(entry.scopedToken)) {
            return [org, entry];
          }
          const { scopedToken: _dropped, ...withoutToken } = entry;
          return [org, withoutToken];
        }),
      );
    } else {
      kept[key] = value;
    }
  }
  return kept as unknown as SpellguardConfig;
}

/**
 * Snapshot the previous config to `<path>.bak` without any token the new config
 * no longer serves (#1282): a revoked or superseded GitHub token must not
 * survive in the snapshot, or revoking it on the box means nothing. A previous
 * file that does not parse is copied as-is for recovery, unless the new config
 * is revoked, in which case no snapshot is kept.
 */
function writeConfigSnapshot(path: string, next: SpellguardConfig): void {
  const bak = `${path}.bak`;
  let previous: unknown;
  try {
    previous = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    previous = undefined;
  }
  if (previous === null || typeof previous !== 'object') {
    if (next.revoked) {
      rmSync(bak, { force: true });
      return;
    }
    copyFileSync(path, bak);
  } else {
    const snapshot = keepTokens(
      previous as SpellguardConfig,
      servedTokens(next),
    );
    writeFileSync(bak, JSON.stringify(snapshot, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
  if (platform() !== 'win32') chmodSync(bak, 0o600);
}

/**
 * Regenerate the `git-tokens` companion file (decision D13) from a config.
 *
 * One TAB-separated line per UNREVOKED keyed entry (`<orgLoginLower>\t<token>`).
 * A `*\t<token>` wildcard line is emitted ONLY for a genuinely SINGLE-ORG
 * config: a keyed map with exactly one TOTAL entry (usable), or the legacy
 * single-slot `scopedToken` when the keyed map is absent — it preserves the
 * no-`path=` back-compat behavior for legacy git. Any keyed map with ≥2 TOTAL
 * entries (revoked ones included) omits the wildcard (PR #338 review CR-004):
 * a multi-org wildcard hands a SIBLING org's token to any repo owner outside
 * the agent's usable set — and counting REVOKED entries matters, because a
 * multi-org agent revoked down to one usable sibling would otherwise re-grow
 * a wildcard that serves that sibling's token for pushes to the REVOKED org
 * (the exact leak the review reproduced). Without the wildcard, the git
 * helper fails closed for unknown/revoked owners and prints its actionable
 * stderr notice instead of presenting the wrong org's credential.
 *
 * When no usable token exists an empty companion is committed. Its presence is
 * authoritative: the git helper must not fall back to a stale legacy
 * single-slot config if the following config.json commit is interrupted. A
 * missing companion still identifies a genuinely legacy install, preserving
 * the old helper fallback until the first companion write.
 */
export function writeGitTokensFile(
  config: SpellguardConfig,
  dir = defaultConfigDir(),
  options: { onlyIfMissing?: boolean } = {},
): void {
  const path = gitTokensPath(dir);
  const lines: string[] = [];
  let wildcardToken: string | undefined;
  let usableCount = 0;
  let keyedTotal = 0;

  // A revoked config serves nothing (#1282): not its keyed per-org entries,
  // whose own `revoked` flags a whole-config revoke never sets, and not the
  // legacy single slot (below).
  const keyed = config.revoked ? undefined : config.githubCredentials;
  if (keyed && Object.keys(keyed).length > 0) {
    keyedTotal = Object.keys(keyed).length;
    for (const [org, entry] of Object.entries(keyed)) {
      if (entry.revoked) continue;
      if (!entry.scopedToken) continue;
      lines.push(`${org}\t${entry.scopedToken}`);
      usableCount++;
      // Wildcard tracks the FIRST usable (unrevoked) entry.
      if (wildcardToken === undefined) wildcardToken = entry.scopedToken;
    }
  } else if (!config.revoked && config.scopedToken) {
    // Legacy single-slot fallback (pre-Phase-C / mirror-only writers).
    wildcardToken = config.scopedToken;
    usableCount = 1;
  }

  if (wildcardToken !== undefined && usableCount === 1 && keyedTotal <= 1) {
    lines.push(`*\t${wildcardToken}`);
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const content = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  // Write to a temp file, then publish its fully formed contents as one
  // directory-entry operation: the git helper reads this file concurrently
  // with daemon rewrites, so a truncate-in-place write could hand the helper
  // a half-written or momentarily-empty token set mid-update (PR #338 review
  // R2-015). The normal path uses rename (the same pattern writeConfig uses);
  // startup recovery uses a no-replace hard link so it cannot overwrite a
  // helper artifact published by the credential writer first.
  //
  // Startup recovery uses `onlyIfMissing` because the companion is the first
  // half of writeConfig's helper-first two-file commit. An exists-then-write
  // check alone races a concurrent rotation: the daemon could observe a
  // missing file, the writer could publish the fresh helper artifact, and the
  // daemon could then overwrite it from stale config.json. Publish the fully
  // written temp file with a no-replace hard link so a concurrent publisher
  // wins and remains authoritative.
  let committed = true;
  const tmpPath = options.onlyIfMissing
    ? `${path}.${randomUUID()}.tmp`
    : `${path}.tmp`;
  if (platform() !== 'win32') {
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, content, 0, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } else {
    // Windows follows the same temp-then-link path. There is intentionally no
    // direct `wx` destination fallback: it exposes a partially written final
    // file to the helper. If this platform cannot create the no-replace link,
    // propagate the error so startup recovery fails closed.
    writeFileSync(tmpPath, content, 'utf-8');
  }
  try {
    if (options.onlyIfMissing) linkSync(tmpPath, path);
    else renameSync(tmpPath, path);
  } catch (error) {
    if (!options.onlyIfMissing || !isAlreadyExistsError(error)) throw error;
    committed = false;
  } finally {
    if (options.onlyIfMissing) rmSync(tmpPath, { force: true });
  }
  if (!committed) return;
  const resetMarker = join(
    dirname(path),
    'github-grants',
    'current',
    '.reset-tombstone',
  );
  if (!config.revoked && config.scopedToken && existsSync(resetMarker)) {
    rmSync(join(dirname(path), 'github-grants'), {
      recursive: true,
      force: true,
    });
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

export interface ReadConfigResult {
  config: SpellguardConfig | null;
  reason?: 'missing' | 'malformed' | 'wrong_permissions';
  /**
   * When `reason === 'malformed'`: WHICH validation failed ('json' for an
   * unparseable file). A malformed-but-present config used to be silently
   * indistinguishable from a missing one, which masked operator confusion
   * about "vanished" configs (plan Task 2.5, 2026-06-11).
   */
  malformedField?: string;
  /**
   * The file's mode had drifted off 0600 and `readConfig` tightened it back in
   * place before reading (see `healConfigMode`). Callers surface this as a
   * WARNING — the config was usable, so it must never be reported as "not
   * configured".
   */
  permissionsHealed?: boolean;
  /**
   * When `reason === 'wrong_permissions'`: the octal mode actually found, so the
   * caller can name the real problem instead of guessing.
   */
  foundMode?: string;
}

/**
 * Bring a config file whose mode drifted off 0600 back to 0600 IN PLACE, when
 * this process owns it.
 *
 * A hand-edit, an editor that rewrites through a temp file, or a copy made
 * under a loose umask all leave a perfectly valid config at 0664. Rejecting it
 * outright was a recovery trap: the daemon exited before reading a byte and
 * SessionStart reported a fully-configured machine as "Spellguard not
 * configured — run /spellguard-setup", pointing the operator at the one
 * destructive command. Tightening the mode is strictly safer than refusing to
 * read it (the exposure, if any, already happened; refusing does not undo it),
 * so heal and continue — but only for a file THIS user owns, so a config
 * planted by another uid is still rejected rather than adopted.
 *
 * @returns `'ok'` when the mode was already 0600, `'healed'` when it was
 *   tightened, `'unhealable'` when it is wrong and could not be fixed.
 */
function healConfigMode(
  path: string,
  mode: number,
): 'ok' | 'healed' | 'unhealable' {
  if (mode === 0o600) return 'ok';
  const uid = process.getuid?.();
  let ownerUid: number | undefined;
  try {
    ownerUid = statSync(path).uid;
  } catch {
    return 'unhealable';
  }
  if (uid === undefined || ownerUid !== uid) return 'unhealable';
  try {
    chmodSync(path, 0o600);
  } catch {
    return 'unhealable';
  }
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) return 'unhealable';
  } catch {
    return 'unhealable';
  }
  return 'healed';
}

/**
 * Typed-if-present check for the OPTIONAL (CR-002) GitHub credential fields.
 * Absent fields are fine (identity-only config); present-but-mistyped fields
 * mean a corrupted file and the config is rejected as malformed.
 */
function mistypedGithubField(parsed: SpellguardConfig): string | null {
  if (
    parsed.scopedToken !== undefined &&
    typeof parsed.scopedToken !== 'string'
  )
    return 'scopedToken';
  if (
    parsed.scopedTokenId !== undefined &&
    typeof parsed.scopedTokenId !== 'string'
  )
    return 'scopedTokenId';
  if (parsed.expiresAt !== undefined && typeof parsed.expiresAt !== 'string')
    return 'expiresAt';
  if (
    parsed.revokedMessage !== undefined &&
    typeof parsed.revokedMessage !== 'string'
  )
    return 'revokedMessage';
  if (
    parsed.githubReissue !== undefined &&
    (parsed.githubReissue === null ||
      typeof parsed.githubReissue !== 'object' ||
      parsed.githubReissue.pending !== true)
  )
    return 'githubReissue';
  return null;
}

export function readConfig(path = defaultConfigPath()): ReadConfigResult {
  if (!existsSync(path)) return { config: null, reason: 'missing' };
  let permissionsHealed = false;
  if (platform() !== 'win32') {
    let mode: number;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      return { config: null, reason: 'missing' };
    }
    // Anything other than 0600 is wrong on POSIX — but a mode this user owns is
    // REPAIRED rather than rejected (see healConfigMode). Only a file we cannot
    // tighten still fails, and it fails with the mode it actually has so the
    // caller can say what is wrong instead of "not configured".
    const healed = healConfigMode(path, mode);
    if (healed === 'unhealable') {
      return {
        config: null,
        reason: 'wrong_permissions',
        foundMode: mode.toString(8).padStart(4, '0'),
      };
    }
    permissionsHealed = healed === 'healed';
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { config: null, reason: 'missing' };
  }
  // An EMPTY file is a deliberately-cleared config (clearConfig truncates in
  // place to preserve ownership/perms) — that is "not configured", not
  // corruption; only non-empty unparseable content is loud-malformed.
  if (raw.trim() === '') {
    return { config: null, reason: 'missing' };
  }
  try {
    const parsed = JSON.parse(raw) as SpellguardConfig;
    // Required identity fields — present on every config from bootstrap on.
    for (const field of [
      'agentSecret',
      'agentId',
      'spellguardBaseUrl',
    ] as const) {
      if (typeof parsed[field] !== 'string') {
        return { config: null, reason: 'malformed', malformedField: field };
      }
    }
    // GitHub credential fields are OPTIONAL (CR-002): the browser-bootstrap
    // setup writes an identity-only config, and the credential daemon fills
    // these in when a `credential_delivered` frame arrives over the channel.
    // Requiring them here (the pre-CR-002 shape) rejected every identity-only
    // config as `malformed`, which killed the daemon at startup AND made
    // `handleCredentialUpdate` drop the delivered frame — so the GitHub
    // credential could never land on disk. They must still be strings when
    // present (typed-if-present), so a corrupted file stays rejected.
    const mistyped = mistypedGithubField(parsed);
    if (mistyped) {
      return { config: null, reason: 'malformed', malformedField: mistyped };
    }
    // knownCredentials is optional, but if present it must be an
    // array of {provider, scoped_token_id} string pairs. A malformed entry
    // would otherwise reach the wire as a Resume.known_credentials value
    // and trigger spurious divergence detection.
    if (parsed.knownCredentials !== undefined) {
      if (
        !Array.isArray(parsed.knownCredentials) ||
        !parsed.knownCredentials.every(
          (k) =>
            k != null &&
            typeof (k as { provider?: unknown }).provider === 'string' &&
            typeof (k as { scoped_token_id?: unknown }).scoped_token_id ===
              'string',
        )
      ) {
        return {
          config: null,
          reason: 'malformed',
          malformedField: 'knownCredentials',
        };
      }
    }
    // githubCredentials (Phase C) is optional; if present it must be a plain
    // object whose values carry a string scopedTokenId + string expiresAt
    // (typed-if-present, same contract as the legacy top-level fields). A
    // corrupted map stays rejected so a malformed entry never reaches the wire
    // projection or the git-tokens regeneration.
    if (parsed.githubCredentials !== undefined) {
      const map = parsed.githubCredentials as unknown;
      if (
        map == null ||
        typeof map !== 'object' ||
        Array.isArray(map) ||
        !Object.values(map as Record<string, unknown>).every(
          (e) =>
            e != null &&
            typeof e === 'object' &&
            typeof (e as { scopedTokenId?: unknown }).scopedTokenId ===
              'string' &&
            typeof (e as { expiresAt?: unknown }).expiresAt === 'string' &&
            ((e as { scopedToken?: unknown }).scopedToken === undefined ||
              typeof (e as { scopedToken?: unknown }).scopedToken === 'string'),
        )
      ) {
        return { config: null, reason: 'malformed' };
      }
    }
    return permissionsHealed
      ? { config: parsed, permissionsHealed: true }
      : { config: parsed };
  } catch {
    return { config: null, reason: 'malformed', malformedField: 'json' };
  }
}

export function writeConfig(
  config: SpellguardConfig,
  path = defaultConfigPath(),
  testHooks: { beforeConfigCommit?: () => void } = {},
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A revoked GitHub credential keeps no token at rest (#1282): not in
  // config.json, not in the `.bak` snapshot, not in `git-tokens`.
  const persisted = keepTokens(config, servedTokens(config));
  const content = JSON.stringify(persisted, null, 2);

  // Snapshot the previous config to `<path>.bak` BEFORE replacing — a bad
  // write (or an operator mishap) is recoverable, and the snapshot makes
  // "the config changed" auditable (plan Task 2.5, 2026-06-11).
  if (existsSync(path)) {
    try {
      writeConfigSnapshot(path, persisted);
    } catch {
      /* best-effort — never block the write on the snapshot */
    }
  }

  // Write to a temp file then rename: the rename is atomic on POSIX, so a
  // crash mid-write can never leave a truncated/corrupt config.json.
  const tmpPath = `${path}.tmp`;
  if (platform() !== 'win32') {
    // Open with O_WRONLY | O_CREAT | O_TRUNC and mode 0o600 atomically.
    // The kernel applies the mode before any data is written, so the file
    // is never world-readable even for an instant.
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, content, 0, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } else {
    // Windows: no POSIX mode bits; fall back to the original approach.
    writeFileSync(tmpPath, content, 'utf-8');
  }
  // Commit the helper-consumed token artifact BEFORE config.json. In
  // particular, a successful delivery may clear githubReissue in config.json;
  // that durable liveness marker must remain authoritative if git-tokens cannot
  // commit. The opposite order falsely declared recovery while git still had
  // no credential. For revocation, helper-first is also the fail-closed order:
  // a token can disappear slightly before config records why, never survive
  // after config says it is gone.
  writeGitTokensFile(persisted, dirname(path));
  testHooks.beforeConfigCommit?.();
  renameSync(tmpPath, path);
}

interface TerminalCredentialInvalidationHooks {
  beforeV5Activation?: () => void;
  afterV5Activation?: () => void;
  beforeV5Cleanup?: () => void;
  afterV5Invalidation?: () => void;
}

export function markConfigRevoked(
  path = defaultConfigPath(),
  testHooks: TerminalCredentialInvalidationHooks = {},
): void {
  const result = readConfig(path);
  if (result.config) {
    invalidateActiveGithubGrantGeneration(
      dirname(path),
      testHooks,
      result.config.agentId,
    );
    testHooks.afterV5Invalidation?.();
    writeConfig({ ...result.config, revoked: true }, path);
  }
}

/**
 * P2-T6 self-wipe: clear THIS agent's on-disk GitHub credential material after
 * the server superseded its secret (close code 4409 — attached elsewhere or
 * reassigned), and persist a cause-specific `revokedMessage` so the next
 * SessionStart re-surfaces it (the wipe usually happens in the background
 * daemon while no interactive session is open, so a one-shot stderr line is
 * not enough).
 *
 * Wipes the credential-bearing fields (scoped token, org-keyed map, provider
 * config, cursor projection) while preserving the agent IDENTITY
 * (`agentId`/`agentSecret`/`spellguardBaseUrl`) so the setup command →
 * "select existing agent" can re-attach this machine. `revoked: true` keeps it
 * on the same SessionStart re-surface path as a server-pushed revoke. The
 * companion `git-tokens` file is replaced with an authoritative empty artifact
 * by `writeConfig` → `writeGitTokensFile` (no usable token remains). No-op when
 * there is no config on disk.
 */
export function markConfigSuperseded(
  message: string,
  path = defaultConfigPath(),
  testHooks: TerminalCredentialInvalidationHooks = {},
): void {
  const result = readConfig(path);
  if (!result.config) return;
  invalidateActiveGithubGrantGeneration(
    dirname(path),
    testHooks,
    result.config.agentId,
  );
  testHooks.afterV5Invalidation?.();
  writeConfig(
    {
      agentId: result.config.agentId,
      agentSecret: result.config.agentSecret,
      spellguardBaseUrl: result.config.spellguardBaseUrl,
      agentName: result.config.agentName,
      revoked: true,
      revokedMessage: message,
    },
    path,
  );
}

/**
 * #1348: the agent is quarantined (close 4423, AGENT_SUSPENDED). Drop every
 * GitHub credential this plugin placed: the V5 authority falls to its empty
 * generation and `writeConfig` writes an empty `git-tokens`. Keep the identity,
 * the cursor and the git author, so the daemon keeps reconnecting and a
 * release resumes where it left off. `revoked` stays false: a suspended agent
 * is not a dead one. No-op when there is no config on disk.
 */
export function markConfigSuspended(
  path = defaultConfigPath(),
  testHooks: TerminalCredentialInvalidationHooks = {},
): void {
  const result = readConfig(path);
  if (!result.config) return;
  const current = result.config;
  invalidateActiveGithubGrantGeneration(
    dirname(path),
    testHooks,
    current.agentId,
  );
  testHooks.afterV5Invalidation?.();
  writeConfig(
    {
      agentId: current.agentId,
      agentSecret: current.agentSecret,
      spellguardBaseUrl: current.spellguardBaseUrl,
      agentName: current.agentName,
      gitAuthorName: current.gitAuthorName,
      gitAuthorEmail: current.gitAuthorEmail,
      lastServerSeq: current.lastServerSeq,
      providerConfig: current.providerConfig,
      knownCredentials: [],
      revoked: false,
    },
    path,
  );
}

export function clearConfig(
  path = defaultConfigPath(),
  testHooks: TerminalCredentialInvalidationHooks = {},
): void {
  // Activate the credential-free generation first. If reset is interrupted,
  // the helper therefore sees either the complete old state or this tombstone,
  // never cleared V4 state alongside a stale live V5 generation.
  const currentAgentId = readConfig(path).config?.agentId;
  const configDir = dirname(path);
  if (
    currentAgentId ||
    existsSync(join(configDir, 'github-grants', 'current'))
  ) {
    invalidateActiveGithubGrantGeneration(configDir, testHooks, currentAgentId);
  }
  if (existsSync(path)) {
    writeFileSync(path, '', 'utf-8');
    // writeFileSync doesn't reapply perms on rewrite; re-assert 0o600
    // so the truncated-but-still-readable file is never world-visible on POSIX.
    if (platform() !== 'win32') {
      chmodSync(path, 0o600);
    }
  }
  // Phase C (D13): the git-tokens companion the POSIX-sh git helper reads must
  // not outlive the config — otherwise /spellguard-reset (which calls this to
  // delete the local credential) would leave stale per-org tokens the helper
  // keeps serving. Drop the companion alongside the config.
  for (const resetArtifact of [
    `${path}.bak`,
    `${path}.tmp`,
    gitTokensPath(configDir),
    join(configDir, 'gh-token'),
    join(configDir, 'gh'),
  ]) {
    if (existsSync(resetArtifact)) {
      rmSync(resetArtifact, { force: true, recursive: true });
    }
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function requireRealDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe GitHub generation directory: ${path}`);
  }
}

function removeSiblingGenerations(
  generations: string,
  activeName: string,
): void {
  requireRealDirectory(generations);
  for (const entry of readdirSync(generations, { withFileTypes: true })) {
    if (entry.name === activeName) continue;
    const candidate = join(generations, entry.name);
    if (dirname(candidate) !== generations) {
      throw new Error('unsafe GitHub generation cleanup target');
    }
    const stat = lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(candidate, { recursive: true });
    } else {
      // Unlink top-level symlinks rather than traversing their targets.
      rmSync(candidate);
    }
  }
  syncPath(generations);
}

function invalidateActiveGithubGrantGeneration(
  configDir: string,
  testHooks: TerminalCredentialInvalidationHooks = {},
  configuredAgentId?: string,
): void {
  const root = join(configDir, 'github-grants');
  const generations = join(root, 'generations');
  const deliveryId = randomUUID();
  const generationName = `0-${deliveryId}`;
  const generation = join(generations, generationName);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  requireRealDirectory(root);
  if (!existsSync(generations)) mkdirSync(generations, { mode: 0o700 });
  requireRealDirectory(generations);
  mkdirSync(generation, { mode: 0o700 });
  mkdirSync(join(generation, 'tokens'), { mode: 0o700 });
  let agentId = configuredAgentId;
  if (!agentId) {
    try {
      const active = JSON.parse(
        readPrivateConfigFile(join(root, 'current', 'state.json')),
      ) as {
        agentId?: unknown;
        grants?: Array<{ agent_id?: unknown }>;
      };
      if (typeof active.agentId === 'string') agentId = active.agentId;
      else if (typeof active.grants?.[0]?.agent_id === 'string')
        agentId = active.grants[0].agent_id;
    } catch {
      // No readable prior authority: the zero generation remains fail-closed.
    }
  }
  writeFileSync(
    join(generation, 'state.json'),
    JSON.stringify({
      protocolVersion: 5,
      ...(agentId ? { agentId } : {}),
      deliveryId,
      grantSetRevision: '0',
      grants: [],
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(generation, 'manifest.tsv'), '\n', { mode: 0o600 });
  writeFileSync(join(generation, '.reset-tombstone'), '', { mode: 0o600 });
  syncPath(join(generation, 'state.json'));
  syncPath(join(generation, 'manifest.tsv'));
  syncPath(join(generation, '.reset-tombstone'));
  syncPath(join(generation, 'tokens'));
  syncPath(generation);
  syncPath(generations);
  testHooks.beforeV5Activation?.();
  const pendingCurrent = join(root, `.current.${randomUUID()}.tmp`);
  symlinkSync(join('generations', generationName), pendingCurrent);
  renameSync(pendingCurrent, join(root, 'current'));
  syncPath(root);
  testHooks.afterV5Activation?.();
  testHooks.beforeV5Cleanup?.();
  removeSiblingGenerations(generations, generationName);
}
