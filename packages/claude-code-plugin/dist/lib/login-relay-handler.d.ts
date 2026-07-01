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
export declare function makeNodePtySpawner(): Promise<(cmd: string, args: string[]) => PtyHandle>;
/**
 * The daemon's "login done" sentinel path. `claude auth login` writes the REAL
 * credential to its own store (the `.credentials.json` it manages) itself; this marker file is purely
 * Spellguard's bookkeeping — the daemon keys `computeNeedsLoginRelay` and the
 * `onConnect` 'authorized' re-assert off this file's EXISTENCE (not content), so
 * it MUST keep being written when login completes.
 */
export declare const LOGIN_MARKER_PATH: string;
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
export declare function defaultMarkAuthenticated(markerPath?: string, configPath?: string): void;
/** Path to the `claude` CLI's global config (onboarding / theme / trust state). */
export declare const CLAUDE_CONFIG_PATH: string;
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
export declare function seedClaudeOnboarding(configPath?: string, projectDir?: string): void;
/**
 * Resolve whether `claude` is authenticated, via `claude auth status --json`
 * (`{ "loggedIn": true, ... }`). Returns `false` on any error (binary missing,
 * non-zero exit, unparseable output, not logged in). Used by the relay to
 * detect that `claude auth login` has completed.
 *
 * Exported so the daemon can pass it to `runLoginRelay`.
 */
export declare function defaultIsLoggedIn(): Promise<boolean>;
/**
 * Run the in-box login relay flow end-to-end.
 *
 * @returns `{ ok: true }` when `claude auth status` confirmed login;
 *          `{ ok: false }` on any failure (bad exit, timeout, never logged in).
 */
export declare function runLoginRelay(deps: LoginRelayDeps): Promise<{
    ok: boolean;
}>;
