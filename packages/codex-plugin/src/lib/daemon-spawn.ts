// SPDX-License-Identifier: Apache-2.0

import {
  type ChildProcess,
  type SpawnOptions,
  execFileSync,
  spawn,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SpellguardConfig, defaultConfigDir } from './config-store';

const HEALTH_SCHEMA_VERSION = 1;
const DEFAULT_HEARTBEAT_MAX_AGE_MS = 5_000;
const DEFAULT_READINESS_TIMEOUT_MS = 3_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const RECONCILE_LOCK_TIMEOUT_MS = 4_000;
const DEFAULT_STARTUP_COOLDOWN_MS = 10_000;
const FINALIZATION_RESERVE_MS = 25;
const FORCE_KILL_RESERVE_MS = 25;
const FLOCK_PATHS = ['/usr/bin/flock', '/bin/flock'] as const;
const LOCK_HOLDER_SCRIPT =
  "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0))";

export type DaemonTransportState = 'connecting' | 'connected' | 'error';
export type DaemonCredentialState =
  | 'missing'
  | 'valid'
  | 'near_expiry'
  | 'refresh_pending'
  | 'expired'
  | 'revoked';

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

export type DaemonResult =
  | {
      daemon: 'already-running';
      pid: number;
      state: 'ready';
      transport: DaemonTransportState;
      credentialState: DaemonCredentialState;
    }
  | {
      daemon: 'spawned';
      pid?: number;
      state?: 'ready';
      transport?: DaemonTransportState;
      credentialState?: DaemonCredentialState;
    }
  | {
      daemon: 'starting';
      pid: number;
      transport: DaemonTransportState;
      credentialState: DaemonCredentialState;
    }
  | {
      daemon: 'restarted';
      pid: number;
      replacedPid: number;
      reason: 'obsolete' | 'unhealthy';
      state: 'ready';
      transport: DaemonTransportState;
      credentialState: DaemonCredentialState;
    }
  | { daemon: 'skipped'; reason: string }
  | {
      daemon: 'unavailable';
      reason:
        | 'foreign_or_unverifiable'
        | 'reconcile_busy'
        | 'startup_failed'
        | 'readiness_timeout'
        | 'deadline_exhausted'
        | 'startup_cooldown'
        | 'stop_failed'
        | 'unsupported_platform'
        | 'unsupported_safe_replacement';
      pid?: number;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      detail?: string;
    };

export interface EnsureDaemonArgs {
  config: SpellguardConfig;
  spawnDaemon?: (
    execPath: string,
    args: string[],
    opts: SpawnOptions,
  ) => ChildProcess | undefined;
  configDir?: string;
  cwd?: string;
  readinessTimeoutMs?: number;
  heartbeatMaxAgeMs?: number;
  stopTimeoutMs?: number;
  reconcileTimeoutMs?: number;
  deadlineAtMs?: number;
  startupCooldownMs?: number;
}

interface ProcessSnapshot {
  pid: number;
  startToken: string;
  argv: string[];
  commandLine: string;
  environment: Record<string, string> | null;
}

interface DaemonClassification {
  kind:
    | 'missing'
    | 'dead'
    | 'current'
    | 'starting'
    | 'obsolete'
    | 'unhealthy'
    | 'foreign'
    | 'unverifiable';
  pid?: number;
  snapshot?: ProcessSnapshot;
  health?: DaemonHealthRecord;
}

export interface ReconcilePermit {
  isHeld(): boolean;
}

interface ReconcileLock extends ReconcilePermit {
  release(): void;
}

type StartupAttemptRecord =
  | {
      schemaVersion: 1;
      kind: 'failure';
      artifactId: string;
      failedAt: string;
      retryAfter: string;
      reason: 'startup_failed';
    }
  | {
      schemaVersion: 1;
      kind: 'pending';
      artifactId: string;
      pid: number;
      observedAt: string;
      retryAfter: string;
    };

export interface DaemonHealthReporter {
  markReady(): void;
  setTransport(state: DaemonTransportState, error?: string): void;
  setCredentialState(state: DaemonCredentialState): void;
  close(): void;
}

function agentsDir(configDir: string): string {
  return join(configDir, 'agents');
}

export function daemonPidFilePath(configDir: string, agentId: string): string {
  return join(agentsDir(configDir), `${agentId}.pid`);
}

