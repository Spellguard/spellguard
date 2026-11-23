/**
 * Stop every locally-running credential daemon by reading
 * `<configDir>/agents/*.pid` and SIGTERM-ing each proven owned process. A PID
 * file alone is never ownership proof. The process command, agent ID, config
 * root, and process start token must agree before production sends a signal.
 * A dead pid, a garbage pidfile, or a missing directory is silently skipped.
 * Used by /spellguard-reset and before a fresh
 * bootstrap so a stale-identity daemon can't race config writes against the
 * new identity (plan Task 2.10, 2026-06-11).
 */
export declare function stopLocalDaemons(opts?: {
    configDir?: string;
    killImpl?: (pid: number, signal: NodeJS.Signals) => boolean;
}): number[];
