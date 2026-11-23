import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { type SpellguardConfig } from './config-store';
export type DaemonTransportState = 'connecting' | 'connected' | 'error';
export type DaemonCredentialState = 'missing' | 'valid' | 'near_expiry' | 'refresh_pending' | 'expired' | 'revoked';
export interface DaemonHealthRecord {
    schemaVersion: 1;
    pid: number;
    processStartToken: string;
    agentId: string;
    configDir: string;
    scriptPath: string;
    artifactId: string;
    instanceId: string;
    heartbeatAt: string;
    processState: 'starting' | 'ready';
    transportState: DaemonTransportState;
    transportError?: string;
    credentialState: DaemonCredentialState;
}
export type DaemonResult = {
    daemon: 'already-running';
    pid: number;
    state: 'ready';
    transport: DaemonTransportState;
    credentialState: DaemonCredentialState;
} | {
    daemon: 'spawned';
    pid?: number;
    state?: 'ready';
    transport?: DaemonTransportState;
    credentialState?: DaemonCredentialState;
} | {
    daemon: 'starting';
    pid: number;
    transport: DaemonTransportState;
    credentialState: DaemonCredentialState;
} | {
    daemon: 'restarted';
    pid: number;
    replacedPid: number;
    reason: 'obsolete' | 'unhealthy';
    state: 'ready';
    transport: DaemonTransportState;
    credentialState: DaemonCredentialState;
} | {
    daemon: 'skipped';
    reason: string;
} | {
    daemon: 'unavailable';
    reason: 'foreign_or_unverifiable' | 'reconcile_busy' | 'startup_failed' | 'readiness_timeout' | 'deadline_exhausted' | 'startup_cooldown' | 'stop_failed' | 'unsupported_platform' | 'unsupported_safe_replacement';
    pid?: number;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    detail?: string;
};
export interface EnsureDaemonArgs {
    config: SpellguardConfig;
    spawnDaemon?: (execPath: string, args: string[], opts: SpawnOptions) => ChildProcess | undefined;
    configDir?: string;
    cwd?: string;
    readinessTimeoutMs?: number;
    heartbeatMaxAgeMs?: number;
    stopTimeoutMs?: number;
    reconcileTimeoutMs?: number;
    deadlineAtMs?: number;
    startupCooldownMs?: number;
}
export interface ReconcilePermit {
    isHeld(): boolean;
}
export interface DaemonHealthReporter {
    markReady(): void;
    setTransport(state: DaemonTransportState, error?: string): void;
    setCredentialState(state: DaemonCredentialState): void;
    close(): void;
}
export declare function daemonPidFilePath(configDir: string, agentId: string): string;
export declare function daemonHealthFilePath(configDir: string, agentId: string): string;
/** Resolve the daemon artifact shipped beside the currently executing plugin. */
export declare function daemonScriptPath(): string;
/** Fingerprint the local installed artifact. No network version lookup occurs. */
export declare function daemonArtifactId(scriptPath?: string): string;
export declare function readDaemonHealth(configDir: string, agentId: string): DaemonHealthRecord | null;
export declare function startDaemonHealthReporter(args: {
    agentId: string;
    configDir: string;
    scriptPath: string;
    artifactId: string;
    instanceId: string;
    credentialState: DaemonCredentialState;
    heartbeatIntervalMs?: number;
}): DaemonHealthReporter;
/** Reconcile one agent's daemon with the plugin artifact installed on disk. */
export declare function ensureCredentialDaemonRunning(args: EnsureDaemonArgs): Promise<DaemonResult>;
/**
 * Reconcile one daemon while the caller holds the agent's lock permit.
 *
 * Keeping the permit explicit makes the post-spawn fencing boundary
 * deterministic to exercise: the caller must still own the permit before the
 * pending-start marker is published, and a lost permit must leave newer state
 * untouched. The production entry point supplies the kernel-backed permit.
 */
export declare function reconcileUnderLock(args: EnsureDaemonArgs & {
    configDir: string;
    deadlineAtMs: number;
}, permit: ReconcilePermit, allowSafeReplacement: boolean): Promise<DaemonResult>;
/** Signal a daemon only after two matching process-identity reads. */
export declare function signalOwnedCredentialDaemon(args: {
    pid: number;
    agentId: string;
    configDir: string;
    signal: NodeJS.Signals;
}): boolean;
