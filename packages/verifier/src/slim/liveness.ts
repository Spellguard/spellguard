// SPDX-License-Identifier: Apache-2.0

/**
 * Main-thread side of the off-loop liveness / self-heal watchdog (see
 * ./liveness-server.mjs). Spawns the responder worker and, every ~1s,
 * publishes two main-loop vitals into a SharedArrayBuffer the worker reads:
 *
 *   Float64[0] = last main-loop heartbeat (epoch ms)   — freshness
 *   Float64[1] = slim-ready flag (1 = SLIM subscribed)
 *   Float64[2] = recent event-loop delay (ms)          — saturation
 *
 * The ALB target group health-checks the responder's port instead of the
 * main HTTP /ready, so the request never touches the (possibly saturated)
 * main loop. The worker fails /ready (→ ECS recycles the task) in two cases:
 *
 *   • WEDGED   — the freshness heartbeat is older than `staleMs` (the loop is
 *                fully blocked / dead). Pre-existing behavior.
 *   • ZOMBIE   — the loop is still ticking (freshness stays < staleMs) but its
 *                event-loop delay has been above `saturationLagMs` continuously
 *                for `saturationSustainedMs`. This is the failure mode the old
 *                freshness-only check MISSED: a loop busy enough to starve the
 *                30s management heartbeat (so management marks the verifier
 *                offline → NO_AVAILABLE_VERIFIER) yet not blocked long enough to
 *                go stale, so it lingered offline-but-not-recycled for tens of
 *                minutes. Self-healing it via an ECS recycle restores service.
 *
 * Real event-loop delay (perf_hooks.monitorEventLoopDelay) is the signal: a
 * busy-but-yielding loop has low delay and is NOT culled, while a persistently
 * saturated one crosses the threshold and is replaced.
 */

import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'liveness-server.mjs',
);

export interface LivenessHandle {
  stop: () => void;
}

export interface LivenessOptions {
  /** Port the responder listens on (ALB health-checks this). */
  port: number;
  /** Max age of the main-loop freshness heartbeat before /ready 503s (wedged). */
  staleMs?: number;
  /** Event-loop delay (ms) above which the loop counts as saturated. */
  saturationLagMs?: number;
  /** How long the loop must stay saturated before /ready 503s (self-heal). */
  saturationSustainedMs?: number;
  /** Whether the SLIM listener is subscribed (gates readiness). */
  isSlimReady: () => boolean;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export function startLivenessResponder(opts: LivenessOptions): LivenessHandle {
  const log = opts.log ?? (() => undefined);
  // 3 × Float64: [0] freshness ms, [1] slim-ready flag, [2] event-loop delay ms.
  const sab = new SharedArrayBuffer(24);
  const view = new Float64Array(sab);

  // perf_hooks event-loop-delay monitor. `.mean` over the sampling window is
  // a smoothed saturation signal (a lone GC pause spikes `.max` but barely
  // moves `.mean`), so transient blips don't trip the sustained check.
  const elMonitor = monitorEventLoopDelay({ resolution: 20 });
  elMonitor.enable();

  const bump = () => {
    view[0] = Date.now();
    view[1] = opts.isSlimReady() ? 1 : 0;
    // mean is in nanoseconds; convert to ms. Reset so each tick reflects only
    // the delay accrued since the last tick (recent, not cumulative).
    view[2] = elMonitor.mean / 1e6;
    elMonitor.reset();
  };
  bump(); // seed before the worker starts serving

  const worker = new Worker(WORKER_PATH, {
    workerData: {
      port: opts.port,
      sab,
      staleMs: opts.staleMs ?? 45_000,
      saturationLagMs: opts.saturationLagMs ?? 250,
      saturationSustainedMs: opts.saturationSustainedMs ?? 45_000,
    },
  });
  worker.on('error', (err) =>
    log('error', `liveness responder worker error: ${err.message}`),
  );
  worker.on('exit', (code) => {
    if (code !== 0) log('warn', `liveness responder exited code=${code}`);
  });

  // Bump from a 1s interval. It fires between the main loop's async awaits,
  // so the freshness heartbeat stays fresh while the verifier is
  // busy-but-yielding and only goes stale if the loop is truly blocked.
  const timer = setInterval(bump, 1_000);
  // Don't let this timer alone keep the process alive.
  (timer as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(timer);
      elMonitor.disable();
      void worker.terminate();
    },
  };
}
