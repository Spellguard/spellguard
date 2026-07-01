// SPDX-License-Identifier: Apache-2.0

/**
 * Shared supervision primitives for the Verifier's three SLIM workers
 * (endpoint listener, send-to-agent sender, push-registry sender).
 *
 * Each host supervises its own worker — the listener respawns eagerly (it
 * must always be subscribed) while the senders respawn lazily on next use —
 * so the hosts are deliberately NOT unified. What IS identical by design is
 * the escalation math: respawn with a short backoff, and exit the whole
 * process (so the ECS supervisor replaces the task) when exits thrash.
 * Those constants and the window-counting live here so the three hosts
 * can't drift apart.
 */

/** Sliding window for counting unexpected worker exits. */
export const RESTART_WINDOW_MS = 120_000;
/** Unexpected exits tolerated within the window before escalating. */
export const MAX_RESTARTS_IN_WINDOW = 5;
/**
 * Delay before a respawn. 2s (not 1s) so a normal SLIM-data-plane cold
 * start — the co-located `slim` container is a START (not HEALTHY)
 * dependency, so connectAsync can race ahead of it being ready — is
 * absorbed by a few respawns instead of escalating to a full task
 * replacement. (The proper fix is a HEALTHY container dependency in the
 * infra stack.)
 */
export const RESTART_BACKOFF_MS = 2_000;

export interface RestartVerdict {
  /** True when exits thrashed past the window cap — exit the process. */
  escalate: boolean;
  /**
   * Exits currently inside the window. On a respawn verdict this counts
   * the exit just recorded; on an escalate verdict it's the (already
   * full) window that triggered the escalation.
   */
  recentExits: number;
}

export interface RestartTracker {
  recordExit(now?: number): RestartVerdict;
}

/**
 * Counts unexpected worker exits in a sliding window. Mirrors the
 * escalation semantics the endpoint listener has always had: the
 * (MAX_RESTARTS_IN_WINDOW + 1)th exit inside RESTART_WINDOW_MS escalates,
 * i.e. up to MAX_RESTARTS_IN_WINDOW respawns are tolerated per window.
 */
export function createRestartTracker(
  opts: { windowMs?: number; maxInWindow?: number } = {},
): RestartTracker {
  const windowMs = opts.windowMs ?? RESTART_WINDOW_MS;
  const maxInWindow = opts.maxInWindow ?? MAX_RESTARTS_IN_WINDOW;
  let timestamps: number[] = [];
  return {
    recordExit(now = Date.now()) {
      timestamps = timestamps.filter((t) => now - t <= windowMs);
      if (timestamps.length >= maxInWindow) {
        return { escalate: true, recentExits: timestamps.length };
      }
      timestamps.push(now);
      return { escalate: false, recentExits: timestamps.length };
    },
  };
}

/**
 * Fail every pending in-flight request and clear the map, so callers fail
 * fast instead of hanging until a backstop timer (or forever, for callers
 * without one). The sender modules' contract is never-throws — failures
 * fold into an `ok: false` outcome — so "fail" here means resolving each
 * pending promise with `makeFailure()`, not rejecting it.
 *
 * Returns how many requests were failed (for the caller's log line).
 */
export function failAllPending<T>(
  pending: Map<string, (out: T) => void>,
  makeFailure: () => T,
): number {
  const resolvers = [...pending.values()];
  pending.clear();
  for (const resolve of resolvers) resolve(makeFailure());
  return resolvers.length;
}

/**
 * Log and exit the process so the ECS supervisor replaces the task. Used
 * when a SLIM worker thrashes (restart tracker escalates) or reports a
 * wedge it cannot recover from ('request-process-exit' — the bindings'
 * Tokio runtime thread survives a JS Worker exit, so only a fresh process
 * recovers cleanly). The brief delay lets the log line flush first.
 */
export function escalateProcessExit(context: string, reason: string): void {
  console.error(
    `[${context}] fatal: ${reason} — exiting so ECS replaces the task`,
  );
  setTimeout(() => process.exit(1), 100);
}