export function daemonHealthFilePath(
  configDir: string,
  agentId: string,
): string {
  return join(agentsDir(configDir), `${agentId}.health.json`);
}

function daemonLockPath(configDir: string, agentId: string): string {
  return join(agentsDir(configDir), `${agentId}.reconcile.lock`);
}

function daemonStartupStatePath(configDir: string, agentId: string): string {
  return join(agentsDir(configDir), `${agentId}.startup-state.json`);
}

/** Resolve the daemon artifact shipped beside the currently executing plugin. */
export function daemonScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const devPath = join(
    here,
    '..',
    '..',
    'bin',
    'spellguard-credential-daemon.ts',
  );
  const builtPath = join(here, 'spellguard-credential-daemon.mjs');
  const runningFromDist =
    here.endsWith(`${sep}dist${sep}bin`) || here.endsWith('/dist/bin');
  if (runningFromDist && existsSync(builtPath)) return realpathSync(builtPath);
  if (existsSync(devPath)) return realpathSync(devPath);
  return resolve(builtPath);
}

/** Fingerprint the local installed artifact. No network version lookup occurs. */
export function daemonArtifactId(scriptPath = daemonScriptPath()): string {
  const canonicalPath = existsSync(scriptPath)
    ? realpathSync(scriptPath)
    : resolve(scriptPath);
  const hash = createHash('sha256');
  hash.update(canonicalPath);
  hash.update('\0');
  hash.update(readFileSync(canonicalPath));
  return hash.digest('hex');
}

function readDaemonPid(pidPath: string): number | null {
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

export function readDaemonHealth(
  configDir: string,
  agentId: string,
): DaemonHealthRecord | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(daemonHealthFilePath(configDir, agentId), 'utf8'),
    );
    if (!isDaemonHealthRecord(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isDaemonHealthRecord(value: unknown): value is DaemonHealthRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === HEALTH_SCHEMA_VERSION &&
    typeof record.pid === 'number' &&
    typeof record.processStartToken === 'string' &&
    typeof record.agentId === 'string' &&
    typeof record.configDir === 'string' &&
    typeof record.scriptPath === 'string' &&
    typeof record.artifactId === 'string' &&
    typeof record.instanceId === 'string' &&
    typeof record.heartbeatAt === 'string' &&
    (record.processState === 'starting' || record.processState === 'ready') &&
    (record.transportState === 'connecting' ||
      record.transportState === 'connected' ||
      record.transportState === 'error') &&
    (record.credentialState === 'missing' ||
      record.credentialState === 'valid' ||
      record.credentialState === 'near_expiry' ||
      record.credentialState === 'refresh_pending' ||
      record.credentialState === 'expired' ||
      record.credentialState === 'revoked')
  );
}

function writeHealthRecord(path: string, record: DaemonHealthRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${record.instanceId}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
}

function removeOwnedHealthRecord(path: string, instanceId: string): void {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).instanceId === instanceId
    ) {
      unlinkSync(path);
    }
  } catch {
    // A replacement daemon may already own the path.
  }
}

