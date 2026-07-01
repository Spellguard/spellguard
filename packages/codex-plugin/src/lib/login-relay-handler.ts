// SPDX-License-Identifier: Apache-2.0

/**
 * REQ-C03 — In-box Codex login relay driver (DEVICE-AUTH variant).
 *
 * Drives the REAL Codex subscription login headlessly on the managed box so the
 * device-code flow can be brokered through the Spellguard dashboard, and so an
 * INTERACTIVE `codex` (a human SSHing into the box over Tailscale) is genuinely
 * authenticated afterwards.
 *
 * Codex's flow is DEVICE-AUTH — fundamentally different from Claude's
 * localhost-callback OAuth (which relays a code DOWN). Here the box drives
 * `codex login --device-auth`, which prints a STATIC URL
 * (`https://auth.openai.com/codex/device`) + a SEPARATE one-time code; the box
 * then POLLS OpenAI ITSELF until the operator approves, and Codex writes its
 * OWN credential to `~/.codex/auth.json`. NOTHING comes back DOWN the channel
 * (no `login_code` frame is consumed — that is Claude-only):
 *
 *   1. Spawn `codex login --device-auth` in a pty.
 *   2. Strip ANSI, parse:
 *        - device URL  = the indented line AFTER `Open this link in your browser`
 *        - one-time code = the indented line AFTER `Enter this one-time code`
 *   3. sendUpdate({ state:'url_ready', login_url:<URL>, message:<CODE> })
 *      then    ({ state:'awaiting_code' }).
 *   4. Wait for the codex PROCESS to exit. On exit 0, confirm with the injected
 *      `isLoggedIn` (`codex login status` → logged-in). On success
 *      `markAuthenticated()` (write the daemon's login-done sentinel) +
 *      sendUpdate({ state:'authorized' }) → return { ok: true }.
 *   5. On non-zero exit / parse-failure / timeout →
 *      sendUpdate({ state:'failed', message:<generic reason> }) → { ok: false }.
 *   6. Restart: the injected AbortSignal cancels the in-flight relay (the daemon
 *      kills this pty and respawns a fresh `codex login --device-auth` for a new
 *      device code — the 15-min code can expire, so the operator can re-request).
 *
 * NEG-C01: the inference credential is minted by OpenAI DIRECTLY onto the box
 * and never enters Spellguard code/storage. This relay sends UP the channel
 * ONLY: the device URL (non-secret, static), the one-time device code
 * (non-secret, single-use, expires in 15 min), and state. NEVER a token. The
 * relay never even passes a token THROUGH our code — Codex writes its own
 * `auth.json` and success is detected via `codex login status` (a boolean).
 *
 * ── Pty approach ────────────────────────────────────────────────────────────
 * The real spawn (used on the managed EC2 box) uses the `node-pty` package
 * (`IPty.write(str)` to feed stdin, `IPty.onData(cb)` to read output). The unit
 * tests inject a fake pty via the `spawnPty` dependency and a fake `isLoggedIn`
 * — no native build and no real CLI required in the test env.
 */

import { execFile } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
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
 * Update shape passed to `sendUpdate`. NEG-C01: no token, no secret.
 * On `url_ready` the device URL travels in `login_url` and the one-time device
 * code travels in `message` (reusing the existing frame fields — no protocol
 * bump). The device code is non-secret, single-use, and expires in 15 minutes.
 */
export interface LoginRelayUpdate {
  state: 'url_ready' | 'awaiting_code' | 'authorized' | 'failed';
  /** Device URL — present on `url_ready` (static codex/device URL). */
  login_url?: string;
  /**
   * On `url_ready`: the one-time device code (non-secret, single-use, expiring).
   * On `failed`: a human-readable, generic failure reason.
   */
  message?: string;
}

/**
 * Injectable dependencies for `runLoginRelay`. All side-effectful operations
 * are injected so unit tests can use fakes without spawning real processes.
 *
 * NOTE (vs Claude): there is deliberately NO `waitForCode` / `submitEnterDelayMs`
 * dep — the Codex device-auth flow consumes NOTHING from the dashboard. The box
 * polls OpenAI itself; the relay just waits for the codex process to exit.
 */
export interface LoginRelayDeps {
  /**
   * Spawn `codex login --device-auth` (or any command) in a pty.
   * @param cmd  The command (e.g. 'codex').
   * @param args The arguments (e.g. ['login', '--device-auth']).
   */
  spawnPty(cmd: string, args: string[]): PtyHandle;

