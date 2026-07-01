// SPDX-License-Identifier: Apache-2.0

/**
 * REQ-003 — In-box login relay driver.
 *
 * Drives the REAL interactive Claude subscription login headlessly on the
 * managed box so the OAuth flow can be brokered through the Spellguard
 * dashboard, and so an INTERACTIVE `claude` (a human SSHing into the box over
 * Tailscale) is genuinely authenticated afterwards:
 *
 *   1. Spawn `claude auth login --claudeai` in a pty (URL is printed to stdout).
 *   2. Parse the OAuth URL → `sendUpdate({ state:'url_ready', login_url })`.
 *   3. Await the user code arriving via the control channel (`waitForCode`).
 *   4. Send `state:'awaiting_code'` so the dashboard knows it is waiting.
 *   5. Write the code to the pty's stdin (code, then a SEPARATE `\r` — DA25).
 *   6. Poll `claude auth status` until `loggedIn:true` (claude writes its OWN
 *      credential — we never see or persist a token).
 *   7. `markAuthenticated()` (write the daemon's login-done sentinel) +
 *      `sendUpdate({ state:'authorized' })` → return `{ ok: true }`.
 *
 * Why `claude auth login` and NOT `claude setup-token`: `setup-token` mints a
 * HEADLESS token (scopes `user:inference`+`user:profile` only) meant for
 * `CLAUDE_CODE_OAUTH_TOKEN` / `claude -p`. The INTERACTIVE `claude` TUI REJECTS
 * that credential — a dev who SSHes in still gets `/login`. `claude auth login
 * --claudeai` runs the full subscription OAuth (scopes incl.
 * `user:sessions:claude_code`) and lets claude write its OWN
 * credential store (the `.credentials.json` it manages), which the interactive TUI accepts. Proven on a
 * real EC2 box (claude 2.1.186): the headless token authenticated `claude -p`
 * but never the interactive TUI; the `auth login` credential authenticates both.
 *
 * NEG-001: The token NEVER leaves the box — and with this driver it never even
 * passes THROUGH our code: claude writes its own credential store, and the relay
 * detects success via `claude auth status` (a boolean), not by scraping a token.
 * `sendUpdate` payloads carry only state/url/message.
 *
 * ── Pty approach ────────────────────────────────────────────────────────────
 * The real spawn (used on the managed EC2 box) uses the `node-pty` package
 * (`IPty.write(str)` to feed stdin, `IPty.onData(cb)` to read output).
 * The unit tests inject a fake pty via the `spawnPty` dependency and a fake
 * `isLoggedIn` — no native build and no real CLI required in the test env.
 */

import { execFile } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal pty-like interface. On a real box this wraps `node-pty`'s `IPty`.
 * In unit tests a fake is injected.
 */
export interface PtyHandle {
  /** Register a callback for data (stdout/stderr) from the process. */
  onData(cb: (data: string) => void): void;
  /** Write a string to the process's stdin. */
  write(data: string): void;
  /** Register a callback for process exit. */
  onExit(cb: (exitCode: number) => void): void;
  /** Kill the pty process. */
  kill(): void;
}

/**
 * Update shape passed to `sendUpdate`. NEG-001: no token, no code, no secret.
 */
export interface LoginRelayUpdate {
  state: 'url_ready' | 'awaiting_code' | 'authorized' | 'failed';
  /** OAuth URL — present on `url_ready`. */
  login_url?: string;
  /** Human-readable failure reason — present on `failed`. */
  message?: string;
}

/**
 * Injectable dependencies for `runLoginRelay`. All side-effectful operations
 * are injected so unit tests can use fakes without spawning real processes.
 */
export interface LoginRelayDeps {
  /**
   * Spawn `claude auth login --claudeai` (or any command) in a pty.
   * @param cmd  The command (e.g. 'claude').
   * @param args The arguments (e.g. ['auth', 'login', '--claudeai']).
   */
  spawnPty(cmd: string, args: string[]): PtyHandle;

  /**
   * Send a login-relay state update up the control channel.
   * NEG-001: must NEVER include the token — only state/url/message.
   */
  sendUpdate(update: LoginRelayUpdate): void;

