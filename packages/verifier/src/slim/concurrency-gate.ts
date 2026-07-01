// SPDX-License-Identifier: Apache-2.0

/**
 * A tiny FIFO concurrency gate. Limits how many async tasks run at once;
 * excess callers queue and are handed a slot (in order) as running tasks
 * finish.
 *
 * Used to bound concurrent inbound SLIM message handling in the verifier
 * (each inbound runs the full handler on the single main event loop;
 * unbounded, a burst piles up and starves the cheap /ready + heartbeat
 * handlers, so ECS health-check-kills a busy-but-alive verifier). Pure +
 * side-effect-free so it's unit-testable.
 *
 * Invariant: `inflight` is the number of slots currently held (running
 * tasks), capped at `max`. A queued waiter holds NO slot until a release
 * hands it one (keeping inflight at the cap), so the gate never exceeds
 * `max` concurrent runs and never deadlocks as long as every acquired slot
 * is released — which `run()` guarantees via finally.
 */
export interface ConcurrencyGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Exposed for tests / diagnostics. */
  _state(): { inflight: number; queued: number };
}

export function createConcurrencyGate(maxInFlight: number): ConcurrencyGate {
  const max = Math.max(1, Math.floor(maxInFlight) || 1);
  let inflight = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (inflight < max) {
      inflight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    const next = waiters.shift();
    // Hand the slot straight to the next waiter (inflight stays at the cap);
    // only free a slot when no one is waiting.
    if (next) next();
    else inflight--;
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    _state() {
      return { inflight, queued: waiters.length };
    },
  };
}