  /**
   * Send a login-relay state update up the control channel.
   * NEG-C01: must NEVER include a token — only state/url/device-code/message.
   */
  sendUpdate(update: LoginRelayUpdate): void;

  /**
   * Mark the box as authenticated AFTER `codex login status` confirms login.
   * `codex login --device-auth` writes its OWN credential
   * (`~/.codex/auth.json`), so the relay never sees or persists a token. This
   * only writes the daemon's "login done" SENTINEL marker
   * (`~/.codex-login-done`) — the daemon gates the relay AND re-asserts the
   * terminal `authorized` state off that file's EXISTENCE (not its content).
   */
  markAuthenticated(): void;

  /**
   * Resolves `true` when `codex login --device-auth` has completed — i.e. when
   * `codex login status` reports logged-in. The relay polls this AFTER the codex
   * process exits 0 (instead of scraping a token from the pty), because the
   * credential is written by Codex itself and never printed. Injected so unit
   * tests drive success without a real CLI.
   */
  isLoggedIn(): Promise<boolean>;

  /**
   * Optional timeout in milliseconds for the whole relay. Defaults to 15 minutes
   * (env override: SPELLGUARD_LOGIN_RELAY_TIMEOUT_MS) — long enough for a human
   * to open the URL, sign in to ChatGPT, and enter the device code (the code
   * itself expires in 15 min). Exposed for tests to shorten.
   */
  timeoutMs?: number;

  /**
   * Optional AbortSignal. When aborted, the relay exits immediately (kills the
   * pty, resolves `{ ok: false }`, sends NO failed update). The daemon uses this
   * to kill the in-flight relay before respawning a fresh one on `login_restart`.
   */
  signal?: AbortSignal;

  /**
   * Milliseconds between `codex login status` polls after the codex process
   * exits 0. Default 1500 ms. Exposed so unit tests can drive the
   * success-detection loop quickly.
   */
  pollIntervalMs?: number;
}

// ── Regex patterns ────────────────────────────────────────────────────────────

/**
 * ANSI/VT escape sequences. The device CODE line is grey-coloured
 * (`\x1b[90m…`) and the rest of the codex output is colourised, so these must
 * be stripped before the anchor-based line parse runs — otherwise an embedded
 * colour code sits inside the captured URL/code and corrupts the value.
 * Matches `ESC [ <params> <final-letter>`.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC (\x1b) control char is the whole point — codex's CLI emits it around/inside the device URL + code.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Strip ANSI/VT escape sequences so a colourised URL/code is captured intact. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

/**
 * Anchor lines emitted by `codex login --device-auth` (ANSI-stripped). The
 * VALUE we want is the next NON-BLANK indented line AFTER each anchor:
 *
 *   1. Open this link in your browser and sign in to your account
 *      https://auth.openai.com/codex/device       ← device URL
 *   2. Enter this one-time code (expires in 15 minutes)
 *      ABCD-1234                                   ← one-time code
 *
 * We match on the stable anchor PHRASE (not the leading "1."/"2." numbering, in
 * case codex reformats the list) and then capture the next indented value line.
 */
const URL_ANCHOR = 'Open this link in your browser';
const CODE_ANCHOR = 'Enter this one-time code';

/**
 * Match the device URL value. Static per the spike
 * (`https://auth.openai.com/codex/device`), but we match any https URL so a
 * future path change is still captured rather than hard-coded.
 */
