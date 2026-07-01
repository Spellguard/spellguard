// SPDX-License-Identifier: Apache-2.0

/**
 * Credential daemon — persistent AgentControlClient process.
 *
 * Spawned (detached) by session-start.ts so the long-running WebSocket
 * survives the hook subprocess exiting. The hook exits immediately after
 * spawning; this process stays alive as long as the socket is open.
 *
 * Usage:
 *   node spellguard-credential-daemon.ts <agentId> [--config-dir <path>] [--cwd <path>]
 *
 * The `--config-dir` flag overrides the default XDG config directory and
 * is used by unit tests to run the daemon in-process with an isolated
 * config.
 *
 * The `--cwd` flag, when present, points the daemon at a git working tree
 * so it can host the long-running commit watcher. Hosting the watcher here
 * (rather than in the SessionStart hook process, which exits seconds after
 * the hook returns) keeps it alive for the full Claude Code session
 * lifetime. Single-cwd-per-daemon
 * is intentional: each agent owns one daemon. If a user starts Claude
 * Code in repo A and then in repo B with the same agent, only repo A's
 * watcher runs — multi-cwd would need a sidecar IPC mechanism and is
 * deliberately out of scope. Operators who need both should configure
 * separate agents.
 *
 * PID file:  <config_dir>/agents/<agentId>.pid
 * Log file:  <config_dir>/agents/<agentId>.log
 *
 * Idempotency: if the PID file exists and the process is alive, the daemon
 * exits 0 immediately. The hook that spawns this binary is therefore safe
 * to call on every session-start without duplicating daemons.
 */

import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentControlClient } from '@spellguard/agent-control';
import type { LoginCodeFrame } from '@spellguard/agent-control';
import { emitCommitObservation } from '../src/lib/commit-observation-emitter';
import {
  type SpellguardConfig,
  defaultConfigDir,
  markConfigRevoked,
  readConfig,
  writeConfig,
  writeGitTokensFile,
} from '../src/lib/config-store';
import {
  handleAuthFailedClose,
  handleConfigUpdate,
  handleCredentialRevoked,
  handleCredentialUpdate,
  isHandshakeAuthRejection,
} from '../src/lib/credential-handlers';
import { openEditStore } from '../src/lib/edit-store';
import { ensureStableHelper } from '../src/lib/env-file-writer';
import {
  ghConfigDirPath,
  writeGhSessionConfig,
} from '../src/lib/gh-config-dir';
import { ghTokenFilePath, writeGhTokenFile } from '../src/lib/gh-token-file';
import { resolveGitRoot } from '../src/lib/git-root';
import { parseShowDiff } from '../src/lib/git-show-parser';
import { checkLogAllRefUpdates } from '../src/lib/log-all-ref-updates-probe';
import type {
  LoginRelayUpdate,
  PtyHandle,
} from '../src/lib/login-relay-handler';
import {
  defaultIsLoggedIn,
  defaultMarkAuthenticated,
  makeNodePtySpawner,
  runLoginRelay,
} from '../src/lib/login-relay-handler';
import { resolveSshRewriteRepo } from '../src/lib/ssh-remote-detect';
import { startCommitWatcher } from '../src/monitors/commit-watcher';
import { wipeSupersededCredentials } from '../src/skills/spellguard-reset';

// ── Git diff capture constants ────────────────────────────────────────────────

// 64 MB maxBuffer for `git show` diff capture — identical to
// GIT_BODY_MAX_BUFFER in commit-watcher.ts. Large merge commits
// and monorepo diffs can exceed Node's default 1 MB limit, causing ENOBUFS.
// Exporting so tests can verify the value is consistent with the project
// convention and assert against it directly.
export const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  agentId: string;
  configDir: string;
  cwd: string | null;
} {
  // argv = ['node', 'script', agentId, ...flags]
  const args = argv.slice(2);
  const agentId = args[0];
  if (!agentId) {
    process.stderr.write(
      'spellguard-credential-daemon: missing required argument <agentId>\n',
    );
    process.exit(1);
  }

  let configDir = defaultConfigDir();
  const configDirIdx = args.indexOf('--config-dir');
  if (configDirIdx !== -1 && args[configDirIdx + 1]) {
    configDir = args[configDirIdx + 1] as string;
  }

  // Optional. When present, the daemon hosts the commit watcher rooted at
  // this directory. session-start.ts always passes the user's process.cwd()
  // here; tests omit it to keep the daemon focused on the credential path.
  let cwd: string | null = null;
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    cwd = args[cwdIdx + 1] as string;
  }
  return { agentId, configDir, cwd };
}

// ── PID / log file path helpers (exported for tests) ─────────────────────────

function agentsDir(configDir: string): string {
  return join(configDir, 'agents');
}

// ── REQ-003: login-relay gate (exported for unit tests) ──────────────────────

/**
 * Compute whether the login relay should AUTO-START at boot. Injectable deps so
 * tests can control all inputs without touching the real filesystem or
 * process.env.
 *
 * Rules (ALL must be true):
 *   1. The managed boot path ENABLED the relay (`relayEnabled`). Only the
 *      managed systemd unit sets SPELLGUARD_LOGIN_RELAY (developer machines do
 *      not), so this gates the relay off entirely on an unmanaged box.
 *   2. The relay is in AUTO-START mode (`autoStart`). The managed unit chooses
 *      between two modes via the SPELLGUARD_LOGIN_RELAY VALUE:
 *        - '1'    → enabled + auto-start at boot (legacy behaviour).
 *        - 'wait' → enabled but USER-INITIATED: the daemon wires the relay (the
 *                   onLoginRestart handler is always registered) but does NOT
 *                   spawn `claude auth login --claudeai` at boot. The relay
 *                   starts only when the operator clicks "Start login" in the
 *                   dashboard (a login_restart down-frame). The managed Claude
 *                   box ships 'wait' so the short-lived OAuth URL/exchange is
 *                   created WHILE the operator is present, not during the
 *                   minutes-long provision while they are away.
 *   3. CLAUDE_CODE_OAUTH_TOKEN env var is absent/empty (already-authorized
 *      developer machine or daemon restart with token baked into EnvironmentFile).
 *   4. The on-disk token file (~/.claude-oauth-token) does NOT exist (primary
 *      guard for daemon restart — the EnvironmentFile may carry an empty
 *      CLAUDE_CODE_OAUTH_TOKEN value on the very first start, before the relay
 *      writes the token; file-presence is authoritative).
 *
 * `autoStart` ONLY gates the boot-time auto-spawn; the operator-initiated
 * restart path is never gated on it (it is the whole point of 'wait' mode).
 */
