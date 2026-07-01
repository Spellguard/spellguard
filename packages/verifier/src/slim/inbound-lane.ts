// SPDX-License-Identifier: Apache-2.0

/**
 * Lane classification for inbound HTTP-over-SLIM frames.
 *
 * The verifier's inbound concurrency gate is split in two (endpoint.ts):
 * long-running message deliveries (`/messages/*` — each awaits the
 * recipient agent's full LLM turn, ~110s worst case) take the `msg` gate,
 * everything else (register, attestation, tools/check, discovery, health)
 * takes the `ctl` gate. Without the split, ≤6 parked deliveries starved
 * control-plane calls past the gateway's 25s ctl budget — and
 * checkToolPolicy then failed OPEN client-side.
 *
 * Classification needs the request path, which only becomes visible after
 * decoding the wire envelope — so we decode BEFORE gating. That means the
 * envelope is JSON.parse'd twice (again by the server's handler), which is
 * acceptable: it's a small JSON object and decode cost is microseconds,
 * whereas classifying after gate admission would defeat the split (the
 * frame would already be parked in the wrong queue).
 */

import { decodeRequest } from '@spellguard/gateway/wire';

export type InboundLane = 'ctl' | 'msg';

export function classifyInboundLane(payload: Uint8Array): InboundLane {
  try {
    const path = decodeRequest(payload).path.split('?')[0];
    // /messages/send + /messages/unilateral (and any future message
    // route) await the recipient's full turn — the only long-running
    // inbound class.
    return path.startsWith('/messages/') ? 'msg' : 'ctl';
  } catch {
    // Undecodable frame: the handler rejects it within milliseconds, so it
    // can't park a ctl slot for long — and it must not consume one of the
    // scarce msg slots reserved for real deliveries.
    return 'ctl';
  }
}
