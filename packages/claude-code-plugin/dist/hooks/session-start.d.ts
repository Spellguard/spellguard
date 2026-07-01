import type { SpawnOptions } from 'node:child_process';
import { type GithubCredentialDescriptor } from '@spellguard/agent-control';
import { type ReadConfigResult, type SpellguardConfig } from '../lib/config-store';
import { type DaemonResult } from '../lib/daemon-spawn';
import { type GitVersion } from '../lib/git-version-check';
import { type PlatformInfo } from '../lib/platform-check';
import { type SshDetectionResult } from '../lib/ssh-remote-detect';
export type StatusResponse = Omit<GithubCredentialDescriptor, 'status'> & {
    status: GithubCredentialDescriptor['status'] | 'superseded';
};
export type { DaemonResult } from '../lib/daemon-spawn';
export interface SessionStartDeps {
    platformInfo?: PlatformInfo;
    gitVersion?: GitVersion | null;
    cwd?: string;
    sshDetect?: (cwd: string) => SshDetectionResult;
    /**
     * Backstop probe: re-detect SSH remotes with the session-scoped SSH->HTTPS
     * `insteadOf` rewrite applied. Override for tests; defaults to
     * `detectSshRemoteAfterRewrite`.
     */
    sshDetectAfterRewrite?: (cwd: string) => SshDetectionResult;
    readConfigImpl?: () => ReadConfigResult;
    markConfigRevokedImpl?: () => void;
    writeEnvFileImpl?: (helperPath?: string) => void;
    claudeEnvFile?: string;
    fetchImpl?: typeof fetch;
    /**
     * Credential daemon spawn: override for tests — inject a mock spawn function.
     * The production path (no override) calls `child_process.spawn` with
     * `detached: true, stdio: 'ignore'` and immediately `.unref()`s the child
     * so the hook process can exit cleanly.
     *
     * Test callers supply a `vi.fn()` here; assertions check the argv and
     * config-dir args rather than the in-process client construction.
     */
    spawnDaemon?: (execPath: string, args: string[], opts: SpawnOptions) => void;
    /**
     * Override the config directory used for PID file resolution. Defaults to
     * `defaultConfigDir()`. Tests pass an isolated temp dir.
     */
    configDir?: string;
    /**
     * Poll the local config file until it shows an `expiresAt` value newer than
     * `initialExpiresAt`, or until `timeoutMs` elapses.
     *
     * Returns the fresh `SpellguardConfig` if one appears, or `null` on timeout.
     *
     * Injected via deps so tests can stub it without real filesystem/timer
     * dependencies. The production default polls every 500 ms.
     */
    pollForFreshCredential?: (initialExpiresAt: string, timeoutMs: number) => Promise<SpellguardConfig | null>;
}
export interface SessionStartResult {
    ok: boolean;
    reason?: string;
    /**
     * Result of the credential daemon spawn attempt.
     * Undefined when session-start fails before reaching the daemon step.
     * The commit watcher runs inside this daemon process, so `daemonResult`
     * is the only handle callers need — the watcher lifecycle is tied to the
     * daemon's lifecycle.
     */
    daemonResult?: DaemonResult;
}
export declare function runSessionStart(deps?: SessionStartDeps): Promise<SessionStartResult>;
