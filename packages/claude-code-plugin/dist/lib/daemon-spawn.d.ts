import { type SpawnOptions } from 'node:child_process';
import { type SpellguardConfig } from './config-store';
/**
 * Result shape for `ensureCredentialDaemonRunning`.
 */
export type DaemonResult = {
    daemon: 'already-running';
    pid: number;
} | {
    daemon: 'spawned';
} | {
    daemon: 'skipped';
    reason: string;
};
/**
 * Arguments for `ensureCredentialDaemonRunning`.
 *
 * Extracted from `src/hooks/session-start.ts` (2026-06-11) so the setup CLI
 * can start the daemon too — previously the SessionStart hook was the ONLY
 * spawner, which left a freshly-bootstrapped install with no credential
 * consumer until the next session boundary (SessionStart fires only on
 * startup / resume / clear / compact; `/reload-plugins` does not run it).
 */
export interface EnsureDaemonArgs {
    config: SpellguardConfig;
    /** Git working tree the daemon's commit watcher should host (`--cwd`). */
    cwd: string;
    /**
     * CLAUDE_ENV_FILE to forward to the daemon. Present in hook context
     * (the harness sets it); absent when invoked from the setup CLI, where the
     * daemon tolerates the gap by skipping env-file updates — the next
     * SessionStart hook performs the env-file injection for its session.
     */
    envFilePath?: string;
    /**
     * Credential daemon spawn: override for tests — inject a mock spawn
     * function. The production path (no override) calls `child_process.spawn`
     * with `detached: true, stdio: 'ignore'` and immediately `.unref()`s the
     * child so the calling process can exit cleanly.
     */
    spawnDaemon?: (execPath: string, args: string[], opts: SpawnOptions) => void;
    /**
     * Override the config directory used for PID file resolution. Defaults to
     * `defaultConfigDir()`. Tests pass an isolated temp dir.
     */
    configDir?: string;
}
/**
 * Start the persistent credential daemon for `config.agentId` unless a live
 * one is already registered in the PID file. The daemon is the sole consumer
 * of `credential_delivered` / `credential_rotated` frames — without it, a
 * pushed GitHub credential has no consumer and sits queued server-side.
 */
export declare function ensureCredentialDaemonRunning(args: EnsureDaemonArgs): DaemonResult;