  /**
   * Mark the box as authenticated AFTER `claude auth status` confirms login.
   * `claude auth login` writes its OWN credential store
   * (the `.credentials.json` it manages), so the relay never sees or persists a
   * token. This only writes the daemon's "login done" SENTINEL marker
   * (`~/.claude-oauth-token`) — the daemon gates the relay AND re-asserts the
   * terminal `authorized` state off that file's EXISTENCE (not its content).
   */
  markAuthenticated(): void;

  /**
   * Resolves `true` when `claude auth login` has completed — i.e. when
   * `claude auth status` reports `loggedIn: true`. The relay polls this after
   * the code is submitted (instead of scraping a token from the pty), because
   * the interactive-login credential is written by claude itself and never
   * printed. Injected so unit tests drive success without a real CLI.
   */
  isLoggedIn(): Promise<boolean>;

  /**
   * Returns a promise that resolves with the auth code when the control
   * channel delivers a `login_code` frame. The daemon wires this to the
   * `onLoginCode` handler.
   */
  waitForCode(): Promise<string>;

  /**
   * Optional timeout in milliseconds for each phase. Defaults to 15 minutes
   * (env override: SPELLGUARD_LOGIN_RELAY_TIMEOUT_MS) — long enough for a human
   * to complete the OAuth from the dashboard. Exposed for tests to shorten.
   */
  timeoutMs?: number;

  /**
   * Optional AbortSignal. When aborted, the relay exits immediately (as if
   * `finish(false, 'aborted')` were called). The daemon uses this to kill the
   * in-flight relay before starting a new one on `login_restart`.
   */
  signal?: AbortSignal;

  /**
   * FIND-DA25: milliseconds to wait between writing the pasted code and writing
   * the Enter (`\r`) that submits it. The two MUST be separate writes (see the
   * submit site) — claude's paste-detecting input field swallows a `\r` that
   * arrives in the same burst as the code. Default 300 ms. Exposed so unit tests
   * can set it to 0 and drive the submit synchronously.
   */
  submitEnterDelayMs?: number;

  /**
   * Milliseconds between `claude auth status` polls after the code is
   * submitted. Default 1500 ms. Exposed so unit tests can drive the
   * success-detection loop quickly.
   */
  pollIntervalMs?: number;
}

// ── Regex patterns ────────────────────────────────────────────────────────────

/**
 * Match the OAuth URL emitted by `claude auth login`. The login subcommand
 * prints, e.g.:
 *   "Opening browser to sign in…
 *    If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…"
 * We match any https:// URL that looks like an auth URL on the same line.
 */
