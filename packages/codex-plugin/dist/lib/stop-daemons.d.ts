/**
 * Stop every locally-running credential daemon by reading
 * `<configDir>/agents/*.pid` and SIGTERM-ing each pid. Best-effort by
 * design: a dead pid (ESRCH), a garbage pidfile, or a missing directory are
 * all silently skipped. Used by /spellguard-reset and before a fresh
 * bootstrap so a stale-identity daemon can't race config writes against the
 * new identity (plan Task 2.10, 2026-06-11).
 */
export declare function stopLocalDaemons(opts?: {
    configDir?: string;
    killImpl?: (pid: number, signal: NodeJS.Signals) => boolean;
}): number[];