export function computeNeedsLoginRelay(opts: {
  relayEnabled: boolean;
  autoStart: boolean;
  oauthTokenEnv: string | undefined;
  oauthTokenFileExists: boolean;
}): boolean {
  return (
    opts.relayEnabled &&
    opts.autoStart &&
    !opts.oauthTokenEnv &&
    !opts.oauthTokenFileExists
  );
}

/**
 * FIND-DA19: login_code re-delivery dedupe gate (exported for unit tests).
 *
 * The control plane buffers a `login_code` in the DO and re-delivers it on the
 * box's next `Resume` (the agent-control socket flaps ≈every 5 min during the
 * relay's idle wait, so a code pushed mid-flap would otherwise be lost). That
 * means the daemon can receive the SAME code twice — once on the live
 * push-broadcast and again on a Resume re-delivery — and feeding the same code
 * to `claude auth login` more than once would write the duplicate into the pty
 * and could break the in-flight exchange.
 *
 * `accept(code)` returns `true` the first time it sees a value and `false` for
 * an immediate repeat of that same value (the re-delivery), so the caller acts
 * on a code at most once. A genuinely NEW code (a different value, e.g. on a
 * corrected entry or a fresh re-login) is accepted. `reset()` clears the gate
 * so a `login_restart` can legitimately re-accept the same code value for the
 * new attempt.
 */
export function makeLoginCodeDedupe(): {
  accept: (code: string) => boolean;
  reset: () => void;
} {
  let lastAccepted: string | null = null;
  return {
    accept(code: string): boolean {
      if (code === lastAccepted) {
        return false;
      }
      lastAccepted = code;
      return true;
    },
    reset(): void {
      lastAccepted = null;
    },
  };
}

export function pidFilePath(configDir: string, agentId: string): string {
  return join(agentsDir(configDir), `${agentId}.pid`);
}

export function logFilePath(configDir: string, agentId: string): string {
  return join(agentsDir(configDir), `${agentId}.log`);
}

// ── PID helpers ───────────────────────────────────────────────────────────────

function readPidFileSync(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────

let _logPath: string | null = null;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (_logPath) {
    try {
      // Create/append with mode 0o600 so the log file is never
      // readable by other local users regardless of the process umask.
      appendFileSync(_logPath, line, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // silently ignore if log file is gone
    }
  } else {
    process.stderr.write(line);
  }
}

// ── Helpers extracted to keep main() under the complexity budget ──────────────

/**
 * Atomically claim the PID file using O_EXCL | O_CREAT (the 'wx' flag).
 * Only one concurrent process can win the open(); the loser sees EEXIST,
 * checks whether the winner is alive, and exits cleanly if so.
 *
 * Honest boolean contract — returns true when the slot is claimed,
 * false when it cannot be acquired (another live daemon holds it, or the
 * stale-retry also fails). The CALLER is responsible for acting on false
 * (e.g. logging "another instance running" and calling process.exit(0)).
 * This keeps exit policy out of the mechanism function and makes it
 * unit-testable.
 *
 * Non-EEXIST FS errors are re-thrown as unexpected failures.
 *
 * Exported so integration tests can drive the function directly without
 * spawning a subprocess.
 */
export function acquirePidSlot(
  pidPath: string,
  agentId: string,
  logFn: (msg: string) => void = log,
): boolean {
  let fd: number;
  try {
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic, fails if file exists.
    // Pass mode 0o600 so the kernel creates the file with tight
    // permissions regardless of the process umask.
    fd = openSync(pidPath, 'wx', 0o600);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Another process raced us. Check if it's still alive.
      const existingPid = readPidFileSync(pidPath);
      if (existingPid !== null && isProcessAlive(existingPid)) {
        // Return false — caller decides to exit (keeps exit policy
        // out of this mechanism function so it is unit-testable).
        // No logFn here: the caller emits the single "another daemon instance
        // is already running; exiting" line so each false path produces exactly
        // ONE operator log line.
        return false;
      }
      // Stale PID file — unlink it and retry once.
      try {
        unlinkSync(pidPath);
      } catch {
        // ignore — another process may have cleaned it up between reads
      }
      // Second attempt: if this also fails we bail out to avoid a spin.
      try {
        // Mode 0o600 on the retry path as well.
        fd = openSync(pidPath, 'wx', 0o600);
      } catch {
        // Return false — caller exits 0 cleanly.
        // No logFn here: same single-log discipline as the live-held path.
        return false;
      }
    } else {
      throw err;
    }
  }

  // openSync with O_EXCL guarantees a freshly-created file here, so
  // there is no pre-existing file to tighten. The chmod overrides the process
  // umask: open(2) applies `mode & ~umask`, so a restrictive umask (e.g.
  // 0o177) would produce 0o400; chmodSync forces exactly 0o600 regardless.
  chmodSync(pidPath, 0o600);
  const pidStr = String(process.pid);
  writeSync(fd, pidStr, 0, 'utf-8');
  closeSync(fd);
  logFn(`daemon started (pid=${process.pid}, agentId=${agentId})`);
  return true;
}

/** Exit with code 1 after removing the PID file. */
function exitFailure(pidPath: string, msg: string): never {
  log(msg);
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
  process.exit(1);
}

/** Read and validate the config. Calls exitFailure on any problem. */
function loadConfig(configPath: string, pidPath: string): SpellguardConfig {
  const readResult = readConfig(configPath);
  if (!readResult.config) {
    exitFailure(
      pidPath,
      `config not found or unreadable (reason=${readResult.reason ?? 'unknown'}); exiting`,
    );
  }
  const config = readResult.config;
  if (!config.agentSecret)
    exitFailure(
      pidPath,
      'config missing agentSecret; re-run /spellguard-setup to provision a new credential',
    );
  if (!config.agentId) exitFailure(pidPath, 'config missing agentId; exiting');
  return config;
}

// ── Git show diff capture ───────────────────────────────────────────

/**
 * Capture the unified diff for a single commit SHA via `git show`.
 *
 * Exported so tests can inject a mock `execGitShow` and assert the
 * ENOBUFS → warn + null behaviour without spawning a real git process.
 *
 * @param params.sha         - 40-char hex SHA of the commit to show.
 * @param params.gitRoot     - Absolute path to the git working tree.
 * @param params.logFn       - Operator-facing logger (daemon's `log()`).
 * @param params.execGitShow - Injectable executor; defaults to the real
 *                             `execFileSync('git', ['show', sha], ...)` call
 *                             with `maxBuffer: GIT_DIFF_MAX_BUFFER`.
 * @returns Parsed diff record, or `null` on any exec failure (ENOBUFS, non-
 *          zero exit, etc.) — caller should skip the diff and continue.
 */