const URL_PATTERN = /https:\/\/[^\s'"]+(?:oauth|authorize|login)[^\s'"]*/i;

/**
 * ANSI/VT escape sequences (SGR colour codes + CSI cursor codes) that
 * `claude`'s TUI emits AROUND and INSIDE the OAuth URL. They must be stripped
 * before the URL regex runs — otherwise an embedded colour reset (`\x1b[39m`)
 * sits inside the URL (it's not whitespace), and the captured `login_url` is
 * truncated at that escape (observed live: an 85-char URL ending in `\x1b[39m`).
 * Matches `ESC [ <params> <final-letter>`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC (\x1b) control char is the whole point — claude's TUI emits it around/inside the URL.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Strip ANSI/VT escape sequences so a colourised OAuth URL is captured intact. */
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

// ── Real pty spawner (node-pty, dynamic import) ──────────────────────────────

/**
 * Create a `spawnPty` factory that uses the `node-pty` package.
 *
 * This function uses a dynamic `import()` so that the bundler (esbuild) does
 * not try to statically resolve `node-pty` at bundle time. `node-pty` is a
 * native module that is required at RUNTIME (not bundled into the daemon
 * binary). It ships WITH the plugin — declared in `package.json` `dependencies`
 * (so an `npm install -g @spellguard/claude-code-plugin` on the managed box
 * pulls it into the npm-global node_modules the daemon resolves from) AND
 * vendored into the plugin's local node_modules (scripts/vendor-externals.mjs)
 * for the out-of-workspace case — the exact same pattern as better-sqlite3.
 *
 * Usage in production (managed EC2 box; node-pty resolves from the plugin):
 *
 *   const spawnPty = await makeNodePtySpawner();
 *   await runLoginRelay({ spawnPty, ... });
 *
 * The unit tests inject a fake `spawnPty` directly and never call this.
 */
export async function makeNodePtySpawner(): Promise<
  (cmd: string, args: string[]) => PtyHandle
> {
  // Dynamic import — not resolved at bundle time. node-pty is a native module
  // that is NOT bundled into the daemon binary (marked --external:node-pty in
  // the build script). It is shipped WITH the plugin: declared in the plugin's
  // package.json `dependencies` (so `npm install -g @spellguard/claude-code-plugin`
  // pulls it into the npm-global node_modules where the daemon bundle resolves
  // it) AND vendored into the plugin's local node_modules by
  // scripts/vendor-externals.mjs (so the out-of-workspace / bind-mount case also
  // resolves it) — the exact same pattern as better-sqlite3. We use a variable
  // to prevent TypeScript from trying to resolve the module at compile time (it
  // is a runtime-only native dependency).
  const ptyModuleName = 'node-pty';
  // biome-ignore lint/suspicious/noExplicitAny: node-pty has no bundled types
  const nodePty: any = await import(/* @vite-ignore */ ptyModuleName).catch(
    () => {
      throw new Error(
        'node-pty could not be loaded. It ships with @spellguard/claude-code-plugin ' +
          '(dependencies + vendored node_modules); a load failure usually means the ' +
          'native addon failed to build for this Node/arch. Reinstall the plugin or ' +
          'rebuild node-pty for this platform.',
      );
    },
  );
  return (cmd: string, args: string[]): PtyHandle => {
    const pty = nodePty.spawn(cmd, args, {
      name: 'xterm-color',
      // Wide terminal so claude's long OAuth URL is printed on ONE line and is
      // NEVER wrapped across rows (an 80-col wrap inserts a newline mid-URL,
      // which the URL regex treats as the end of the URL → truncation).
      cols: 1000,
      rows: 50,
    });
    return {
      onData(cb: (data: string) => void): void {
        pty.onData(cb);
      },
      write(data: string): void {
        pty.write(data);
      },
      onExit(cb: (exitCode: number) => void): void {
        pty.onExit(({ exitCode }: { exitCode: number }) => cb(exitCode));
      },
      kill(): void {
        pty.kill();
      },
    };
  };
}

// ── Default markAuthenticated / isLoggedIn implementations ───────────────────

/**
 * The daemon's "login done" sentinel path. `claude auth login` writes the REAL
 * credential to its own store (the `.credentials.json` it manages) itself; this marker file is purely
 * Spellguard's bookkeeping — the daemon keys `computeNeedsLoginRelay` and the
 * `onConnect` 'authorized' re-assert off this file's EXISTENCE (not content), so
 * it MUST keep being written when login completes.
 */
export const LOGIN_MARKER_PATH = join(homedir(), '.claude-oauth-token');

/**
 * Non-token sentinel written into the marker file. The daemon checks EXISTENCE
 * only; nothing consumes the content as a credential (the boot script no longer
 * exports it as CLAUDE_CODE_OAUTH_TOKEN, and the real credential lives in
 * claude's own store). Deliberately NOT a token so a stray `cat` can't mistake
 * it for one.
 */
const LOGIN_MARKER_SENTINEL =
  'spellguard:authenticated-via-claude-auth-login\n';

/**
 * Write the daemon's login-done sentinel marker (0600). Called ONLY after
 * `claude auth status` confirms `loggedIn:true`. Does NOT write any credential
 * (claude owns the `.credentials.json` it manages) and does NOT set
 * `CLAUDE_CODE_OAUTH_TOKEN` (the interactive TUI ignores it and the daemon does
 * not spawn claude).
 *
 * @param markerPath Optional override (tests point at a temp path).
 *
 * Exported so the daemon can import and use it directly.
 */
export function defaultMarkAuthenticated(
  markerPath: string = LOGIN_MARKER_PATH,
  configPath: string = CLAUDE_CONFIG_PATH,
): void {
  const dir = homedir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath, LOGIN_MARKER_SENTINEL, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  chmodSync(markerPath, 0o600);
  // Seed onboarding so an INTERACTIVE `claude` (a human SSHing in) lands
  // straight in an authenticated session instead of first-run onboarding.
  seedClaudeOnboarding(configPath);
}

/** Path to the `claude` CLI's global config (onboarding / theme / trust state). */
export const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json');

/**
 * Seed the `claude` CLI's onboarding state so an interactive `claude` lands
 * straight in an authenticated session.
 *
 * `claude auth login` authenticates the box (`claude auth status` → loggedIn),
 * but the interactive TUI's FIRST-RUN onboarding IGNORES that credential and
 * forces a fresh login — proven on a real EC2 box (claude 2.1.186): a fresh
 * `claude` showed theme → "Select login method" → a NEW OAuth URL, despite
 * loggedIn:true. Seeding `hasCompletedOnboarding` skips the theme + login steps
 * (claude then uses the existing credential), and pre-accepting the home-dir
 * trust dialog skips the final "trust this folder?" prompt — so the dev drops
 * straight to the prompt.
 *
 * Merge-preserving: reads any existing config (claude writes machineID/userID/
 * cached features there) and only ADDS the onboarding flags. 0600.
 *
 * @param configPath  Override for `~/.claude.json` (tests point at a temp path).
 * @param projectDir  Folder whose trust dialog to pre-accept (default: home —
 *                    where an SSH login shell starts).
 */
export function seedClaudeOnboarding(
  configPath: string = CLAUDE_CONFIG_PATH,
  projectDir: string = homedir(),
): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        cfg = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt/unreadable — start fresh rather than fail the relay.
      cfg = {};
    }
  }

  cfg.hasCompletedOnboarding = true;
  if (!cfg.theme) cfg.theme = 'dark';

  const projects: Record<string, Record<string, unknown>> = cfg.projects &&
  typeof cfg.projects === 'object'
    ? (cfg.projects as Record<string, Record<string, unknown>>)
    : {};
  projects[projectDir] = {
    ...(projects[projectDir] ?? {}),
    hasTrustDialogAccepted: true,
  };
  cfg.projects = projects;

  writeFileSync(configPath, JSON.stringify(cfg), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
}

