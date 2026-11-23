export type BoxSessionRegisterOutcome = 'registered' | 'no_daemon' | 'rejected' | 'skipped';
export interface BoxSessionRegistration {
    /** The framework's own resumable session reference. */
    sessionId: string;
    /** Canonical framework token (`claude_code` | `codex` | …). */
    framework: string;
    workingDirectory: string;
    /**
     * The caller's multiplexer pane/window handle from its environment. Opaque:
     * only the daemon's driver interprets it (NEG-008).
     */
    ambientLocation?: string;
    taskId?: string;
}
export interface RegisterBoxSessionOptions {
    socketPath?: string;
    timeoutMs?: number;
}
/**
 * The daemon's default socket path. Mirrors the Go `DefaultSocketPath`:
 * `<tmp>/spellguard-boxdaemon-<euid>/tasks.sock`.
 */
export declare function defaultBoxSocketPath(): string;
/**
 * Read the ambient multiplexer handle. tmux exports `$TMUX_PANE` into every
 * process it starts, so a framework session running in a pane inherits it.
 * Absent means "not in a multiplexer", which is a legitimate state.
 */
export declare function ambientMultiplexerHandle(env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Register a framework session with the box daemon. Resolves to an outcome and
 * never rejects — a hook must not fail because the daemon is absent or slow.
 */
export declare function registerBoxSession(registration: BoxSessionRegistration, options?: RegisterBoxSessionOptions): Promise<BoxSessionRegisterOutcome>;
/**
 * Parse a SessionStart-class hook payload and register the session.
 *
 * Both TS plugins call THIS function rather than re-deriving the fields, so
 * Claude Code and Codex capture identically even though their hook wrappers
 * differ in how they surface user-visible output (a sanctioned parity delta).
 *
 * Malformed or empty stdin resolves to `skipped`: a hook that cannot parse its
 * payload must still let the session start.
 */
export declare function captureSessionStart(stdin: string, framework: string, options?: RegisterBoxSessionOptions & {
    env?: NodeJS.ProcessEnv;
}): Promise<BoxSessionRegisterOutcome>;
