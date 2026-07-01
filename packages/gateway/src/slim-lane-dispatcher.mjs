// SPDX-License-Identifier: Apache-2.0
//
// Per-lane outbound dispatcher for the gateway SLIM worker (issue #8 fix).
//
// The gateway funnels EVERY agent's outbound slim call through one worker to
// one verifier: fast control-plane (attestation / register / resolve /
// tools-check) AND the LLM-bearing /messages/send that can park ~110s waiting
// for the recipient to reply. The slim Session has no request-id correlation —
// getMessage() returns the NEXT message on the session — so two requests in
// flight on a single session would cross replies. The original worker therefore
// used ONE cached session + a SYNC getMessage, which both serialized everything
// AND parked the worker JS thread for the whole reply budget. While a 120s
// /messages/send was parked, every other agent's fast control-plane send
// 502'd at the gateway before reaching the verifier — the head-of-line block
// that made the data-custodian demo turns time out (their in-turn
// checkToolPolicy could never get through).
//
// This dispatcher splits sends into independent LANES (e.g. 'ctl' vs 'msg').
// Each lane is backed by its OWN cached session and processed SERIALLY (FIFO)
// so reply correlation is preserved within a lane, but the waits are async
// (the worker uses getMessageAsync) so the thread is never parked and the lanes
// run concurrently with each other. A long 'msg' send no longer blocks a 'ctl'
// send — which is the whole point.
//
// This module is pure (no slim-bindings, no worker globals) so it is unit
// tested directly; the worker injects `laneFor` and the async `handle`.

/**
 * @param {object} opts
 * @param {(input: any) => string} opts.laneFor   Map a send to its lane id.
 * @param {(input: any, lane: string) => Promise<void>} opts.handle  Perform one send.
 */
export function createLaneDispatcher({ laneFor, handle }) {
  // tail[lane] = a promise that settles when the lane is next free. New work
  // chains onto it so a lane runs one send at a time (FIFO), independent of
  // the other lanes.
  const tail = new Map();

  function dispatch(input) {
    const lane = laneFor(input);
    const prev = tail.get(lane) || Promise.resolve();
    // Run after the previous send on this lane settles — resolved OR rejected
    // — so a single failed send never stalls the rest of the lane.
    const next = prev.then(
      () => handle(input, lane),
      () => handle(input, lane),
    );
    // Store a rejection-swallowed view as the new tail: keeps the chain alive
    // and prevents unhandledRejection. Real error handling lives in `handle`
    // (it posts a send-result back to the host).
    tail.set(
      lane,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  /** Lanes that have been used at least once (diagnostics/tests). */
  function _lanes() {
    return Array.from(tail.keys());
  }

  return { dispatch, _lanes };
}