/**
 * Resolve whether `claude` is authenticated, via `claude auth status --json`
 * (`{ "loggedIn": true, ... }`). Returns `false` on any error (binary missing,
 * non-zero exit, unparseable output, not logged in). Used by the relay to
 * detect that `claude auth login` has completed.
 *
 * Exported so the daemon can pass it to `runLoginRelay`.
 */
export function defaultIsLoggedIn(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        try {
          const parsed = JSON.parse(stripAnsi(String(stdout)));
          resolve(parsed?.loggedIn === true);
        } catch {
          resolve(false);
        }
      },
    );
  });
}

// ── Main driver ───────────────────────────────────────────────────────────────

// ── Internal relay state (captured by helpers below) ────────────────────────

/** Maximum number of characters retained in the pty output accumulation buffer. */
const PTY_BUFFER_MAX = 64 * 1024; // 64 KB

/**
 * Fresh window armed for the login completion the moment the operator's code is
 * submitted. The overall `timeoutMs` (default 15 min) bounds the HUMAN phase
 * (open URL → sign in → authorize → paste code). But the master timeout runs
 * from relay-start, so a human who takes most of that window would leave almost
 * no time for `claude auth login` to exchange the code and write the credential
 * — and the master timeout would kill the exchange mid-flight (observed live
 * 2026-06-20 with setup-token: code arrived at 14:14, relay died at exactly
 * 15:00). So when the code is submitted we RE-ARM the master timeout to this
 * dedicated, generous window — the human's pace can no longer starve the (fast)
 * code→credential exchange + login-status confirmation.
 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
// FIND-DA25: default gap between writing the pasted code and writing the Enter
// that submits it. Must be long enough that claude's paste-detection sees the
// `\r` as a distinct keystroke, not the tail of the paste burst.
const SUBMIT_ENTER_DELAY_MS = 300;
/** Default gap between `claude auth status` polls after the code is submitted. */
const AUTH_POLL_INTERVAL_MS = 1500;

