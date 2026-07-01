// SPDX-License-Identifier: Apache-2.0
//
// Shared SLIM wedge detector for the gateway worker. Decides when the
// @agntcy/slim-bindings runtime is wedged badly enough that the only
// recovery is to recycle the process — the upstream session_moderator
// panic lives in a Tokio thread that survives a JS Worker exit, so ECS
// must replace the whole task.
//
// Hard-won design notes (see the adversarial review of this branch +
// commits c52ce29d, 0b48e177, and docs/slim-upstream-issue-draft.md):
//
//   - NO immediate "panic fingerprint" exit. The strings a genuine
//     session_moderator panic produces ('failed to add participant to
//     session', 'message send retries exhausted') are INDISTINGUISHABLE
//     from the benign "verifier route not subscribed yet" case (gateway
//     cold start, verifier ECS restart — see the upstream issue draft).
//     Exiting on first sight of them turns a not-yet-ready verifier into
//     a gateway crash loop. So every failure flows through soft counters.
//   - Consecutive counter (resets on success): catches a fully-wedged
//     plane where every send fails. This is the c52ce29d behavior — a
//     genuine panic makes every subsequent createSessionAndWait throw,
//     so the threshold trips within a few sends.
//   - Windowed counter that DECAYS on success: catches a plane that
//     fails faster than it succeeds, WITHOUT false-tripping a healthy
//     high-throughput gateway (each success drains one failure from the
//     window, so a burst of transient errors amid mostly-successful
//     traffic never accumulates to the threshold).
//
// Pure + side-effect-free (no worker imports) so it can be unit-tested
// off the worker thread. The `now` seam lets tests inject a fake clock.

export function createWedgeDetector({
  suspectThreshold = 5,
  windowMs = 60_000,
  windowThreshold = 8,
  now = () => Date.now(),
} = {}) {
  let consecutive = 0;
  let failures = []; // timestamps of failures still inside the window

  return {
    /**
     * Record a transport/send failure.
     * @returns {{ exit: boolean, reason?: string }} exit=true when the
     *   accumulated evidence indicates a wedged plane that warrants a
     *   process recycle.
     */
    recordFailure(stage, message) {
      consecutive++;
      const t = now();
      failures.push(t);
      failures = failures.filter((ts) => t - ts <= windowMs);
      if (consecutive >= suspectThreshold) {
        return {
          exit: true,
          reason: `slim plane wedged (${consecutive} consecutive ${stage} failures): ${message}`,
        };
      }
      if (failures.length >= windowThreshold) {
        return {
          exit: true,
          reason: `slim plane wedged (${failures.length} ${stage} failures within ${windowMs}ms): ${message}`,
        };
      }
      return { exit: false };
    },

    /**
     * A successful round-trip: clear the consecutive run and drain one
     * failure from the rolling window so a steady stream of successes
     * keeps the windowed guard from accumulating on a healthy gateway.
     */
    noteSuccess() {
      consecutive = 0;
      failures.shift();
    },

    /** Exposed for tests / diagnostics. */
    _state() {
      return { consecutive, windowCount: failures.length };
    },
  };
}