function readStartupAttempt(
  configDir: string,
  agentId: string,
): StartupAttemptRecord | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(daemonStartupStatePath(configDir, agentId), 'utf8'),
    );
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.artifactId !== 'string' ||
      typeof record.retryAfter !== 'string'
    ) {
      return null;
    }
    if (
      record.kind === 'failure' &&
      record.reason === 'startup_failed' &&
      typeof record.failedAt === 'string'
    ) {
      return {
        schemaVersion: 1,
        kind: 'failure',
        artifactId: record.artifactId,
        failedAt: record.failedAt,
        retryAfter: record.retryAfter,
        reason: 'startup_failed',
      };
    }
    if (
      record.kind === 'pending' &&
      Number.isInteger(record.pid) &&
      typeof record.pid === 'number' &&
      record.pid > 1 &&
      typeof record.observedAt === 'string'
    ) {
      return {
        schemaVersion: 1,
        kind: 'pending',
        artifactId: record.artifactId,
        pid: record.pid,
        observedAt: record.observedAt,
        retryAfter: record.retryAfter,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStartupAttempt(
  configDir: string,
  agentId: string,
  record: StartupAttemptRecord,
): void {
  const path = daemonStartupStatePath(configDir, agentId);
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
}

function clearStartupAttempt(configDir: string, agentId: string): void {
  rmSync(daemonStartupStatePath(configDir, agentId), { force: true });
}

function activeStartupAttempt(
  configDir: string,
  agentId: string,
  artifactId: string,
): StartupAttemptRecord | null {
  const record = readStartupAttempt(configDir, agentId);
  if (record?.artifactId !== artifactId) return null;
  const retryAfter = Date.parse(record.retryAfter);
  return Number.isFinite(retryAfter) && retryAfter > Date.now() ? record : null;
}

export function startDaemonHealthReporter(args: {
  agentId: string;
  configDir: string;
  scriptPath: string;
  artifactId: string;
  instanceId: string;
  credentialState: DaemonCredentialState;
  heartbeatIntervalMs?: number;
}): DaemonHealthReporter {
  const path = daemonHealthFilePath(args.configDir, args.agentId);
  const snapshot = readProcessSnapshot(process.pid);
  if (!snapshot) throw new Error('could not read daemon process identity');
  let record: DaemonHealthRecord = {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    pid: process.pid,
    processStartToken: snapshot.startToken,
    agentId: args.agentId,
    configDir: resolve(args.configDir),
    scriptPath: resolve(args.scriptPath),
    artifactId: args.artifactId,
    instanceId: args.instanceId,
    heartbeatAt: new Date().toISOString(),
    processState: 'starting',
    transportState: 'connecting',
    credentialState: args.credentialState,
  };
  const flush = (): void => {
    record = { ...record, heartbeatAt: new Date().toISOString() };
    writeHealthRecord(path, record);
  };
  flush();
  const interval = setInterval(flush, args.heartbeatIntervalMs ?? 1_000);
  interval.unref();
  return {
    markReady: () => {
      record = { ...record, processState: 'ready' };
      flush();
    },
    setTransport: (state, error) => {
      record = {
        ...record,
        transportState: state,
        ...(error ? { transportError: error } : { transportError: undefined }),
      };
      flush();
    },
    setCredentialState: (state) => {
      record = { ...record, credentialState: state };
      flush();
    },
    close: () => {
      clearInterval(interval);
      removeOwnedHealthRecord(path, args.instanceId);
    },
  };
}

/** Reconcile one agent's daemon with the plugin artifact installed on disk. */
export async function ensureCredentialDaemonRunning(
  args: EnsureDaemonArgs,
): Promise<DaemonResult> {
  const { config } = args;
  if (!config.agentSecret || !config.agentId) {
    return { daemon: 'skipped', reason: 'missing_credentials' };
  }
  const configDir = resolve(args.configDir ?? defaultConfigDir());
  const deadlineAtMs =
    args.deadlineAtMs ??
    Date.now() +
      (args.reconcileTimeoutMs ?? RECONCILE_LOCK_TIMEOUT_MS) +
      (args.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) +
      (args.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  const scopedArgs = { ...args, configDir, deadlineAtMs };
  if (remainingMs(deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  mkdirSync(agentsDir(configDir), { recursive: true, mode: 0o700 });
  if (platform() === 'darwin') {
    return reconcileUnderLock(scopedArgs, { isHeld: () => true }, false);
  }
  if (platform() !== 'linux') {
    return { daemon: 'unavailable', reason: 'unsupported_platform' };
  }
  const lock = await acquireReconcileLock(
    daemonLockPath(configDir, config.agentId),
    Math.min(
      deadlineAtMs - FINALIZATION_RESERVE_MS,
      Date.now() + (args.reconcileTimeoutMs ?? RECONCILE_LOCK_TIMEOUT_MS),
    ),
  );
  if (!lock) {
    return {
      daemon: 'unavailable',
      reason:
        remainingMs(deadlineAtMs) <= FINALIZATION_RESERVE_MS
          ? 'deadline_exhausted'
          : 'reconcile_busy',
    };
  }
  try {
    return await reconcileUnderLock(scopedArgs, lock, true);
  } finally {
    lock.release();
  }
}

/**
 * Reconcile one daemon while the caller holds the agent's lock permit.
 *
 * Keeping the permit explicit makes the post-spawn fencing boundary
 * deterministic to exercise: the caller must still own the permit before the
 * pending-start marker is published, and a lost permit must leave newer state
 * untouched. The production entry point supplies the kernel-backed permit.
 */
export async function reconcileUnderLock(
  args: EnsureDaemonArgs & { configDir: string; deadlineAtMs: number },
  permit: ReconcilePermit,
  allowSafeReplacement: boolean,
): Promise<DaemonResult> {
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  const scriptPath = daemonScriptPath();
  const artifactId = daemonArtifactId(scriptPath);
  const classification = classifyDaemon({
    agentId: args.config.agentId,
    configDir: args.configDir,
    scriptPath,
    artifactId,
    heartbeatMaxAgeMs: args.heartbeatMaxAgeMs ?? DEFAULT_HEARTBEAT_MAX_AGE_MS,
  });
  if (classification.kind === 'current' && classification.health) {
    if (
      allowSafeReplacement &&
      permit.isHeld() &&
      remainingMs(args.deadlineAtMs) > FINALIZATION_RESERVE_MS
    ) {
      clearStartupAttempt(args.configDir, args.config.agentId);
    }
    return resultFromHealth('already-running', classification.health);
  }
  if (classification.kind === 'starting' && classification.health) {
    if (
      allowSafeReplacement &&
      permit.isHeld() &&
      remainingMs(args.deadlineAtMs) > FINALIZATION_RESERVE_MS
    ) {
      clearStartupAttempt(args.configDir, args.config.agentId);
    }
    return {
      daemon: 'starting',
      pid: classification.health.pid,
      transport: classification.health.transportState,
      credentialState: classification.health.credentialState,
    };
  }
  if (
    !allowSafeReplacement &&
    classification.kind !== 'missing' &&
    classification.kind !== 'dead'
  ) {
    return {
      daemon: 'unavailable',
      reason: 'unsupported_safe_replacement',
      pid: classification.pid,
      detail:
        'this platform leaves a live non-current daemon untouched because serialized safe replacement is unavailable',
    };
  }
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  const startupAttempt = allowSafeReplacement
    ? activeStartupAttempt(args.configDir, args.config.agentId, artifactId)
    : null;
  if (startupAttempt) {
    return {
      daemon: 'unavailable',
      reason: 'startup_cooldown',
      ...(startupAttempt.kind === 'pending' ? { pid: startupAttempt.pid } : {}),
      detail:
        startupAttempt.kind === 'pending'
          ? `the previous daemon start is still pending; retry after ${startupAttempt.retryAfter}`
          : `daemon startup failed; retry after ${startupAttempt.retryAfter}`,
    };
  }
  if (classification.kind === 'unverifiable') {
    return {
      daemon: 'unavailable',
      reason: 'foreign_or_unverifiable',
      pid: classification.pid,
      detail:
        'a live daemon-like process could not be tied to this config root',
    };
  }
  if (classification.kind === 'foreign') {
    if (!permit.isHeld()) return reconcileLockLost();
    if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
      return deadlineExhausted();
    }
    if (
      classification.pid &&
      !unlinkPidIfUnchanged(
        daemonPidFilePath(args.configDir, args.config.agentId),
        classification.pid,
      )
    ) {
      return {
        daemon: 'unavailable',
        reason: 'foreign_or_unverifiable',
        pid: classification.pid,
        detail: 'daemon PID record changed during reconciliation',
      };
    }
  }

  let replacement:
    | { pid: number; reason: 'obsolete' | 'unhealthy' }
    | undefined;
  if (
    (classification.kind === 'obsolete' ||
      classification.kind === 'unhealthy') &&
    classification.pid &&
    classification.snapshot
  ) {
    const stopped = await stopOwnedProcess({
      snapshot: classification.snapshot,
      agentId: args.config.agentId,
      configDir: args.configDir,
      instanceId: classification.health?.instanceId,
      deadlineAtMs: Math.min(
        args.deadlineAtMs - FINALIZATION_RESERVE_MS,
        Date.now() + (args.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS),
      ),
      canMutate: permit.isHeld,
    });
    if (!stopped) {
      return {
        daemon: 'unavailable',
        reason:
          remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS
            ? 'deadline_exhausted'
            : 'stop_failed',
        pid: classification.pid,
      };
    }
    replacement = { pid: classification.pid, reason: classification.kind };
  }

  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  if (!permit.isHeld()) return reconcileLockLost();
  removeStaleArtifacts(args.configDir, args.config.agentId);
  const instanceId = randomUUID();
  const spawnFn = args.spawnDaemon ?? defaultSpawnDaemon;
  const childEnv = { ...process.env };
  if (scriptPath.endsWith('.ts')) {
    childEnv.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--import tsx']
      .filter(Boolean)
      .join(' ');
  }
  if (!permit.isHeld()) return reconcileLockLost();
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  const child = spawnFn(
    process.execPath,
    [
      scriptPath,
      args.config.agentId,
      '--config-dir',
      args.configDir,
      '--instance-id',
      instanceId,
      '--artifact-id',
      artifactId,
      ...(args.cwd ? ['--cwd', args.cwd] : []),
    ],
    { detached: true, stdio: 'ignore', env: childEnv },
  );
  if (!child) return { daemon: 'spawned' };
  // Do not persist a replacement marker after the reconciliation lease has
  // been lost: a newer reconciler may already own that state file.
  if (!permit.isHeld()) return reconcileLockLost();
  const cooldownMs = Math.max(
    0,
    args.startupCooldownMs ?? DEFAULT_STARTUP_COOLDOWN_MS,
  );
  // Persist ownership of the newly spawned process before any further
  // deadline/lock checks. The active-hook deadline may expire immediately
  // after spawn; without this marker the stale PID was already removed and a
  // later hook could neither identify nor cool down the in-flight start.
  if (allowSafeReplacement && child.pid) {
    const observedAt = new Date();
    writeStartupAttempt(args.configDir, args.config.agentId, {
      schemaVersion: 1,
      kind: 'pending',
      artifactId,
      pid: child.pid,
      observedAt: observedAt.toISOString(),
      retryAfter: new Date(observedAt.getTime() + cooldownMs).toISOString(),
    });
  }
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }

  const readiness = await waitForReadiness({
    child,
    agentId: args.config.agentId,
    configDir: args.configDir,
    instanceId,
    artifactId,
    deadlineAtMs: Math.min(
      args.deadlineAtMs - FINALIZATION_RESERVE_MS,
      Date.now() + (args.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS),
    ),
  });
  if (!permit.isHeld()) return reconcileLockLost();
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  if (readiness.kind === 'failed') {
    const now = new Date();
    const retryAfter = new Date(now.getTime() + cooldownMs).toISOString();
    if (allowSafeReplacement && readiness.reason === 'startup_failed') {
      writeStartupAttempt(args.configDir, args.config.agentId, {
        schemaVersion: 1,
        kind: 'failure',
        artifactId,
        failedAt: now.toISOString(),
        retryAfter,
        reason: 'startup_failed',
      });
    }
    return {
      daemon: 'unavailable',
      reason: readiness.reason,
      pid: child.pid,
      exitCode: readiness.exitCode,
      signal: readiness.signal,
    };
  }
  if (allowSafeReplacement) {
    clearStartupAttempt(args.configDir, args.config.agentId);
  }
  if (readiness.kind === 'starting') {
    return {
      daemon: 'starting',
      pid: readiness.health.pid,
      transport: readiness.health.transportState,
      credentialState: readiness.health.credentialState,
    };
  }
  if (replacement) {
    return {
      daemon: 'restarted',
      pid: readiness.health.pid,
      replacedPid: replacement.pid,
      reason: replacement.reason,
      state: 'ready',
      transport: readiness.health.transportState,
      credentialState: readiness.health.credentialState,
    };
  }
  return resultFromHealth('spawned', readiness.health);
}

function deadlineExhausted(): Extract<DaemonResult, { daemon: 'unavailable' }> {
  return { daemon: 'unavailable', reason: 'deadline_exhausted' };
}

function reconcileLockLost(): Extract<DaemonResult, { daemon: 'unavailable' }> {
  return {
    daemon: 'unavailable',
    reason: 'reconcile_busy',
    detail: 'the reconciliation lock holder exited before completion',
  };
}

function resultFromHealth(
  daemon: 'already-running',
  health: DaemonHealthRecord,
): Extract<DaemonResult, { daemon: 'already-running' }>;
function resultFromHealth(
  daemon: 'spawned',
  health: DaemonHealthRecord,
): Extract<DaemonResult, { daemon: 'spawned' }>;
function resultFromHealth(
  daemon: 'already-running' | 'spawned',
  health: DaemonHealthRecord,
): DaemonResult {
  const shared = {
    pid: health.pid,
    state: 'ready' as const,
    transport: health.transportState,
    credentialState: health.credentialState,
  };
  return daemon === 'already-running'
    ? { daemon: 'already-running', ...shared }
    : { daemon: 'spawned', ...shared };
}

function classifyDaemon(args: {
  agentId: string;
  configDir: string;
  scriptPath: string;
  artifactId: string;
  heartbeatMaxAgeMs: number;
}): DaemonClassification {
  const pidPath = daemonPidFilePath(args.configDir, args.agentId);
  const pid = readDaemonPid(pidPath);
  if (!pid) return { kind: existsSync(pidPath) ? 'dead' : 'missing' };
  if (!processExists(pid)) return { kind: 'dead', pid };
  const snapshot = readProcessSnapshot(pid);
  if (!snapshot) return { kind: 'unverifiable', pid };
  const health = readDaemonHealth(args.configDir, args.agentId);
  const ownership = daemonProcessOwnership(
    snapshot,
    args.agentId,
    args.configDir,
    health,
  );
  if (ownership !== 'owned') {
    return {
      kind: ownership,
      pid,
      snapshot,
      health: health ?? undefined,
    };
  }
  if (!health || health.pid !== pid) {
    return { kind: 'unhealthy', pid, snapshot, health: health ?? undefined };
  }
  if (
    health.artifactId !== args.artifactId ||
    resolve(health.scriptPath) !== resolve(args.scriptPath)
  ) {
    return { kind: 'obsolete', pid, snapshot, health };
  }
  const heartbeatAge = Date.now() - Date.parse(health.heartbeatAt);
  if (
    health.processState === 'starting' &&
    Number.isFinite(heartbeatAge) &&
    heartbeatAge <= args.heartbeatMaxAgeMs &&
    health.processStartToken === snapshot.startToken
  ) {
    return { kind: 'starting', pid, snapshot, health };
  }
  if (
    health.processState !== 'ready' ||
    !Number.isFinite(heartbeatAge) ||
    heartbeatAge > args.heartbeatMaxAgeMs ||
    health.processStartToken !== snapshot.startToken
  ) {
    return { kind: 'unhealthy', pid, snapshot, health };
  }
  return { kind: 'current', pid, snapshot, health };
}

function processExists(pid: number): boolean {
  if (platform() === 'linux') {
    try {
      // `kill(pid, 0)` reports a zombie as present even though it can no
      // longer service credentials or respond to a stop signal. Treating that
      // state as live makes a forced stop consume the entire deadline and
      // leaves reconciliation unable to preserve its state boundary.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen >= 0) {
        const state = stat
          .slice(closeParen + 2)
          .trim()
          .split(/\s+/, 1)[0];
        if (state === 'Z') return false;
      }
    } catch {
      // Fall through to the portable signal probe below.
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readProcessSnapshot(pid: number): ProcessSnapshot | null {
  if (!processExists(pid)) return null;
  if (platform() === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return null;
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      const startToken = fields[19];
      if (!startToken) return null;
      const argv = readFileSync(`/proc/${pid}/cmdline`)
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      const environment = Object.fromEntries(
        readFileSync(`/proc/${pid}/environ`)
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
          .map((entry) => {
            const index = entry.indexOf('=');
            return index < 0
              ? [entry, '']
              : [entry.slice(0, index), entry.slice(index + 1)];
          }),
      );
      return {
        pid,
        startToken,
        argv,
        commandLine: argv.join(' '),
        environment,
      };
    } catch {
      return null;
    }
  }
  if (platform() === 'darwin') {
    try {
      const startToken = execFileSync(
        'ps',
        ['-p', String(pid), '-o', 'lstart='],
        { encoding: 'utf8' },
      ).trim();
      const commandLine = execFileSync(
        'ps',
        ['-ww', '-p', String(pid), '-o', 'command='],
        { encoding: 'utf8' },
      ).trim();
      return {
        pid,
        startToken,
        argv: parseObservedCommandLine(commandLine),
        commandLine,
        environment: null,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function parseObservedCommandLine(commandLine: string): string[] {
  if (!commandLine || /["'\\]/.test(commandLine)) return [];
  return commandLine.split(/\s+/);
}

function daemonProcessOwnership(
  snapshot: ProcessSnapshot,
  agentId: string,
  configDir: string,
  health: DaemonHealthRecord | null,
): 'owned' | 'foreign' | 'unverifiable' {
  if (health) {
    if (
      health.pid !== snapshot.pid ||
      health.processStartToken !== snapshot.startToken ||
      health.agentId !== agentId ||
      resolve(health.configDir) !== resolve(configDir)
    ) {
      return 'foreign';
    }
  }
  if (snapshot.argv.length === 0 || !snapshot.commandLine) {
    return 'unverifiable';
  }
  const scriptIndex = snapshot.argv.findIndex((arg) =>
    /^spellguard-credential-daemon\.(?:mjs|ts)$/.test(basename(arg)),
  );
  if (scriptIndex < 0 || snapshot.argv[scriptIndex + 1] !== agentId) {
    return 'foreign';
  }
  const configuredRoot = flagValue(snapshot.argv, '--config-dir');
  if (configuredRoot) {
    return resolve(configuredRoot) === resolve(configDir) ? 'owned' : 'foreign';
  }
  const environmentRoot = defaultConfigDirFromEnvironment(snapshot.environment);
  if (!environmentRoot) return 'unverifiable';
  return resolve(environmentRoot) === resolve(configDir) ? 'owned' : 'foreign';
}

/** Signal a daemon only after two matching process-identity reads. */
export function signalOwnedCredentialDaemon(args: {
  pid: number;
  agentId: string;
  configDir: string;
  signal: NodeJS.Signals;
}): boolean {
  const first = readProcessSnapshot(args.pid);
  const health = readDaemonHealth(args.configDir, args.agentId);
  if (
    !first ||
    daemonProcessOwnership(first, args.agentId, args.configDir, health) !==
      'owned'
  ) {
    return false;
  }
  const second = readProcessSnapshot(args.pid);
  if (
    !second ||
    second.startToken !== first.startToken ||
    daemonProcessOwnership(second, args.agentId, args.configDir, health) !==
      'owned'
  ) {
    return false;
  }
  try {
    process.kill(args.pid, args.signal);
    return true;
  } catch {
    return false;
  }
}

function defaultConfigDirFromEnvironment(
  environment: Record<string, string> | null,
): string | null {
  if (!environment) return null;
  if (environment.XDG_CONFIG_HOME) {
    return join(environment.XDG_CONFIG_HOME, 'spellguard', 'codex');
  }
  const home = environment.HOME;
  return home ? join(home, '.config', 'spellguard', 'codex') : null;
}

function flagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

async function stopOwnedProcess(args: {
  snapshot: ProcessSnapshot;
  agentId: string;
  configDir: string;
  instanceId?: string;
  deadlineAtMs: number;
  canMutate: () => boolean;
}): Promise<boolean> {
  if (
    remainingMs(args.deadlineAtMs) <= 0 ||
    !args.canMutate() ||
    !sameOwnedProcess(args) ||
    remainingMs(args.deadlineAtMs) <= 0
  ) {
    return false;
  }
  try {
    process.kill(args.snapshot.pid, 'SIGTERM');
  } catch {
    return !processExists(args.snapshot.pid);
  }
  const gracefulDeadlineAtMs = Math.max(
    Date.now(),
    args.deadlineAtMs - FORCE_KILL_RESERVE_MS,
  );
  if (await waitForProcessExit(args.snapshot.pid, gracefulDeadlineAtMs))
    return true;
  if (
    remainingMs(args.deadlineAtMs) <= 0 ||
    !args.canMutate() ||
    !sameOwnedProcess(args) ||
    remainingMs(args.deadlineAtMs) <= 0
  ) {
    return false;
  }
  try {
    process.kill(args.snapshot.pid, 'SIGKILL');
  } catch {
    return !processExists(args.snapshot.pid);
  }
  return waitForProcessExit(args.snapshot.pid, args.deadlineAtMs);
}

function sameOwnedProcess(args: {
  snapshot: ProcessSnapshot;
  agentId: string;
  configDir: string;
  instanceId?: string;
}): boolean {
  const current = readProcessSnapshot(args.snapshot.pid);
  if (!current || current.startToken !== args.snapshot.startToken) return false;
  const health = readDaemonHealth(args.configDir, args.agentId);
  if (args.instanceId && health && health.instanceId !== args.instanceId) {
    return false;
  }
  return (
    daemonProcessOwnership(current, args.agentId, args.configDir, health) ===
    'owned'
  );
}

async function waitForProcessExit(
  pid: number,
  deadlineAtMs: number,
): Promise<boolean> {
  while (remainingMs(deadlineAtMs) > 0) {
    if (!processExists(pid)) return true;
    await delay(Math.min(25, remainingMs(deadlineAtMs)));
  }
  return !processExists(pid);
}

function unlinkPidIfUnchanged(path: string, expectedPid: number): boolean {
  if (readDaemonPid(path) !== expectedPid) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return !existsSync(path);
  }
}

function removeStaleArtifacts(configDir: string, agentId: string): void {
  rmSync(daemonPidFilePath(configDir, agentId), { force: true });
  rmSync(daemonHealthFilePath(configDir, agentId), { force: true });
}

async function waitForReadiness(args: {
  child: ChildProcess;
  agentId: string;
  configDir: string;
  instanceId: string;
  artifactId: string;
  deadlineAtMs: number;
}): Promise<
  | { kind: 'ready'; health: DaemonHealthRecord }
  | { kind: 'starting'; health: DaemonHealthRecord }
  | {
      kind: 'failed';
      reason: 'startup_failed' | 'readiness_timeout';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
> {
  while (remainingMs(args.deadlineAtMs) > 0) {
    const health = readDaemonHealth(args.configDir, args.agentId);
    if (
      health?.instanceId === args.instanceId &&
      health.artifactId === args.artifactId &&
      health.processState === 'ready'
    ) {
      return { kind: 'ready', health };
    }
    if (args.child.exitCode !== null || args.child.signalCode !== null) {
      return {
        kind: 'failed',
        reason: 'startup_failed',
        exitCode: args.child.exitCode,
        signal: args.child.signalCode,
      };
    }
    await delay(Math.min(25, remainingMs(args.deadlineAtMs)));
  }
  const health = readDaemonHealth(args.configDir, args.agentId);
  if (
    health?.instanceId === args.instanceId &&
    health.artifactId === args.artifactId &&
    health.processState === 'starting' &&
    processExists(health.pid)
  ) {
    return { kind: 'starting', health };
  }
  return {
    kind: 'failed',
    reason: 'readiness_timeout',
    exitCode: args.child.exitCode,
    signal: args.child.signalCode,
  };
}

async function acquireReconcileLock(
  path: string,
  deadlineAtMs: number,
): Promise<ReconcileLock | null> {
  const timeoutMs = remainingMs(deadlineAtMs);
  if (timeoutMs <= 0) return null;
  const flockPath = FLOCK_PATHS.find((candidate) => existsSync(candidate));
  if (!flockPath) return null;
  writeFileSync(path, '', { flag: 'a', mode: 0o600 });
  chmodSync(path, 0o600);
  const child = spawn(
    flockPath,
    [
      '--wait',
      String(Math.max(timeoutMs, 1) / 1_000),
      '--no-fork',
      path,
      process.execPath,
      '-e',
      LOCK_HOLDER_SCRIPT,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  return waitForLockHolder(child, deadlineAtMs);
}

async function waitForLockHolder(
  child: ChildProcess,
  deadlineAtMs: number,
): Promise<ReconcileLock | null> {
  return new Promise((resolveLock) => {
    let settled = false;
    let held = false;
    let output = '';
    const finish = (result: ReconcileLock | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveLock(result);
    };
    const fail = (): void => {
      held = false;
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      finish(null);
    };
    const timer = setTimeout(fail, remainingMs(deadlineAtMs));
    child.once('error', fail);
    child.stdin?.once('error', fail);
    child.once('exit', () => {
      held = false;
      finish(null);
    });
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (!output.includes('locked\n')) return;
      held = true;
      finish({
        isHeld: () =>
          held && child.exitCode === null && child.signalCode === null,
        release: () => {
          if (!held) return;
          held = false;
          if (child.stdin?.writable) {
            child.stdin.end();
          } else if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
          }
        },
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function remainingMs(deadlineAtMs: number): number {
  return Math.max(0, deadlineAtMs - Date.now());
}

function defaultSpawnDaemon(
  execPath: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcess {
  const child = spawn(execPath, args, opts);
  child.unref();
  return child;
}