interface RelayState {
  urlFound: boolean;
  codeSubmitted: boolean;
  done: boolean;
  codeWaitTimeout: ReturnType<typeof setTimeout> | null;
  /** Timer for the next `claude auth status` poll (cleared on finish). */
  authPollTimer: ReturnType<typeof setTimeout> | null;
  /** Guard so the authorized transition fires exactly once. */
  authResolved: boolean;
  /**
   * Accumulated pty output buffer. The URL regex runs against this instead of
   * individual chunks so that a URL spanning chunk boundaries is caught.
   * Capped at PTY_BUFFER_MAX to avoid unbounded growth.
   */
  ptyBuffer: string;
  /** Guard so the URL transition fires exactly ONCE even as onData keeps firing. */
  urlTransitionFired: boolean;
}

/**
 * Handle Phase 1 (URL scan) when data arrives before the URL is found.
 * Operates on the ACCUMULATED buffer so a URL split across chunk boundaries
 * is still detected. Triggers Phase 2 (waitForCode) exactly once.
 */
function handlePhase1(
  buffer: string,
  state: RelayState,
  pty: PtyHandle,
  deps: LoginRelayDeps,
  timeoutMs: number,
  finish: (ok: boolean, message?: string) => void,
  onCodeSubmitted: () => void,
): void {
  if (state.urlTransitionFired) return;
  // Strip ANSI escapes first so a colourised URL is matched + captured intact
  // (a raw `\x1b[39m` inside the URL would otherwise truncate the captured value).
  const urlMatch = URL_PATTERN.exec(stripAnsi(buffer));
  if (!urlMatch) return;

  state.urlTransitionFired = true;
  state.urlFound = true;
  const loginUrl = urlMatch[0];
  deps.sendUpdate({ state: 'url_ready', login_url: loginUrl });
  deps.sendUpdate({ state: 'awaiting_code', login_url: loginUrl });

  state.codeWaitTimeout = setTimeout(() => {
    finish(false, 'timed out waiting for login code from dashboard');
  }, timeoutMs);

  deps
    .waitForCode()
    .then((code) => {
      if (state.done) return;
      if (state.codeWaitTimeout) {
        clearTimeout(state.codeWaitTimeout);
        state.codeWaitTimeout = null;
      }
      state.codeSubmitted = true;
      // FIND-DA23 + FIND-DA25: the Enter that submits is a CARRIAGE RETURN
      // (`\r`) — the TUI's Enter; a bare `\n` never submits. CRITICAL (DA25): the
      // `\r` MUST be a SEPARATE write from the code, NOT `${code}\r` in one burst.
      // claude's "Paste code here" field is paste-detecting (it enables bracketed
      // paste): a `code\r` burst is consumed as a single paste and the trailing
      // `\r` is swallowed as literal pasted content, so the code lands in the
      // field MASKED but is never SUBMITTED. So: write the code, then send the
      // Enter as its own write after SUBMIT_ENTER_DELAY_MS.
      pty.write(code);
      const enterDelayMs = deps.submitEnterDelayMs ?? SUBMIT_ENTER_DELAY_MS;
      setTimeout(() => {
        if (state.done) return;
        pty.write('\r');
      }, enterDelayMs);
      // Re-arm the master timeout with a fresh, dedicated window for the login
      // completion so the human's pace can't starve the fast exchange, AND start
      // polling `claude auth status` to detect that claude finished writing its
      // own credential (we never scrape a token).
      onCodeSubmitted();
    })
    .catch((err: unknown) => {
      finish(
        false,
        `error waiting for code: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/**
 * Append `claude auth login` output to the env-gated relay debug log with
 * secrets redacted. Long [A-Za-z0-9_-] runs (auth codes, PKCE params) keep only
 * a 12-char prefix + a length marker, so labels, prompts, and error text remain
 * legible for diagnosis but no full secret lands on disk. Best-effort: a write
 * failure must never disturb the relay.
 */
function debugCaptureRelayOutput(data: string): void {
  try {
    // Redact any token-shaped secret that might appear (defence-in-depth — the
    // auth-login flow does not print a token, but if a future claude version did,
    // we keep only a 14-char prefix). The authorize URL's code_challenge/state
    // are PUBLIC PKCE values, and the pasted code is masked by claude's TUI, so
    // neither needs redacting — keeping the URL legible is what makes the capture
    // useful.
    const redacted = data.replace(
      /sk-ant-[A-Za-z0-9_-]{8,}/g,
      (m) => `${m.slice(0, 14)}<redacted:${m.length}>`,
    );
    appendFileSync(
      join(homedir(), '.spellguard-relay-debug.log'),
      redacted,
      'utf-8',
    );
  } catch {
    // never let debug logging affect the relay
  }
}

/**
 * Run the in-box login relay flow end-to-end.
 *
 * @returns `{ ok: true }` when `claude auth status` confirmed login;
 *          `{ ok: false }` on any failure (bad exit, timeout, never logged in).
 */
export async function runLoginRelay(
  deps: LoginRelayDeps,
): Promise<{ ok: boolean }> {
  // Default 15 min: this window must cover a HUMAN completing the OAuth from the
  // dashboard (open the URL → sign in to Claude → authorize → copy the code →
  // paste it back). 5 min proved too tight for a real operator on mobile.
  // Tunable via SPELLGUARD_LOGIN_RELAY_TIMEOUT_MS for ops/tests; tests inject
  // `timeoutMs`.
  const envTimeout = Number(process.env.SPELLGUARD_LOGIN_RELAY_TIMEOUT_MS);
  const timeoutMs =
    deps.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0
      ? envTimeout
      : 15 * 60 * 1000);
  const pollIntervalMs = deps.pollIntervalMs ?? AUTH_POLL_INTERVAL_MS;

  // If the caller already aborted before we even started, exit immediately.
  if (deps.signal?.aborted) return { ok: false };

  return new Promise<{ ok: boolean }>((resolve) => {
    // Drive the REAL interactive subscription login (NOT setup-token) so claude
    // writes its own credential store that the interactive TUI accepts.
    const pty = deps.spawnPty('claude', ['auth', 'login', '--claudeai']);

    const st: RelayState = {
      urlFound: false,
      codeSubmitted: false,
      done: false,
      codeWaitTimeout: null,
      authPollTimer: null,
      authResolved: false,
      ptyBuffer: '',
      urlTransitionFired: false,
    };
    let masterTimeout: ReturnType<typeof setTimeout> | null = null;

    function finish(ok: boolean, message?: string): void {
      if (st.done) return;
      st.done = true;
      if (masterTimeout) clearTimeout(masterTimeout);
      if (st.codeWaitTimeout) clearTimeout(st.codeWaitTimeout);
      if (st.authPollTimer) clearTimeout(st.authPollTimer);
      if (!ok) {
        // NEG-001: message may describe what went wrong, but NEVER a token
        deps.sendUpdate({ state: 'failed', message });
        pty.kill();
        resolve({ ok: false });
      } else {
        // claude `auth login` has written its own credential; kill the pty (it
        // may be parked on a "Press Enter to continue" screen) and resolve.
        pty.kill();
        resolve({ ok: true });
      }
    }

    // Wire the optional AbortSignal so the caller can cancel the relay (e.g.
    // on login_restart, the daemon aborts the old relay before starting a new
    // one). We do NOT send a failed update on abort — the restart path handles
    // signalling to the dashboard.
    if (deps.signal) {
      if (deps.signal.aborted) {
        // Aborted between the early check above and here (tiny race) — exit.
        pty.kill();
        resolve({ ok: false });
        return;
      }
      deps.signal.addEventListener('abort', () => {
        if (!st.done) {
          st.done = true;
          if (masterTimeout) clearTimeout(masterTimeout);
          if (st.codeWaitTimeout) clearTimeout(st.codeWaitTimeout);
          if (st.authPollTimer) clearTimeout(st.authPollTimer);
          pty.kill();
          resolve({ ok: false });
        }
      });
    }

    // Master timeout — kills the whole flow while we wait for the human to
    // open the URL, sign in, authorize, and paste the code.
    masterTimeout = setTimeout(() => {
      finish(false, 'login relay timed out');
    }, timeoutMs);

    // Poll `claude auth status` until login completes. Replaces token-scraping:
    // `claude auth login` writes its OWN credential and prints no token, so the
    // authoritative success signal is `loggedIn:true`. Bounded by the re-armed
    // exchange window (set in armCompletionWindow).
    const pollAuthStatus = (): void => {
      if (st.done || st.authResolved) return;
      deps
        .isLoggedIn()
        .then((loggedIn) => {
          if (st.done || st.authResolved) return;
          if (loggedIn) {
            st.authResolved = true;
            // NEG-001: only the existence sentinel is written; never a token.
            deps.markAuthenticated();
            deps.sendUpdate({ state: 'authorized' });
            finish(true);
            return;
          }
          st.authPollTimer = setTimeout(pollAuthStatus, pollIntervalMs);
        })
        .catch(() => {
          if (st.done || st.authResolved) return;
          st.authPollTimer = setTimeout(pollAuthStatus, pollIntervalMs);
        });
    };

    // Once the code is submitted the human phase is over; re-arm the master
    // timeout with a fresh, dedicated window for the (fast) exchange so a slow
    // human can't leave it with no time left (live 2026-06-20), AND begin
    // polling `claude auth status`.
    const armCompletionWindow = (): void => {
      if (st.done) return;
      if (masterTimeout) clearTimeout(masterTimeout);
      // Cap by the configured `timeoutMs` so a test that injects a tiny window
      // (to exercise the timeout path fast) isn't forced to wait the full
      // production window. In production timeoutMs is 15 min, so this is the
      // dedicated 3-min completion window.
      const completionWindow = Math.min(TOKEN_EXCHANGE_TIMEOUT_MS, timeoutMs);
      masterTimeout = setTimeout(() => {
        finish(
          false,
          `timed out waiting for claude auth login to complete (bufferLen=${st.ptyBuffer.length})`,
        );
      }, completionWindow);
      // Start polling AFTER the \r-submit delay (pollIntervalMs > submitEnterDelayMs)
      // so the code's submitting Enter (FIND-DA25, written at submitEnterDelayMs) is
      // ALWAYS sent before any poll can confirm-and-finish. Subsequent polls
      // self-schedule. (A clean `auth login` exit also kicks an immediate poll.)
      st.authPollTimer = setTimeout(pollAuthStatus, pollIntervalMs);
    };

    pty.onData((data) => {
      if (st.done) return;

      // Observability (env-gated): when SPELLGUARD_LOGIN_RELAY_DEBUG=1 append the
      // raw output to a debug file with secrets REDACTED so a real-OAuth failure
      // is diagnosable post-mortem (the pty is killed on finish). Default-off.
      if (process.env.SPELLGUARD_LOGIN_RELAY_DEBUG === '1') {
        debugCaptureRelayOutput(data);
      }

      // Accumulate into the buffer; cap to last PTY_BUFFER_MAX characters.
      st.ptyBuffer = (st.ptyBuffer + data).slice(-PTY_BUFFER_MAX);

      // Phase 1 (URL) only. After the URL, success is detected by polling
      // `claude auth status` — NOT by scanning the pty output for a token.
      if (!st.urlFound) {
        handlePhase1(
          st.ptyBuffer,
          st,
          pty,
          deps,
          timeoutMs,
          finish,
          armCompletionWindow,
        );
      }
    });

    pty.onExit((exitCode) => {
      if (st.done || st.authResolved) return;
      if (exitCode !== 0) {
        finish(false, `claude auth login exited with code ${exitCode}`);
        return;
      }
      // Exit 0. If a code was never submitted, the login could not have
      // completed (the process ended before the operator authorized).
      if (!st.codeSubmitted) {
        finish(
          false,
          'claude auth login exited before a login code was submitted',
        );
        return;
      }
      // Exit 0 AFTER the code was submitted: `claude auth login` writes its
      // credential and exits on success, so confirm via one immediate
      // auth-status poll. If it is not yet logged in, the polling loop (already
      // armed) keeps checking until the completion window elapses.
      pollAuthStatus();
    });
  });
}