const URL_VALUE_PATTERN = /https:\/\/[^\s'"]+/i;

/**
 * Match the one-time device code value. Codex prints a short uppercase code
 * like `ABCD-1234` (letters/digits in dash-separated groups). We accept any
 * such grouped alphanumeric token so a format tweak (e.g. group length) still
 * parses.
 */
const CODE_VALUE_PATTERN = /^[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+$/;

/**
 * Parse the device URL + one-time code from accumulated (ANSI-stripped) pty
 * output. Returns both only when BOTH have been found — the relay must surface
 * the URL and the code together (a URL without the code is useless to the
 * operator). Returns `null` until both anchors + values are present.
 *
 * Exported for unit testing of the parse in isolation.
 */
export function parseDeviceAuth(
  buffer: string,
): { url: string; code: string } | null {
  const stripped = stripAnsi(buffer);
  const lines = stripped.split(/\r?\n/);

  let url: string | undefined;
  let code: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (url === undefined && line.includes(URL_ANCHOR)) {
      // The URL is on the next non-blank line after the anchor.
      const value = nextValueLine(lines, i, URL_VALUE_PATTERN);
      if (value) url = value;
    }
    if (code === undefined && line.includes(CODE_ANCHOR)) {
      const value = nextValueLine(lines, i, CODE_VALUE_PATTERN);
      if (value) code = value;
    }
  }

  if (url && code) return { url, code };
  return null;
}

/**
 * Scan forward from `anchorIdx` for the next non-blank line whose TRIMMED
 * content matches `pattern`, returning the trimmed match (the indented value).
 * Bounded to a few lines so a stray later match never gets mis-attributed to
 * the wrong anchor.
 */
function nextValueLine(
  lines: string[],
  anchorIdx: number,
  pattern: RegExp,
): string | undefined {
  const SCAN_AHEAD = 4;
  for (
    let j = anchorIdx + 1;
    j < lines.length && j <= anchorIdx + SCAN_AHEAD;
    j++
  ) {
    const trimmed = lines[j].trim();
    if (trimmed === '') continue;
    // For the URL pattern, extract the URL substring; for the code pattern the
    // whole trimmed line must match (it is the standalone code).
    if (pattern === URL_VALUE_PATTERN) {
      const m = pattern.exec(trimmed);
      if (m) return m[0];
      // First non-blank line after the URL anchor isn't a URL → stop (we don't
      // want to skip ahead into unrelated text).
      return undefined;
    }
    if (pattern.test(trimmed)) return trimmed;
    return undefined;
  }
  return undefined;
}

// ── Real pty spawner (node-pty, dynamic import) ──────────────────────────────

/**
 * Create a `spawnPty` factory that uses the `node-pty` package.
 *
 * This function uses a dynamic `import()` so that the bundler (esbuild) does
 * not try to statically resolve `node-pty` at bundle time. `node-pty` is a
 * native module that is required at RUNTIME (not bundled into the daemon
 * binary). It ships WITH the plugin — declared in `package.json` `dependencies`
 * (so an `npm install -g @spellguard/codex-plugin` on the managed box pulls it
 * into the npm-global node_modules the daemon resolves from) AND vendored into
 * the plugin's local node_modules (scripts/vendor-externals.mjs) for the
 * out-of-workspace case — the exact same pattern as better-sqlite3.
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
  // package.json `dependencies` (so `npm install -g @spellguard/codex-plugin`
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
        'node-pty could not be loaded. It ships with @spellguard/codex-plugin ' +
          '(dependencies + vendored node_modules); a load failure usually means the ' +
          'native addon failed to build for this Node/arch. Reinstall the plugin or ' +
          'rebuild node-pty for this platform.',
      );
    },
  );
  return (cmd: string, args: string[]): PtyHandle => {
    const pty = nodePty.spawn(cmd, args, {
      name: 'xterm-color',
      // Wide terminal so the device URL is printed on ONE line and is NEVER
      // wrapped across rows (an 80-col wrap inserts a newline mid-URL, which the
      // URL parse treats as the end of the URL → truncation).
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
 * The daemon's "login done" sentinel path. `codex login --device-auth` writes
 * the REAL credential to its own store (`~/.codex/auth.json`); this marker file
 * is purely Spellguard's bookkeeping — the daemon keys `computeNeedsLoginRelay`
 * and the `onConnect` 'authorized' re-assert off this file's EXISTENCE (not
 * content), so it MUST keep being written when login completes.
 */
export const LOGIN_MARKER_PATH = join(homedir(), '.codex-login-done');

/**
 * Non-token sentinel written into the marker file. The daemon checks EXISTENCE
 * only; nothing consumes the content as a credential (the real credential lives
 * in Codex's own `~/.codex/auth.json`). Deliberately NOT a token so a stray
 * `cat` can't mistake it for one.
 */
const LOGIN_MARKER_SENTINEL =
  'spellguard:authenticated-via-codex-device-auth\n';

/**
 * Write the daemon's login-done sentinel marker (0600). Called ONLY after
 * `codex login status` confirms login. Does NOT write any credential (Codex
 * owns `~/.codex/auth.json`).
 *
 * @param markerPath Optional override (tests point at a temp path).
 *
 * Exported so the daemon can import and use it directly.
 */
export function defaultMarkAuthenticated(
  markerPath: string = LOGIN_MARKER_PATH,
): void {
  const dir = homedir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath, LOGIN_MARKER_SENTINEL, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  chmodSync(markerPath, 0o600);
}

/**
 * Resolve whether `codex` is authenticated, via `codex login status`. Codex
 * prints `Not logged in` before login and a logged-in line after (the spike
 * captured `Not logged in` on a fresh CODEX_HOME). Returns `false` on any error
 * (binary missing, non-zero exit, "Not logged in") and `true` only when the
 * output clearly indicates a logged-in state. Used by the relay to detect that
 * `codex login --device-auth` has completed.
 *
 * Exported so the daemon can pass it to `runLoginRelay`.
 */
export function defaultIsLoggedIn(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'codex',
      ['login', 'status'],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // `codex login status` exits non-zero when NOT logged in, so a non-zero
        // exit is a clean "not logged in" signal — not an error to swallow
        // blindly, but it resolves false either way.
        const out = stripAnsi(`${String(stdout)}\n${String(stderr)}`);
        if (/not logged in/i.test(out)) {
          resolve(false);
          return;
        }
        if (err) {
          resolve(false);
          return;
        }
        // Logged-in output mentions the account / "Logged in". Treat any
        // non-error, non-"Not logged in" output as logged-in.
        resolve(/logged in|authenticated|chatgpt|account/i.test(out));
      },
    );
  });
}

