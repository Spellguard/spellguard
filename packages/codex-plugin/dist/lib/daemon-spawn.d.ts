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
 * can start the daemon too — previously the session-start hook was the ONLY
 * spawner, which left a freshly-bootstrapped install with no credential
 * consumer until the next session boundary.
 *
 * Unlike the Claude Code variant, the Codex daemon needs no env-file path —
 * its credential handler updates `git config` directly — and no `--cwd`.
 */
export interface EnsureDaemonArgs {
    config: SpellguardConfig;
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
