// SPDX-License-Identifier: Apache-2.0

/**
 * Async-scoped trace context: hop counter + correlation id.
 *
 * Both pieces of state propagate together as one logical "message
 * context".  The Verifier stamps both on inbound forwards
 * (`_spellguardHops` for the hop counter, `_spellguardCorrelationId`
 * for the trace id); the receive handler extracts both and re-
 * establishes the context here, so any nested outbound
 * `channel.send` call automatically:
 *
 *   - includes `_spellguardHops` so the Verifier can enforce
 *     `MAX_MESSAGE_HOPS` and prevent infinite routing loops; and
 *
 *   - includes `_spellguardCorrelationId` so every audit_logs row
 *     produced by the same logical conversation shares the same
 *     `correlation_id` — this is what makes the dashboard's "View
 *     Related Messages" group multi-hop scenarios as one session
 *     rather than rendering each (sender, recipient) pair as its
 *     own 2-party diagram.
 *
 * Top-level callers without an inbound to inherit from (e.g. the
 * cron scenarios in the managed demo fleet, or any /chat endpoint
 * that wants to start a trace) wrap their work in
 * `runWithHops(0, fn)`.  At entry the function auto-generates a
 * fresh correlation id when none was passed, so a context started
 * at hop 0 is never untraced.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface TraceContext {
  hops: number;
  correlationId: string;
  /**
   * The immediate inbound sender's agent id, when this context was
   * established by the receive handler. Used to exclude back-routing to the
   * sender (2-node cycle prevention — see getCurrentSenderId). Undefined for
   * hop-0 top-level sends and /chat (no inbound to inherit from).
   */
  senderId?: string;
}

const contextStore = new AsyncLocalStorage<TraceContext>();

/**
 * Return the hop count from the current async context, or 0 if none
 * is set (e.g. the request originated from a `/chat` endpoint that
 * didn't wrap in `runWithHops`).
 */
export function getCurrentHops(): number {
  return contextStore.getStore()?.hops ?? 0;
}

/**
 * Return the correlation id from the current async context, or
 * `undefined` if no context is set.  When undefined, downstream
 * code (channel.send / the Verifier) falls back to the legacy
 * channel.id-as-correlation_id semantic.
 */
export function getCurrentCorrelationId(): string | undefined {
  return contextStore.getStore()?.correlationId;
}

/**
 * Return the immediate inbound sender's agent id from the current async
 * context, or `undefined` when there's no inbound (a hop-0 top-level scenario
 * send, or a /chat call). The routing layer (resolveAndCollectAgentResponses)
 * excludes this id from auto-route targets so a receiver never routes BACK to
 * whoever just messaged it — that would be a 2-node cycle (A→B→A). This keeps
 * the agent-communication graph a DAG; deeper cycles are backstopped by the
 * Verifier's MAX_MESSAGE_HOPS.
 */
export function getCurrentSenderId(): string | undefined {
  return contextStore.getStore()?.senderId;
}

/**
 * Run `fn` with the given hop count and (optionally) correlation id
 * set in the async context.  All nested async operations — including
 * `generateText` → `sendToAgent` → `channel.send` — see both via
 * `getCurrentHops()` / `getCurrentCorrelationId()`.
 *
 * Behavior:
 *   - If `correlationId` is provided (typically by the receive
 *     handler propagating the inbound stamp), it's used verbatim.
 *   - If `correlationId` is omitted, a fresh id is minted via
 *     `crypto.randomUUID()`.  This makes hop-0 callers automatically
 *     traced without any extra ceremony — wrap in
 *     `runWithHops(0, fn)` and every send inside shares one id.
 *   - `senderId` (optional) is the immediate inbound sender; the receive
 *     handler passes it so nested routing can exclude back-routing to the
 *     sender (2-node cycle prevention via getCurrentSenderId). Omit it for
 *     top-level (hop-0) callers that have no inbound sender.
 */
export function runWithHops<T>(
  hops: number,
  fn: () => T,
  correlationId?: string,
  senderId?: string,
): T {
  const ctx: TraceContext = {
    hops,
    correlationId: correlationId ?? generateCorrelationId(),
    senderId,
  };
  return contextStore.run(ctx, fn);
}

function generateCorrelationId(): string {
  // crypto.randomUUID is available in Node 19+ and CF Workers globals.
  return crypto.randomUUID();
}
