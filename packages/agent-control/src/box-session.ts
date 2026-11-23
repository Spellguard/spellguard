// SPDX-License-Identifier: Apache-2.0

/**
 * Box-local session registration (REQ-011.1/11.2).
 *
 * A framework's SessionStart-class hook is the only place that knows the
 * NATIVE, resumable session id at the moment a session begins. This module is
 * the shared client that reports it to the box daemon's peer-credentialed IPC
 * socket, so both TS plugins register identically and cannot drift.
 *
 * Three properties matter more than completeness here:
 *
 *  - It NEVER throws and never blocks a session start. A workstation with no
 *    box daemon is the documented common case (REQ-011.1), not an error: the
 *    task simply gets no session binding and replies land in the ledger.
 *  - It carries the caller's own multiplexer handle from the ambient
 *    environment. That handle is what later lets an inject verify it still owns
 *    the pane.
 *  - It is bounded in time, so a wedged daemon degrades to "no capture" rather
 *    than a hung session.
 */

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How long the whole register round trip may take before we give up. */
const REGISTER_TIMEOUT_MS = 2_000;

/** Mirrors the Go daemon's `validID`: 1..256 UTF-8 bytes. */
const MAX_ID_BYTES = 256;

export type BoxSessionRegisterOutcome =
  | 'registered'
  | 'no_daemon'
  | 'rejected'
  | 'skipped';

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
export function defaultBoxSocketPath(): string {
  // `process.geteuid` is absent on Windows; the box daemon is POSIX-only, so
  // falling back to a uid-less directory simply fails to connect and degrades
  // to `no_daemon`.
  const euid =
    typeof process.geteuid === 'function' ? process.geteuid() : 'nouid';
  return join(tmpdir(), `spellguard-boxdaemon-${euid}`, 'tasks.sock');
}

function withinIdBound(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES;
}

/**
 * Read the ambient multiplexer handle. tmux exports `$TMUX_PANE` into every
 * process it starts, so a framework session running in a pane inherits it.
 * Absent means "not in a multiplexer", which is a legitimate state.
 */
export function ambientMultiplexerHandle(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const pane = env.TMUX_PANE?.trim();
  return pane && withinIdBound(pane) ? pane : undefined;
}

/**
 * Register a framework session with the box daemon. Resolves to an outcome and
 * never rejects — a hook must not fail because the daemon is absent or slow.
 */
export function registerBoxSession(
  registration: BoxSessionRegistration,
  options: RegisterBoxSessionOptions = {},
): Promise<BoxSessionRegisterOutcome> {
  if (
    !withinIdBound(registration.sessionId) ||
    !withinIdBound(registration.framework) ||
    registration.workingDirectory.length === 0
  ) {
    return Promise.resolve('skipped');
  }

  const socketPath = options.socketPath ?? defaultBoxSocketPath();
  const timeoutMs = options.timeoutMs ?? REGISTER_TIMEOUT_MS;
  const frame = JSON.stringify({
    requestId: `session-register-${randomUUID()}`,
    operation: 'session.register',
    payload: {
      sessionId: registration.sessionId,
      framework: registration.framework,
      workingDirectory: registration.workingDirectory,
      ...(registration.ambientLocation
        ? { ambientLocation: registration.ambientLocation }
        : {}),
      ...(registration.taskId ? { taskId: registration.taskId } : {}),
    },
  });

  return new Promise<BoxSessionRegisterOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: BoxSessionRegisterOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    const socket = createConnection(socketPath);
    socket.setEncoding('utf8');
    const timer = setTimeout(() => finish('no_daemon'), timeoutMs);
    // `unref` keeps a best-effort registration from holding the hook process
    // open past its real work.
    timer.unref?.();

    let response = '';
    socket.on('connect', () => {
      // The daemon reads ONE bounded frame terminated by a half-close, so the
      // write must be followed by `end()` rather than left open.
      socket.end(frame);
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('end', () => {
      try {
        finish(
          (JSON.parse(response) as { ok?: boolean }).ok === true
            ? 'registered'
            : 'rejected',
        );
      } catch {
        finish('rejected');
      }
    });
    socket.on('error', () => finish('no_daemon'));
  });
}

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
export async function captureSessionStart(
  stdin: string,
  framework: string,
  options: RegisterBoxSessionOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<BoxSessionRegisterOutcome> {
  let payload: { session_id?: unknown; cwd?: unknown };
  try {
    payload = stdin ? JSON.parse(stdin) : {};
  } catch {
    return 'skipped';
  }
  if (payload === null || typeof payload !== 'object') return 'skipped';

  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id : '';
  // `cwd` is absent from some payload vintages; the hook's own working
  // directory is the same session's directory, so it is a faithful fallback.
  const workingDirectory =
    typeof payload.cwd === 'string' && payload.cwd.length > 0
      ? payload.cwd
      : process.cwd();
  if (!sessionId) return 'skipped';

  // REQ-011.2b: a session a handler spawned inherits SPELLGUARD_TASK_ID, so
  // registering carries the session -> task binding. That binding is what makes
  // the session addressable for replies instead of them landing in the ledger.
  const env = options.env ?? process.env;
  const taskId = env.SPELLGUARD_TASK_ID?.trim();

  return registerBoxSession(
    {
      sessionId,
      framework,
      workingDirectory,
      ambientLocation: ambientMultiplexerHandle(env),
      ...(taskId ? { taskId } : {}),
    },
    options,
  );
}
