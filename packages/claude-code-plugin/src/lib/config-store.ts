// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { FRAMEWORK_SLUG } from './framework-slug';
import { clearGhTokenFile, ghTokenFilePath } from './gh-token-file';

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
  scopeSummary?: { repos: string[] };
  installationId?: number;
  revoked?: boolean;
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
  scopeSummary?: { repos: string[] };
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
 * Phase C (decision D13): the daemon-maintained companion file the POSIX-sh
 * git helper reads to select a token by repo-owner — NO JSON parsing in sh.
 * Lives next to config.json, mode 0600, one `<orgLoginLower>\t<token>` line
 * per unrevoked entry plus a `*\t<token>` wildcard fallback line.
 */
export function gitTokensPath(dir = defaultConfigDir()): string {
  return join(dir, 'git-tokens');
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
 * When no usable token exists the stale file is removed so a revoked-down-to-
 * zero config never leaves a live token on disk.
 */
export function writeGitTokensFile(
  config: SpellguardConfig,
  dir = defaultConfigDir(),
): void {
  const path = gitTokensPath(dir);
  const lines: string[] = [];
  let wildcardToken: string | undefined;
  let usableCount = 0;
  let keyedTotal = 0;

  const keyed = config.githubCredentials;
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

  if (lines.length === 0) {
    // No usable token — drop any stale file rather than leave a dead one.
    if (existsSync(path)) rmSync(path, { force: true });
    return;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const content = `${lines.join('\n')}\n`;
  // Write to a temp file then rename (atomic on POSIX): the git helper reads
  // this file concurrently with daemon rewrites, so a truncate-in-place write
  // could hand the helper a half-written or momentarily-empty token set
  // mid-update (PR #338 review R2-015). Same pattern writeConfig uses.
  const tmpPath = `${path}.tmp`;
  if (platform() !== 'win32') {
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, content, 0, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } else {
    writeFileSync(tmpPath, content, 'utf-8');
  }
  renameSync(tmpPath, path);
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
  return null;
}

export function readConfig(path = defaultConfigPath()): ReadConfigResult {
  if (!existsSync(path)) return { config: null, reason: 'missing' };
  if (platform() !== 'win32') {
    try {
      const stat = statSync(path);
      const mode = stat.mode & 0o777;
      // Treat anything other than 0600 as wrong permissions on POSIX
      if (mode !== 0o600) return { config: null, reason: 'wrong_permissions' };
    } catch {
      return { config: null, reason: 'missing' };
    }
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
    return { config: parsed };
  } catch {
    return { config: null, reason: 'malformed', malformedField: 'json' };
  }
}

export function writeConfig(
  config: SpellguardConfig,
  path = defaultConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const content = JSON.stringify(config, null, 2);

  // Snapshot the previous config to `<path>.bak` BEFORE replacing — a bad
  // write (or an operator mishap) is recoverable, and the snapshot makes
  // "the config changed" auditable (plan Task 2.5, 2026-06-11).
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
      if (platform() !== 'win32') chmodSync(`${path}.bak`, 0o600);
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
  renameSync(tmpPath, path);

  // Phase C (decision D13): keep the daemon-maintained `git-tokens` companion
  // file in lockstep with every config write so the POSIX-sh git helper always
  // has the current per-org token set (and no stale one survives a revoke).
  writeGitTokensFile(config, dirname(path));
}

export function markConfigRevoked(path = defaultConfigPath()): void {
  const result = readConfig(path);
  if (result.config) {
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
 * companion `git-tokens` file is dropped automatically by `writeConfig` →
 * `writeGitTokensFile` (no usable token remains). No-op when there is no
 * config on disk.
 */
export function markConfigSuperseded(
  message: string,
  path = defaultConfigPath(),
): void {
  const result = readConfig(path);
  if (!result.config) return;
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

export function clearConfig(path = defaultConfigPath()): void {
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
  const tokensFile = gitTokensPath(dirname(path));
  if (existsSync(tokensFile)) rmSync(tokensFile, { force: true });
  // Same rule for the GH_TOKEN companion (managed startup auto-update reads it via
  // the login-shell export): a reset must not leave a live token on disk.
  clearGhTokenFile(ghTokenFilePath(dirname(path)));
}
