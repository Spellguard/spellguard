// SPDX-License-Identifier: Apache-2.0
//
// Off-main-loop liveness / self-heal responder (worker_thread). Runs its OWN
// tiny HTTP server with its OWN TCP accept loop, so it answers the ALB health
// check promptly even when the verifier's MAIN event loop is saturated under
// concurrent SLIM load.
//
// Source of truth is a SharedArrayBuffer the main thread updates ~every 1s:
//   Float64[0] = last main-loop freshness heartbeat (epoch ms)
//   Float64[1] = slim-ready flag (1 = SLIM listener subscribed, else 0)
//   Float64[2] = recent event-loop delay / mean lag (ms)
//
// /ready is 200 iff the loop is healthy, and 503 (→ ECS recycles the task) in
// two cases:
//   • WEDGED  — freshness heartbeat older than staleMs (loop fully blocked/dead).
//   • ZOMBIE  — loop still ticking (freshness fresh) BUT its event-loop delay has
//               stayed above saturationLagMs continuously for saturationSustainedMs.
//               This is the case the old freshness-only check missed: a loop busy
//               enough to starve the management heartbeat (→ verifier marked
//               offline → NO_AVAILABLE_VERIFIER) yet not blocked long enough to go
//               stale, so it lingered offline-but-not-recycled. Recycling it
//               restores service automatically.
//
// A merely BUSY-but-yielding loop has low event-loop delay → stays healthy and
// is NOT culled. Single writer (main) / single reader (here); a torn read
// self-corrects on the next tick, so no Atomics.

import { createServer } from 'node:http';
import { workerData } from 'node:worker_threads';

const { port, sab, staleMs, saturationLagMs, saturationSustainedMs } =
  workerData;
const view = new Float64Array(sab);
const STALE_MS = typeof staleMs === 'number' ? staleMs : 45_000;
const SAT_LAG_MS = typeof saturationLagMs === 'number' ? saturationLagMs : 250;
const SAT_SUSTAINED_MS =
  typeof saturationSustainedMs === 'number' ? saturationSustainedMs : 45_000;

// Timestamp (epoch ms) the main loop FIRST became saturated in the current
// run of saturation; null when not saturated. Tracked continuously off-loop on
// a 1s interval so the verdict doesn't depend on ALB probe timing.
let saturatedSince = null;
// Zombie-transition logging state. The verdict otherwise only appears in
// /ready response bodies, which the ALB discards — without these lines there
// is NO log when the verifier goes zombie (or recovers). One line per
// transition, not per probe/tick.
let wasZombie = false;

setInterval(() => {
  const now = Date.now();
  const lagMs = view[2];
  if (Number.isFinite(lagMs) && lagMs > SAT_LAG_MS) {
    if (saturatedSince === null) saturatedSince = now;
  } else {
    saturatedSince = null;
  }
  const saturatedMs = saturatedSince === null ? 0 : now - saturatedSince;
  const zombie = saturatedMs >= SAT_SUSTAINED_MS;
  if (zombie !== wasZombie) {
    wasZombie = zombie;
    if (zombie) {
      console.log(
        `[verifier-liveness] ZOMBIE: main event loop saturated (mean lag ${Math.round(lagMs)}ms > ${SAT_LAG_MS}ms, sustained ${Math.round(saturatedMs)}ms >= ${SAT_SUSTAINED_MS}ms) — /ready now 503, ECS will recycle the task`,
      );
    } else {
      console.log(
        `[verifier-liveness] zombie cleared: main event loop recovered (mean lag ${Math.round(lagMs)}ms <= ${SAT_LAG_MS}ms) — /ready healthy again`,
      );
    }
  }
}, 1_000).unref();

const server = createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/ready' || path === '/health') {
    const now = Date.now();
    const hb = view[0];
    const slimReady = view[1] === 1;
    const lagMs = view[2];
    const ageMs = hb > 0 ? now - hb : Number.POSITIVE_INFINITY;
    const fresh = ageMs < STALE_MS;
    const saturatedMs = saturatedSince === null ? 0 : now - saturatedSince;
    const zombie = saturatedMs >= SAT_SUSTAINED_MS;
    const ok = fresh && slimReady && !zombie;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ready: ok,
        mainLoopFresh: fresh,
        slimReady,
        ageMs: Number.isFinite(ageMs) ? Math.round(ageMs) : null,
        lagMs: Number.isFinite(lagMs) ? Math.round(lagMs) : null,
        saturatedMs: Math.round(saturatedMs),
        zombie,
        source: 'liveness-worker',
      }),
    );
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.on('error', (err) => {
  // Bind failure etc. — surface to the parent's worker.on('error') and let
  // the process exit; a missing liveness responder fails the ALB check,
  // which is the correct (fail-safe) outcome.
  throw err;
});

server.listen(port, '0.0.0.0');