export function captureGitShowDiff(params: {
  sha: string;
  gitRoot: string;
  logFn: (msg: string) => void;
  execGitShow?: (sha: string, gitRoot: string) => string;
}): ReturnType<typeof parseShowDiff> | null {
  const { sha, gitRoot, logFn } = params;
  const execGitShow =
    params.execGitShow ??
    ((s: string, root: string): string =>
      execFileSync('git', ['show', s], {
        cwd: root,
        encoding: 'utf8',
        // Explicit 64 MB maxBuffer — identical to GIT_BODY_MAX_BUFFER
        // in commit-watcher.ts. Without this the Node default of
        // 1 MB is used, and a large merge commit throws ENOBUFS which was
        // previously swallowed silently.
        maxBuffer: GIT_DIFF_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
  try {
    const out = execGitShow(sha, gitRoot);
    return parseShowDiff(out);
  } catch (err) {
    // Structured operator warning — visible in the daemon log file
    // (not silently dropped). Include the SHA for operator diagnosis.
    // Degrade gracefully: return null so the caller skips this diff but
    // continues processing; the daemon must not crash.
    logFn(`[daemon] git show failed for ${sha} (diff skipped): ${String(err)}`);
    return null;
  }
}

// ── Expiry watcher ──────────────────────────────────────────────────

/**
 * Collect the (scopedTokenId, expiresAt) entries the expiry watcher should
 * monitor: the Phase C org-keyed map (unrevoked entries only) when present,
 * else the legacy single-slot top-level fields. Identity-only configs (no
 * github credential yet) yield an empty list — the watcher stays idle.
 */
function collectExpiryEntries(
  config: SpellguardConfig,
): Array<{ scopedTokenId: string; expiresAt: string }> {
  const keyed = config.githubCredentials;
  if (keyed && Object.keys(keyed).length > 0) {
    const out: Array<{ scopedTokenId: string; expiresAt: string }> = [];
    for (const e of Object.values(keyed)) {
      if (e.revoked || !e.expiresAt || !e.scopedTokenId) continue;
      out.push({ scopedTokenId: e.scopedTokenId, expiresAt: e.expiresAt });
    }
    return out;
  }
  const { expiresAt, scopedTokenId } = config;
  return expiresAt && scopedTokenId ? [{ scopedTokenId, expiresAt }] : [];
}

/**
 * Check whether any persisted GitHub credential is near expiry and, if so,
 * trigger a proactive per-credential refresh via the agent-control client.
 *
 * Exported so unit tests can call it directly without waiting for the 60 s
 * `setInterval` to fire.
 *
 * Phase C: a machine may hold N GitHub credentials (one per org) in the
 * config's `githubCredentials` map. This iterates EVERY unrevoked entry and
 * fires one `requestRefresh` per near-expiry entry, each carrying that entry's
 * own `scopedTokenId` as `superseded_scoped_token_id` so the server refreshes
 * the right credential's lineage. In-flight is tracked PER scopedTokenId (a
 * `Set<string>`) so one slow refresh never blocks a sibling org's refresh and
 * a single token never has two refreshes outstanding. When the keyed map is
 * absent the legacy top-level `{expiresAt, scopedTokenId}` fields are used
 * (single-org back-compat). Exit-on-revoked fires only when ALL entries are
 * revoked.
 *
 * @param clientRef - The running AgentControlClient.
 * @param cfgPath   - Path to config.json on disk.
 * @param inFlight  - The set of scopedTokenIds with a refresh outstanding.
 * @param logFn     - Logger (defaults to the module-level `log` function).
 * @returns true if at least one refresh was triggered, false otherwise.
 */
export function checkExpiryAndRefresh(
  clientRef: AgentControlClient,
  cfgPath: string,
  inFlight: Set<string>,
  logFn: (msg: string) => void = log,
  /**
   * Graceful-shutdown hook. When the watcher observes that the whole config
   * is revoked (all entries dead), it calls this instead of bare
   * `process.exit(0)` so the PID file is unlinked, the WebSocket is closed
   * cleanly, and the expiry interval is cleared. Optional for backwards compat
   * with unit tests that don't construct the daemon's full shutdown plumbing.
   */
  shutdownFn?: () => void,
): boolean {
  const cur = readConfig(cfgPath);
  if (!cur.config) return false;
  // A whole-config revoke will never refresh — the server rejects
  // requestRefresh with credential_revoked. Without this guard the daemon
  // re-fires every 60s, blocks the refresh chain on the resulting error
  // frame's 30s timeout (until the short-circuit fires), and wakes the
  // channel for nothing. Exit so the dead daemon is reaped instead of
  // sitting on a permanently revoked credential. (Whole-config revoked is
  // only set once the LAST github entry dies — see handleCredentialRevoked.)
  if (cur.config.revoked) {
    logFn('credential is revoked; daemon exiting (re-run /spellguard-setup)');
    if (shutdownFn) {
      shutdownFn();
      return false;
    }
    process.exit(0);
  }

  // Build the list of (scopedTokenId, expiresAt) entries to monitor: the
  // keyed map (Phase C) when present, else the legacy single-slot fields.
  // Identity-only configs (bootstrap complete, no GitHub credential yet
  // through the channel) yield an empty list — the daemon stays running and
  // idle until a `credential_delivered` frame writes the scoped fields.
  const entries = collectExpiryEntries(cur.config);

  const nearExpiryMs = 10 * 60 * 1000; // 10 minutes — matches near_expiry threshold
  let triggeredAny = false;
  for (const entry of entries) {
    // One refresh per token at a time (per-credential in-flight guard).
    if (inFlight.has(entry.scopedTokenId)) continue;
    const msUntilExpiry = new Date(entry.expiresAt).getTime() - Date.now();
    if (msUntilExpiry >= nearExpiryMs) continue;

    inFlight.add(entry.scopedTokenId);
    triggeredAny = true;
    void clientRef
      .requestRefresh({
        reason: 'expiry',
        provider: 'github',
        superseded_scoped_token_id: entry.scopedTokenId,
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message !== 'client_closed') {
          logFn(`expiry refresh failed: ${(err as Error).message}`);
        }
      })
      .finally(() => {
        inFlight.delete(entry.scopedTokenId);
      });
  }
  return triggeredAny;
}

// ── REQ-003: login-relay startup (TC-005 failed-state observability) ─────────

/**
 * Start (or restart) the in-box login relay and make a STARTUP failure
 * observable to the dashboard.
 *
 * Why this exists (REQ-003 / TC-005): the relay startup has TWO awaited
 * side-effectful steps that can throw BEFORE `runLoginRelay`'s own
 * `finish(false, …)` path can fire a `failed` update —
 *   1. `makeNodePtySpawner()` — the dynamic `import('node-pty')` rejects when
 *      the native addon can't load for this Node/arch.
 *   2. the `claude auth login` pty spawn inside `runLoginRelay`, which can
 *      throw synchronously if the binary is missing.
 * If either throws, `runLoginRelay`'s internal `sendUpdate({state:'failed'})`
 * never runs, so without this wrapper the only signal is a LOCAL log line and
 * the dashboard's Authorize-Claude card hangs forever on
 * "Waiting for the agent box to start the login flow…".
 *
 * This wraps the whole startup in try/catch and, on failure, sends a
 * `login_relay_update{state:'failed', message}` UP the control channel via the
 * SAME `sendUpdate` callback the relay already uses for `url_ready` /
 * `authorized` (wired by the daemon to `client.sendLoginRelayUpdate`) BEFORE
 * logging — so the DO persists `login_state='failed'` and the dashboard shows
 * the generic failed state + Restart action. Graceful-degrade is preserved:
 * the credential socket keeps working; only the relay is degraded.
 *
 * Exported so a unit test can drive the failed-state report without spawning a
 * real pty or socket.
 *
 * @returns the relay result on success, or `null` when startup threw (the
 *          failure was already reported up-channel + logged).
 */
export async function startLoginRelay(deps: {
  makeSpawner: () => Promise<(cmd: string, args: string[]) => PtyHandle>;
  runRelay: (
    args: Parameters<typeof runLoginRelay>[0],
  ) => Promise<{ ok: boolean }>;
  sendUpdate: (update: LoginRelayUpdate) => void;
  markAuthenticated: () => void;
  isLoggedIn: () => Promise<boolean>;
  waitForCode: () => Promise<string>;
  signal: AbortSignal;
  logFn: (msg: string) => void;
  /** Label distinguishing the initial start from a restart in log lines. */
  label?: string;
}): Promise<{ ok: boolean } | null> {
  const tag = deps.label ? ` (${deps.label})` : '';
  try {
    const spawnPty = await deps.makeSpawner();
    const result = await deps.runRelay({
      spawnPty,
      sendUpdate: deps.sendUpdate,
      markAuthenticated: deps.markAuthenticated,
      isLoggedIn: deps.isLoggedIn,
      waitForCode: deps.waitForCode,
      signal: deps.signal,
    });
    deps.logFn(`login relay${tag} completed ok=${result.ok}`);
    return result;
  } catch (err: unknown) {
    const detail = (err as Error)?.message ?? String(err);
    // TC-005: report the STARTUP failure up the control channel on the SAME
    // path the relay uses for url_ready/authorized, so the dashboard leaves the
    // "waiting…" state and shows the generic failed state + Restart action.
    // Sent BEFORE the local log so the observable signal is never lost even if
    // logging throws. Aborts (login_restart killed the old relay) are NOT a
    // failure to surface — the new relay owns the dashboard state.
    if (!deps.signal.aborted) {
      try {
        deps.sendUpdate({
          state: 'failed',
          message: `login relay failed to start: ${detail}`,
        });
      } catch (sendErr) {
        deps.logFn(
          `login relay${tag} failed-state report could not be sent: ${
            (sendErr as Error)?.message ?? String(sendErr)
          }`,
        );
      }
    }
    deps.logFn(`login relay${tag} error: ${detail}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { agentId, configDir, cwd } = parseArgs(process.argv);

  mkdirSync(agentsDir(configDir), { recursive: true });
  const pidPath = pidFilePath(configDir, agentId);
  _logPath = logFilePath(configDir, agentId);

  // Ensure the log file exists at mode 0o600 before the first write.
  // writeFileSync with flag 'a' (append/create) + mode 0o600 creates the file
  // if absent.  chmodSync tightens a pre-existing file that was created with a
  // looser umask by an older daemon build.
  writeFileSync(_logPath, '', { flag: 'a', mode: 0o600 });
  chmodSync(_logPath, 0o600);

  // acquirePidSlot returns a genuine boolean. The CALLER (here)
  // owns the exit policy — keeping process.exit(0) out of the mechanism
  // function so it is unit-testable and the contract is honest.
  if (!acquirePidSlot(pidPath, agentId)) {
    log('another daemon instance is already running; exiting');
    process.exit(0);
  }

  const configPath = join(configDir, 'config.json');
  const config = loadConfig(configPath, pidPath);

  // PR #338 review R2-008: regenerate the git-tokens companion from the
  // persisted config on boot. If a previous daemon crashed mid-write (or the
  // file was removed out-of-band) the TSV could be missing while config.json
  // still holds the keyed tokens — the git helper would then fail closed for
  // every owner until the next credential frame arrives. Rebuilding it here
  // self-heals that gap before the session's first git operation.
  try {
    writeGitTokensFile(config, configDir);
  } catch (err) {
    log(`startup git-tokens regeneration failed: ${String(err)}`);
  }

  // Pin the gh CLI to the scoped token: refresh the per-agent gh `hosts.yml`
  // from the persisted config on boot (mirrors the git-tokens self-heal above).
  // gh re-reads it on every invocation, so this plus the handler's per-update
  // refresh keep it current across rotations. Never touches ~/.config/gh.
  const ghConfigDir = ghConfigDirPath(configDir, agentId);
  const ghTokenPath = ghTokenFilePath(configDir);
  try {
    if (config?.scopedToken) {
      writeGhSessionConfig({ dir: ghConfigDir, token: config.scopedToken });
    }
  } catch (err) {
    log(`startup gh hosts.yml regeneration failed: ${String(err)}`);
  }

  // Self-heal the GH_TOKEN file from the persisted config on boot (mirrors the
  // git-tokens + gh hosts.yml self-heals above). The managed login-shell snippet
  // exports it for Claude Code's startup plugin-marketplace auto-update; rebuilding
  // it here keeps it current after a daemon restart that missed a frame. The token
  // is never logged (only a generic error string is, on failure).
  try {
    if (config?.scopedToken) {
      writeGhTokenFile(ghTokenPath, config.scopedToken);
    }
  } catch (err) {
    log(`startup gh-token regeneration failed: ${String(err)}`);
  }

  // CLAUDE_ENV_FILE is inherited from the hook's environment. If absent,
  // credential env-file updates are skipped (the socket remains useful for
  // seq-cursor persistence and revocation marking).
  const envFilePath = process.env.CLAUDE_ENV_FILE ?? '';
  if (!envFilePath) {
    log('CLAUDE_ENV_FILE not set; credential env-file updates will be skipped');
  }

  const readCfg = () => readConfig(configPath);
  const writeCfg = (cfg: Parameters<typeof writeConfig>[0]) =>
    writeConfig(cfg, configPath);

  // Consecutive WebSocket upgrade-time auth rejections (leg-B backstop).
  let handshakeAuthRejections = 0;

  // Resolve the repo identity ONCE from the daemon's working tree so token
  // rotation regenerates the full SSH->HTTPS rule set (rules 1-4) in this
  // session's env file — not just the host-level rules 1/2. The daemon is
  // single-cwd-per-agent (see header), so its `cwd` is the repo it serves.
  const sshRewriteRepo = cwd ? resolveSshRewriteRepo(cwd) : undefined;

  const handlerDeps = {
    envFilePath,
    writeConfigImpl: writeCfg,
    markConfigRevokedImpl: () => markConfigRevoked(configPath),
    readConfigImpl: readCfg,
    ghConfigDir,
    // GH_TOKEN file kept in lockstep with the agent's scoped token (write on
    // delivery/rotation, clear on revoke) for Claude Code's startup
    // plugin-marketplace auto-update (see gh-token-file.ts).
    ghTokenPath,
    helperPath: ensureStableHelper(configDir),
    sshRewriteRepo,
  };

  const onSeqAdvanced = (seq: string): void => {
    const cur = readCfg();
    if (cur.config) writeCfg({ ...cur.config, lastServerSeq: seq });
  };

  // Persist the cached known_credentials projection on every change
  // so a daemon restart sends a real Resume frame instead of [] (which trips
  // server-side divergence detection and silently rotates credentials).
  const onKnownCredentialsChanged = (
    known: Array<{ provider: string; scoped_token_id: string }>,
  ): void => {
    const cur = readCfg();
    if (cur.config) writeCfg({ ...cur.config, knownCredentials: known });
  };

  // Per-credential in-flight guard (Phase C): tracks the scopedTokenIds with
  // an expiry refresh outstanding so the same token never has two refreshes
  // queued, while distinct orgs refresh independently. The client's
  // #refreshChain still serializes the actual socket sends.
  const expiryInFlight = new Set<string>();

  // Forward-declare so the AgentControlClient onCredentialRevoked
  // closure can reference `shutdown` defined below (after the client +
  // expiryInterval are constructed).
  let shutdown: () => void = () => process.exit(0);

  // ── REQ-003: login-relay wiring ────────────────────────────────────────────
  //
  // Gate: only start the relay when the box is NOT already authorized. Two
  // independent checks defend against re-running on daemon restart:
  //
  //   1. CLAUDE_CODE_OAUTH_TOKEN env var — set by the EnvironmentFile on
  //      restart once the boot script has written the token; present on
  //      developer machines that sourced the env.
  //   2. ~/.claude-oauth-token file — the login-done sentinel written by the
  //      relay handler (defaultMarkAuthenticated). On the very first daemon start the
  //      EnvironmentFile may carry an empty value (boot script runs before the
  //      relay completes), so file-presence is the authoritative guard for
  //      subsequent restarts even when the env-var is stale or absent.
  //
  // Also gate on the SPELLGUARD_LOGIN_RELAY env var being enabled to avoid
  // starting the relay on every daemon restart (only the managed first-boot
  // path sets it — via the systemd unit Environment= directive). The VALUE
  // selects the start mode (REQ-C03 user-initiated change, ported from Codex):
  //   - '1'    → relay enabled + AUTO-START at boot (legacy behaviour).
  //   - 'wait' → relay enabled but USER-INITIATED: wire the relay handlers (the
  //              onLoginRestart handler is registered regardless) but do NOT
  //              spawn `claude auth login --claudeai` at boot. The relay starts
  //              only on the operator's "Start login" (a login_restart
  //              down-frame). The managed Claude box ships 'wait' so the
  //              short-lived OAuth URL/exchange is minted while the operator is
  //              present, not during the away-from-keyboard provision.
  const oauthTokenFile = join(homedir(), '.claude-oauth-token');
  const loginRelayEnv = process.env.SPELLGUARD_LOGIN_RELAY;
  const loginRelayEnabled = loginRelayEnv === '1' || loginRelayEnv === 'wait';
  const loginRelayAutoStart = loginRelayEnv === '1';
  const needsLoginRelay = computeNeedsLoginRelay({
    relayEnabled: loginRelayEnabled,
    autoStart: loginRelayAutoStart,
    oauthTokenEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    oauthTokenFileExists: existsSync(oauthTokenFile),
  });

  // DA35 — re-assert the terminal `authorized` login state with backoff. The
  // live `login_relay_update{authorized}` is sent the INSTANT login completes,
  // which can race a freshly-reconnected channel's identity settle: the DO
  // rejects it (`Ack{agent_unknown}`) and never persists it. FIND-DA28's
  // onConnect re-assert only re-fires on the NEXT reconnect — which may be many
  // minutes off — so the dashboard sticks on "Authorize Claude" even though the
  // box is authenticated (observed on a deployed box: login completed but
  // `login_state` stayed `pending` for ~30 min until an unrelated soft-kick
  // forced a reconnect). Re-assert a few times with backoff AFTER login
  // completion (and on connect), independent of any reconnect. Idempotent: the
  // DO just re-persists `authorized`. No token on disk == login still pending,
  // so it is never reported.
  const AUTHORIZED_REASSERT_DELAYS_MS = [2500, 6000, 15000];
  function scheduleAuthorizedReassert(): void {
    for (const delay of AUTHORIZED_REASSERT_DELAYS_MS) {
      setTimeout(() => {
        if (existsSync(oauthTokenFile)) {
          client.sendLoginRelayUpdate({ state: 'authorized' });
        }
      }, delay);
    }
  }

  // Queue of pending `waitForCode` resolvers. `onLoginCode` calls the first
  // pending resolver; if none is queued yet the code is buffered for the next
  // call. This handles the race where the code arrives before `waitForCode`
  // is called (unlikely but possible on fast networks).
  let pendingCodeResolve: ((code: string) => void) | null = null;
  let bufferedCode: string | null = null;
  // FIND-DA19: the control plane now BUFFERS a login_code and re-delivers it on
  // the box's next Resume (the agent-control socket flaps ≈every 5 min during
  // the relay's idle wait, so a code pushed mid-flap is otherwise lost). That
  // means the same code can arrive twice — once on the live push-broadcast and
  // again on a Resume re-delivery. The dedupe gate feeds a given code to
  // `claude auth login` AT MOST ONCE; a genuinely new code on a re-login has a
  // different value and is never deduped, and a `login_restart` resets the gate.
  const loginCodeDedupe = makeLoginCodeDedupe();

  // AbortController for the currently in-flight login relay. Replaced on
  // each login_restart so the old relay's pty is killed before the new one
  // starts — prevents two concurrent ptys running simultaneously.
  let relayAbortController: AbortController | null = null;

  function makeWaitForCode(): Promise<string> {
    return new Promise<string>((resolve) => {
      if (bufferedCode !== null) {
        const code = bufferedCode;
        bufferedCode = null;
        resolve(code);
        return;
      }
      pendingCodeResolve = resolve;
    });
  }

  const client = new AgentControlClient({
    apiBaseUrl: config.spellguardBaseUrl,
    agentId: config.agentId,
    // Phase C: this plugin can hold one GitHub credential per GitHub org
    // simultaneously (org-keyed store + git-tokens routing + per-credential
    // daemon refresh), so it advertises the github_multi_org capability. The
    // server relaxes Phase B's single-org-per-agent restriction only for
    // capable agents.
    capabilities: ['github_multi_org'],
    initialLastServerSeq: config.lastServerSeq,
    // Replay the cached projection so the first Resume after restart
    // matches the server's live row set and divergence detection stays quiet.
    initialKnownCredentials: config.knownCredentials,
    credentials: () => ({
      mode: 'secret' as const,
      agentId: config.agentId,
      agentSecret: config.agentSecret,
    }),
    onCredentialDelivered: (frame) =>
      handleCredentialUpdate(frame, handlerDeps),
    onCredentialRotated: (frame) => handleCredentialUpdate(frame, handlerDeps),
    onCredentialRevoked: (frame) => {
      // Phase C: a revoke targets ONE org entry. Handle the per-entry revoke
      // (marks that entry revoked + regenerates git-tokens, dropping only its
      // line) and shut down ONLY when no unrevoked github entry remains. While
      // a sibling org survives, the daemon stays alive so its pushes keep
      // working — only the revoked org's pushes fail. (Pre-C, every revoke
      // tore the whole config down; that path still fires when the LAST entry
      // dies, where handleCredentialRevoked returns false.)
      const anyRemaining = handleCredentialRevoked(frame, handlerDeps);
      if (!anyRemaining) {
        log('credential_revoked received (last entry); shutting down daemon');
        shutdown();
      } else {
        log(
          'credential_revoked received for one org; sibling credentials remain — daemon staying alive',
        );
      }
    },
    // Persist config_updated descriptors to the local config-store.
    onConfigUpdated: (frame) => handleConfigUpdate(frame, handlerDeps),
    // FIND-DA28 — on every (re)connect, RE-ASSERT the terminal login state when
    // a token already exists on disk. The relay's one-shot
    // login_relay_update{authorized} is fire-and-forget; if the channel was
    // mid-churn at login completion (e.g. a credential admin_reissue /
    // credential_request_timeout in the same window) the update is silently
    // dropped and — because `authorized` is terminal — nothing ever re-sends it,
    // so the dashboard sticks on "Authorize Claude" even though the box is
    // authenticated. A token on disk == login succeeded, so re-send `authorized`
    // (idempotent: the DO just re-persists it) to heal a dropped update AND to
    // reflect the authed state after a daemon restart (where the relay does not
    // re-run, per the needsLoginRelay gate). No token → no-op (a real login still
    // pending must not be reported authorized).
    onConnect: () => {
      // No token == a real login is still pending; must NOT report authorized.
      if (!existsSync(oauthTokenFile)) return;
      // Re-assert authorized with backoff (DA35): onConnect fires on the raw
      // socket 'open', which can arrive BEFORE the DO has stored this
      // connection's channel identity — a frame sent in that window is rejected
      // (`Ack{agent_unknown}`) and never persists. The staggered retries ride
      // past the identity settle (the single 2.5s send used to silently no-op
      // when the settle ran long).
      scheduleAuthorizedReassert();
    },
    onSeqAdvanced: (seq) => {
      // Any applied frame proves the channel authenticated — reset the
      // upgrade-rejection counter (see onError below).
      handshakeAuthRejections = 0;
      return onSeqAdvanced(seq);
    },
    onKnownCredentialsChanged,
    onFatalClose: (code, reason) => {
      // 4401 = server no longer recognizes this agent (deleted/revoked).
      // Persist that locally before exiting so setup + session-start see it
      // (I12 — the offline counterpart of the credential_revoked push).
      handleAuthFailedClose(code, handlerDeps);
      exitFailure(
        pidPath,
        `fatal close: code=${code} reason=${reason}; exiting`,
      );
    },
    // P2-T6 (FR-10/NR-3/D11): the server superseded this agent's secret with a
    // 4409 close — a DELIBERATE move (attached on another machine) or reassign.
    // This is the SOLE trigger for the local self-wipe; the shared client
    // dispatches it ONLY on 4409 and never alongside onFatalClose, so a generic
    // auth/transient failure can never reach this path (guardrail confirmed in
    // packages/agent-control/src/client.ts close handler). Clear THIS agent's
    // on-disk credentials and persist the cause-specific message so the next
    // SessionStart re-surfaces it (the wipe runs in the background daemon with
    // no interactive session open). Then shut the daemon down cleanly — the
    // client has already closed the socket.
    onCredentialSuperseded: (cause) => {
      log(`credential superseded (cause=${cause}); wiping local credentials`);
      try {
        wipeSupersededCredentials({
          cause,
          configPath,
          envFilePath,
          ghConfigDir,
          ghTokenFile: ghTokenPath,
        });
      } catch (err) {
        log(`self-wipe failed: ${(err as Error)?.message ?? String(err)}`);
      }
      shutdown();
    },
    onInfo: (message) => {
      // Expected protocol events (e.g. redacted hibernation replay) — not
      // errors (plan Task 2.3 Fix 3).
      log(`info: ${message}`);
    },
    // REQ-003: receive the auth code from the control plane during the
    // headless login relay flow, and re-run the relay on operator request.
    //
    // These handlers are ALWAYS registered — NOT gated on `needsLoginRelay`.
    // Only the INITIAL auto-start of the relay (below) is gated on
    // `needsLoginRelay`; handler REGISTRATION is not. They are cheap no-ops
    // until a frame actually arrives. Gating registration was a silent bug:
    // on a boot where a Claude token already existed (`needsLoginRelay ===
    // false`) the handlers were never wired, so an operator clicking
    // "Restart login" in the dashboard was dropped on the floor — the box
    // never re-ran `claude auth login`. A login_restart is an explicit
    // operator re-auth request and must work even when a token already
    // exists (the fresh relay re-marks it via defaultMarkAuthenticated).
    onLoginCode: (frame: LoginCodeFrame) => {
      // FIND-DA19: the control plane re-delivers a buffered login_code on
      // reconnect, so the same code can arrive twice (push-broadcast + Resume
      // re-delivery). Feed it to `claude auth login` at most once. A genuinely new code
      // on a re-login has a different value and is NOT deduped.
      if (!loginCodeDedupe.accept(frame.code)) {
        log('login_code received (duplicate, ignored)');
        return;
      }
      log('login_code received from control plane');
      if (pendingCodeResolve) {
        const resolve = pendingCodeResolve;
        pendingCodeResolve = null;
        resolve(frame.code);
      } else {
        // Buffer the code in case waitForCode is called after the frame
        bufferedCode = frame.code;
      }
    },
    onLoginRestart: () => {
      log('login_restart received — re-running login relay');
      // Abort the currently in-flight relay (if any) so its pty is
      // killed before we start a new one. Without this, two concurrent
      // ptys run until the old one times out.
      if (relayAbortController) {
        relayAbortController.abort();
      }
      // Fresh controller for the new relay.
      relayAbortController = new AbortController();
      const signal = relayAbortController.signal;
      // Reset pending code state for the new relay.
      pendingCodeResolve = null;
      bufferedCode = null;
      // FIND-DA19: clear the dedupe gate too — a restart begins a fresh login
      // attempt, so the operator may legitimately re-enter the same code value.
      loginCodeDedupe.reset();
      // TC-005: route the restart through startLoginRelay so a startup failure
      // (node-pty load error / claude auth login can't spawn) is reported UP
      // the channel as login_relay_update{state:'failed'} — not just logged
      // locally. Without this an operator who clicks Restart on a box where the
      // relay can't start would see the dashboard hang on "waiting…" again.
      void startLoginRelay({
        makeSpawner: makeNodePtySpawner,
        runRelay: runLoginRelay,
        sendUpdate: (update) => client.sendLoginRelayUpdate(update),
        markAuthenticated: defaultMarkAuthenticated,
        isLoggedIn: defaultIsLoggedIn,
        waitForCode: makeWaitForCode,
        signal,
        logFn: log,
        label: 'restart',
      }).then((r) => {
        // DA35 — same post-completion authorized re-assert as the initial relay.
        if (r?.ok) scheduleAuthorizedReassert();
      });
    },
    onError: (err) => {
      log(`error: ${err.message}`);
      // Leg-B finding (2026-06-11 deployed acceptance): a DELETED agent's
      // reconnect is rejected by the HTTP lobby with a plain 401 BEFORE the
      // WebSocket upgrades — no 4401 close frame ever arrives, so
      // onFatalClose can't fire and the daemon retried the handshake
      // forever without marking the config revoked. Three consecutive
      // upgrade-time auth rejections (without a single applied frame in
      // between) = the server does not know us anymore; rotation-grace
      // windows never produce that pattern.
      if (isHandshakeAuthRejection(err)) {
        handshakeAuthRejections++;
        if (handshakeAuthRejections >= 3) {
          handleAuthFailedClose(4401, handlerDeps);
          exitFailure(
            pidPath,
            `websocket upgrade rejected with auth error ${handshakeAuthRejections}x; treating as deleted/revoked agent and exiting`,
          );
        }
      } else {
        handshakeAuthRejections = 0;
      }
    },
  });

  const expiryInterval = setInterval(
    () =>
      checkExpiryAndRefresh(client, configPath, expiryInFlight, log, shutdown),
    60_000,
  );

  // Host the long-running commit watcher in the daemon so it survives the
  // hook process exit. The watcher tails .git/logs/HEAD via fs.watch with
  // `persistent: true`; hosting it in the hook process instead would die
  // seconds after session-start returned and silently drop every subsequent
  // commit. Failure is non-fatal — credential management must continue
  // regardless.
  let commitWatcherStop: (() => Promise<void>) | undefined;
  if (cwd) {
    commitWatcherStop = await maybeStartCommitWatcher({
      cwd,
      agentId: config.agentId,
      agentSecret: config.agentSecret,
      baseUrl: config.spellguardBaseUrl,
      log,
    });
  }

  // Graceful shutdown helper used by signals AND by the
  // checkExpiryAndRefresh / onCredentialRevoked paths. Unlinks PID file,
  // closes the WebSocket, clears the interval — replaces the prior bare
  // process.exit(0) which leaked the PID file and skipped client cleanup.
  let shutdownInProgress = false;
  shutdown = () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    log('shutting down');
    clearInterval(expiryInterval);
    if (commitWatcherStop) {
      // Best-effort: the watcher's stop() is async but we don't await
      // because shutdown() must remain synchronous (it's a SIGTERM
      // handler). Floating promise; errors are logged.
      commitWatcherStop().catch((err: unknown) => {
        log(
          `commit watcher stop failed: ${(err as Error)?.message ?? String(err)}`,
        );
      });
    }
    client.close();
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  client.start();

  // REQ-003: AUTO-START the login relay flow when gated (=1 auto-start mode,
  // box not already authorized). The relay drives `claude auth login
  // --claudeai` in a pty, streams the OAuth URL up the channel, waits for the
  // user code to arrive via `onLoginCode`, and writes the on-box login marker.
  // Non-fatal: if the relay fails, the daemon continues serving the credential
  // socket normally. REQ-C03: in 'wait' mode the relay is NOT auto-started here
  // — it waits for the operator's "Start login" click (a login_restart
  // down-frame, handled by the always-registered onLoginRestart handler).
  if (needsLoginRelay) {
    log(
      'starting login relay (SPELLGUARD_LOGIN_RELAY=1, no token in env or on disk)',
    );
    // Track the initial relay's controller so a login_restart can abort it.
    relayAbortController = new AbortController();
    const initialSignal = relayAbortController.signal;
    // makeNodePtySpawner uses a dynamic import so the bundler does not try
    // to statically include node-pty (a native module) in the daemon binary.
    //
    // TC-005: startLoginRelay wraps the spawner+relay startup in try/catch and,
    // on failure, sends login_relay_update{state:'failed'} UP the channel (same
    // path as url_ready/authorized) BEFORE logging — so the dashboard shows the
    // failed state + Restart action instead of hanging on "waiting…". Graceful
    // degrade is preserved: the credential socket keeps serving regardless.
    void startLoginRelay({
      makeSpawner: makeNodePtySpawner,
      runRelay: runLoginRelay,
      sendUpdate: (update) => client.sendLoginRelayUpdate(update),
      markAuthenticated: defaultMarkAuthenticated,
      isLoggedIn: defaultIsLoggedIn,
      waitForCode: makeWaitForCode,
      signal: initialSignal,
      logFn: log,
    }).then((r) => {
      // DA35 — heal a login_relay_update{authorized} dropped because the live
      // frame raced the channel reconnect that delivered the code (both the
      // live send AND the onConnect re-assert can miss the identity settle).
      if (r?.ok) scheduleAuthorizedReassert();
    });
  } else if (loginRelayEnabled && !loginRelayAutoStart) {
    // REQ-C03 'wait' mode (user-initiated): the relay is wired but NOT
    // auto-started. The box boots "login-ready" and waits for the operator's
    // "Start login" click (a login_restart down-frame → onLoginRestart, which
    // is registered unconditionally above). The dashboard card shows a Start
    // button while login_state is still null.
    log(
      'login relay ready (SPELLGUARD_LOGIN_RELAY=wait) — not auto-started; waiting for the operator to start login',
    );
  } else if (loginRelayEnabled) {
    // Relay enabled + auto-start mode (=1) but the box is already authorized
    // (token in env or the ~/.claude-oauth-token marker), so the gate suppressed
    // the spawn. Log it for parity with the Codex daemon's equivalent branch.
    log(
      'login relay skipped — Claude already authorized (token in env or on disk)',
    );
  }

  // Run an immediate expiry check in case the daemon restarted near expiry.
  checkExpiryAndRefresh(client, configPath, expiryInFlight, log, shutdown);
  // The event loop stays alive while the WebSocket is open.
}

// ── Commit watcher helper (relocated from session-start.ts) ──────────────────

/**
 * Start the commit watcher for `cwd`, returning a stop function or
 * `undefined` if the watcher could not be started (not a git repo, no
 * remote.origin.url, env-var disabled, or the watcher threw at startup).
 * All failure modes are logged at `info` and treated as non-fatal — the
 * daemon must continue serving the credential socket regardless of the
 * watcher's state.
 *
 * Pre-2026-05-15 this lived in `session-start.ts`. The hook process exited
 * within seconds of returning from `runSessionStart` and the watcher's
 * `fs.watch({ persistent: true })` died with it, silently dropping every
 * commit observation. Hosting the watcher in the daemon (which already
 * runs `client.start()`'s persistent WebSocket and outlives the hook)
 * keeps the watcher alive for the full Claude Code session.
 */
async function maybeStartCommitWatcher(args: {
  cwd: string;
  agentId: string;
  agentSecret: string;
  baseUrl: string;
  log: (msg: string) => void;
}): Promise<(() => Promise<void>) | undefined> {
  if (process.env.SPELLGUARD_COMMIT_OBSERVATIONS === '0') return undefined;

  // Resolve remote.origin.url. Non-git cwd (or no remote) → silently skip.
  let remoteUrl: string;
  try {
    remoteUrl = execSync('git config --get remote.origin.url', {
      cwd: args.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!remoteUrl) return undefined;
  } catch {
    return undefined;
  }

  // Resolve the git toplevel and use it as the canonical key root
  // (same rationale as the PostToolUse hook — the edit-store keys are
  // `relative(workingDir, file)` and must align with `git show <sha>`
  // output, which emits paths relative to the repo root).
  const gitRoot = resolveGitRoot(args.cwd);

  // Warn when `core.logAllRefUpdates` is explicitly false. The
  // watcher tails `.git/logs/HEAD`, which only exists when this config
  // is true (the default). Non-fatal — surface a one-line notice so the
  // operator can choose to re-enable.
  const probe = checkLogAllRefUpdates(args.cwd);
  if (probe.shouldWarn) {
    args.log(
      'commit watcher depends on `core.logAllRefUpdates=true` ' +
        '(currently disabled in this repo). Commit observations may be ' +
        'lost until the config is restored: ' +
        '`git config core.logAllRefUpdates true`.',
    );
  }

  // Per-process session_id (best-effort attribution grouping). The server
  // doesn't require it to be globally unique.
  const sessionId = randomUUID();

  try {
    const stop = await startCommitWatcher({
      workingDir: gitRoot,
      onCommit: async (event) => {
        const store = openEditStore({
          rootDir: join(homedir(), '.spellguard'),
        });
        try {
          await emitCommitObservation({
            store,
            diffProvider: async (sha: string) => {
              // Delegate to captureGitShowDiff which sets an
              // explicit 64 MB maxBuffer and emits a structured operator
              // warning on ENOBUFS / any failure. On failure it returns
              // null; we normalise that to {} (empty diff) so the emitter
              // still records the commit metadata without file attribution.
              return (
                captureGitShowDiff({ sha, gitRoot, logFn: args.log }) ?? {}
              );
            },
            fetch,
            apiBase: args.baseUrl,
            agentId: args.agentId,
            agentSecret: args.agentSecret,
            workingDir: gitRoot,
            remoteUrl,
            commitEvent: event,
            sessionContext: { sessionId, agentId: args.agentId },
          });
        } finally {
          store.close();
        }
      },
    });
    return stop;
  } catch (err) {
    args.log(
      `commit watcher not started (${(err as Error)?.message ?? 'unknown'}).`,
    );
    return undefined;
  }
}

// Only run main() when this file is the process entry point, not when imported
// as a module (e.g. by unit tests that only import the exported path helpers).
// ESM equivalent of the CJS `require.main === module` guard.
import { fileURLToPath } from 'node:url';

const _thisFile = fileURLToPath(import.meta.url);
// process.argv[1] is the entry-point path Node was given; normalize both sides.
const _entryPoint = process.argv[1] ?? '';
const _isEntryPoint =
  _entryPoint !== '' &&
  (_thisFile === _entryPoint ||
    _thisFile.endsWith(_entryPoint.replace(/\\/g, '/')));

if (_isEntryPoint) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `spellguard-credential-daemon: unhandled error: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
