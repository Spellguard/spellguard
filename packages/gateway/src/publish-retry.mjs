// SPDX-License-Identifier: Apache-2.0
//
// Publish-phase retry-once policy for the gateway SLIM worker
// (slim-worker.mjs). Pure orchestration — no bindings imports — so it can
// be unit-tested off the worker thread (tests/gateway-publish-retry.test.ts),
// mirroring wedge-detector.mjs.
//
// Why this exists: the verifier's self-heal (PR #330) ECS-recycles its task
// when the upstream SLIM session leak saturates its event loop. Each recycle
// silently invalidates the gateway's cached outbound sessions, and the
// gateway only discovers a dead session by failing a real send with
// "Session already closed or dropped" — one sacrificed request per cached
// session (1 ctl + the msg-pool slots). A publishAndWait throw means the
// message provably NEVER LEFT the gateway, so replacing the session and
// re-publishing exactly once is safe (no double-delivery risk) and absorbs
// that recycle tax instead of surfacing it as one-shot 502s.
//
// Hard guarantees (history-aware — see slim-worker.mjs):
//   - Publish phase ONLY. Callers never retry the reply wait
//     (getMessageAsync): once a publish succeeded the message may have been
//     delivered, and re-publishing could double-deliver.
//   - Exactly ONE retry. A second publish failure (or a replaceSession
//     failure) propagates so the caller applies the standard failure path
//     (postSendErr + recordFailure).
//   - Wedge accounting: a first-publish failure that the retry recovers
//     never reaches the caller's catch, so it cannot advance the wedge
//     counters toward a recycle — by construction, not by convention. We
//     chose "don't recordFailure" over "recordFailure + noteSuccess"
//     because recordFailure returns its exit verdict synchronously
//     (recording the recoverable failure could trip the recycle before the
//     retry even runs) and noteSuccess would also drain an unrelated older
//     failure from the detector's decay window.
//
// Session lifecycle stays with the caller: replaceSession must route every
// teardown/create through slim-worker.mjs's withSessionCreateLock (the
// upstream session_moderator race panics on concurrent lifecycle ops).

/**
 * Attempt `publish(session)`; on a throw, obtain a fresh session via
 * `replaceSession(firstErr)` and retry the publish exactly once.
 *
 * @param {object} opts
 * @param {unknown} opts.session current (possibly dead-cached) session
 * @param {(session: unknown) => void | Promise<void>} opts.publish
 * @param {(firstErr: unknown) => Promise<unknown> | unknown} opts.replaceSession
 *   tear down the dead session and build a fresh one (serialized by the
 *   caller through withSessionCreateLock); only called after a first failure
 * @param {(firstErr: unknown) => void} [opts.onRecovered] observability hook,
 *   fired only when the retry publish succeeded
 * @returns {Promise<{ session: unknown, recovered: boolean }>} the session
 *   the publish succeeded on (fresh one when recovered)
 */
export async function publishWithSessionRetry({
  session,
  publish,
  replaceSession,
  onRecovered,
}) {
  try {
    await publish(session);
    return { session, recovered: false };
  } catch (firstErr) {
    const fresh = await replaceSession(firstErr);
    await publish(fresh);
    onRecovered?.(firstErr);
    return { session: fresh, recovered: true };
  }
}