// ── Main driver ───────────────────────────────────────────────────────────────

/** Maximum number of characters retained in the pty output accumulation buffer. */
const PTY_BUFFER_MAX = 64 * 1024; // 64 KB

/** Default gap between `codex login status` polls after the codex process exits. */
const AUTH_POLL_INTERVAL_MS = 1500;

/**
 * Bounded window for the post-exit `codex login status` confirmation loop. Once
 * the codex process exits 0, login is already done server-side; a couple of
 * polls confirm Codex finished writing `auth.json`. Capped so a never-confirming
 * status (e.g. an exit-0 without a real login) fails closed instead of hanging.
 */
const STATUS_CONFIRM_WINDOW_MS = 60 * 1000; // 1 minute

interface RelayState {
  urlFound: boolean;
  done: boolean;
  /** Guard so the authorized transition fires exactly once. */
  authResolved: boolean;
  /**
   * Accumulated pty output buffer. The device-auth parse runs against this
   * instead of individual chunks so a URL/code spanning chunk boundaries is
   * caught. Capped at PTY_BUFFER_MAX to avoid unbounded growth.
   */
  ptyBuffer: string;
  /** Guard so the URL/code transition fires exactly ONCE even as onData keeps firing. */
  urlTransitionFired: boolean;
  /** Whether the codex process has exited (and with what code). */
  exited: boolean;
  /** Timer for the next `codex login status` poll (cleared on finish). */
  authPollTimer: ReturnType<typeof setTimeout> | null;
  /** Deadline timer bounding the post-exit status-confirm loop. */
  confirmWindowTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Append `codex login --device-auth` output to the env-gated relay debug log.
 * The device URL + code are non-secret (single-use, expiring) so we keep them
 * legible for diagnosis; we still redact any token-shaped string as
 * defence-in-depth in case a future codex version prints one. Best-effort: a
 * write failure must never disturb the relay.
 */
function debugCaptureRelayOutput(data: string): void {
  try {
    const redacted = data.replace(
      /sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{16,}/g,
      (m) => `${m.slice(0, 8)}<redacted:${m.length}>`,
    );
    const debugPath = join(homedir(), '.spellguard-relay-debug.log');
    // 0600 on creation (mirrors the daemon log discipline); best-effort chmod in
    // case a prior run created it with looser perms. The file only ever holds
    // the non-secret URL/code (+ redacted token shapes), but keep it owner-only.
    appendFileSync(debugPath, redacted, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(debugPath, 0o600);
  } catch {
    // never let debug logging affect the relay
  }
}

/**
 * Run the in-box Codex device-auth login relay flow end-to-end.
 *
 * @returns `{ ok: true }` when `codex login status` confirmed login after the
 *          process exited 0; `{ ok: false }` on any failure (bad exit, parse
 *          failure, timeout, never logged in) or abort.
 */
export async function runLoginRelay(
  deps: LoginRelayDeps,
): Promise<{ ok: boolean }> {
  // Default 15 min: covers a HUMAN opening the URL, signing in to ChatGPT, and
  // entering the device code (the code itself expires in 15 min). Tunable via
  // SPELLGUARD_LOGIN_RELAY_TIMEOUT_MS for ops/tests; tests inject `timeoutMs`.
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
    // Drive the REAL Codex device-auth subscription login so Codex writes its
    // own credential that the interactive TUI accepts.
    const pty = deps.spawnPty('codex', ['login', '--device-auth']);

    const st: RelayState = {
      urlFound: false,
      done: false,
      authResolved: false,
      ptyBuffer: '',
      urlTransitionFired: false,
      exited: false,
      authPollTimer: null,
      confirmWindowTimer: null,
    };
    let masterTimeout: ReturnType<typeof setTimeout> | null = null;

    function clearTimers(): void {
      if (masterTimeout) clearTimeout(masterTimeout);
      if (st.authPollTimer) clearTimeout(st.authPollTimer);
      if (st.confirmWindowTimer) clearTimeout(st.confirmWindowTimer);
    }

    function finish(ok: boolean, message?: string): void {
      if (st.done) return;
      st.done = true;
      clearTimers();
      if (!ok) {
        // NEG-C01: message may describe what went wrong, but NEVER a token.
        deps.sendUpdate({ state: 'failed', message });
        pty.kill();
        resolve({ ok: false });
      } else {
        pty.kill();
        resolve({ ok: true });
      }
    }

    // Wire the optional AbortSignal so the caller can cancel the relay (e.g. on
    // login_restart, the daemon aborts the old relay before starting a new one).
    // We do NOT send a failed update on abort — the restart path owns the
    // dashboard state.
    if (deps.signal) {
      if (deps.signal.aborted) {
        pty.kill();
        resolve({ ok: false });
        return;
      }
      deps.signal.addEventListener('abort', () => {
        if (!st.done) {
          st.done = true;
          clearTimers();
          pty.kill();
          resolve({ ok: false });
        }
      });
    }

    // Master timeout — kills the whole flow while we wait for the human to open
    // the URL, sign in, and enter the device code.
    masterTimeout = setTimeout(() => {
      finish(false, 'login relay timed out');
    }, timeoutMs);

    // Poll `codex login status` until login confirms. Replaces token-scraping:
    // `codex login --device-auth` writes its OWN credential and prints no token,
    // so the authoritative success signal is `codex login status`. Bounded by
    // the post-exit confirm window.
    const pollAuthStatus = (): void => {
      if (st.done || st.authResolved) return;
      deps
        .isLoggedIn()
        .then((loggedIn) => {
          if (st.done || st.authResolved) return;
          if (loggedIn) {
            st.authResolved = true;
            // NEG-C01: only the existence sentinel is written; never a token.
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

    pty.onData((data) => {
      if (st.done) return;

      // Observability (env-gated): when SPELLGUARD_LOGIN_RELAY_DEBUG=1 append
      // the raw output to a debug file (device URL + code are non-secret) so a
      // real device-auth failure is diagnosable post-mortem. Default-off.
      if (process.env.SPELLGUARD_LOGIN_RELAY_DEBUG === '1') {
        debugCaptureRelayOutput(data);
      }

      // Accumulate into the buffer; cap to last PTY_BUFFER_MAX characters.
      st.ptyBuffer = (st.ptyBuffer + data).slice(-PTY_BUFFER_MAX);

      // Phase 1 (URL + code) only. After url_ready, success is detected by the
      // process exiting + polling `codex login status` — NOT by scanning the pty
      // output for a token (Codex polls OpenAI itself; nothing comes back down).
      if (st.urlTransitionFired) return;
      const parsed = parseDeviceAuth(st.ptyBuffer);
      if (!parsed) return;

      st.urlTransitionFired = true;
      st.urlFound = true;
      // NEG-C01: only the (non-secret) device URL + (non-secret, single-use,
      // expiring) one-time code leave the box — never a token.
      deps.sendUpdate({
        state: 'url_ready',
        login_url: parsed.url,
        message: parsed.code,
      });
      // Codex needs NOTHING back down (no login_code frame); awaiting_code just
      // tells the dashboard the box is waiting for the operator to approve. The
      // box itself polls OpenAI.
      deps.sendUpdate({ state: 'awaiting_code' });
    });

    pty.onExit((exitCode) => {
      if (st.done || st.authResolved) return;
      st.exited = true;
      if (exitCode !== 0) {
        finish(false, `codex login exited with code ${exitCode}`);
        return;
      }
      // Exit 0 but the URL/code were never parsed → the flow never reached the
      // operator; treat as a failure rather than a silent success.
      if (!st.urlFound) {
        finish(false, 'codex login exited before a device code was presented');
        return;
      }
      // Exit 0 AFTER the device code was presented: `codex login --device-auth`
      // writes its credential and exits on success, so confirm via
      // `codex login status`. Arm a bounded confirm window so an exit-0 that
      // never confirms fails closed instead of hanging.
      st.confirmWindowTimer = setTimeout(
        () => {
          finish(
            false,
            'timed out confirming codex login status after device-auth exit',
          );
        },
        Math.min(STATUS_CONFIRM_WINDOW_MS, timeoutMs),
      );
      pollAuthStatus();
    });
  });
}
