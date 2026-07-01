// SPDX-License-Identifier: Apache-2.0
//
// Proactive low-watermark self-recycle for the verifier.
//
// The @agntcy/slim bindings leak native RSS in the verifier's SLIM worker
// threads (heapUsed stays flat; rss climbs ~300MB→6GB under sustained load —
// see docs + the demo-tick-errors investigation). Until that's fully reclaimed
// upstream (or by the listener's session teardown), the kernel OOM-kills the
// verifier mid-tick. This converts that hard SIGKILL into a clean, hands-off
// restart: once RSS crosses a watermark AND no message delivery is in flight,
// exit(0) so ECS replaces the task in an IDLE gap instead of mid-delivery.
//
// In-flight tracking is incremented/decremented around routeMessage (and the
// unilateral router) so the guard never recycles while a (possibly 30-120s
// LLM-bearing) delivery is running.

let inFlight = 0;

/** Mark a message delivery as started. Pair with endDelivery() in a finally. */
export function beginDelivery(): void {
  inFlight++;
}

/** Mark a message delivery as finished. */
export function endDelivery(): void {
  if (inFlight > 0) inFlight--;
}

/** Current in-flight delivery count (exported for tests / observability). */
export function inFlightDeliveries(): number {
  return inFlight;
}

export interface SelfRecycleOptions {
  /** Recycle once RSS reaches this many MB. 0 (or negative) disables the guard. */
  rssLimitMb: number;
  /** How often to check, in ms. */
  intervalMs: number;
  /** Invoked when the watermark is crossed while idle. Defaults to exit(0). */
  onRecycle?: () => void;
}

/**
 * Start the self-recycle watcher. Returns the (unref'd) timer, or null when
 * disabled. Exported separately from the install so tests can drive the check.
 */
export function shouldRecycle(rssMb: number, limitMb: number): boolean {
  return limitMb > 0 && rssMb >= limitMb && inFlight === 0;
}

export function installSelfRecycleGuard(
  opts: SelfRecycleOptions,
): ReturnType<typeof setInterval> | null {
  const limit = opts.rssLimitMb;
  if (!limit || limit <= 0) return null;
  const onRecycle =
    opts.onRecycle ??
    (() => {
      // exit(0): a clean exit ECS treats as a normal stop and replaces the
      // task. Give stdout a tick to flush the log line first.
      setTimeout(() => process.exit(0), 100);
    });
  const timer = setInterval(() => {
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    if (rssMb < limit) return;
    if (inFlight > 0) {
      console.log(
        `[Verifier] self-recycle deferred: rss=${rssMb}MB ≥ ${limit}MB but ${inFlight} delivery(ies) in flight`,
      );
      return;
    }
    console.log(
      `[Verifier] self-recycle: rss=${rssMb}MB ≥ ${limit}MB and idle — exit(0) for a clean ECS restart (native SLIM leak mitigation)`,
    );
    onRecycle();
  }, opts.intervalMs);
  timer.unref();
  return timer;
}
