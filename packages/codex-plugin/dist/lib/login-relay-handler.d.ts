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
/** Strip ANSI/VT escape sequences so a colourised URL/code is captured intact. */
export declare function stripAnsi(s: string): string;
/**
 * Parse the device URL + one-time code from accumulated (ANSI-stripped) pty
 * output. Returns both only when BOTH have been found — the relay must surface
 * the URL and the code together (a URL without the code is useless to the
 * operator). Returns `null` until both anchors + values are present.
 *
 * Exported for unit testing of the parse in isolation.
 */
export declare function parseDeviceAuth(buffer: string): {
    url: string;
    code: string;
} | null;
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
export declare function makeNodePtySpawner(): Promise<(cmd: string, args: string[]) => PtyHandle>;
/**
 * The daemon's "login done" sentinel path. `codex login --device-auth` writes
 * the REAL credential to its own store (`~/.codex/auth.json`); this marker file
 * is purely Spellguard's bookkeeping — the daemon keys `computeNeedsLoginRelay`
 * and the `onConnect` 'authorized' re-assert off this file's EXISTENCE (not
 * content), so it MUST keep being written when login completes.
 */
export declare const LOGIN_MARKER_PATH: string;
/**
 * Write the daemon's login-done sentinel marker (0600). Called ONLY after
 * `codex login status` confirms login. Does NOT write any credential (Codex
 * owns `~/.codex/auth.json`).
 *
 * @param markerPath Optional override (tests point at a temp path).
 *
 * Exported so the daemon can import and use it directly.
 */
export declare function defaultMarkAuthenticated(markerPath?: string): void;
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
export declare function defaultIsLoggedIn(): Promise<boolean>;
/**
 * Run the in-box Codex device-auth login relay flow end-to-end.
 *
 * @returns `{ ok: true }` when `codex login status` confirmed login after the
 *          process exited 0; `{ ok: false }` on any failure (bad exit, parse
 *          failure, timeout, never logged in) or abort.
 */
export declare function runLoginRelay(deps: LoginRelayDeps): Promise<{
    ok: boolean;
}>;
