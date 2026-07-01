// SPDX-License-Identifier: Apache-2.0

/**
 * Always-on SLIM delivery to recipient agents in the slim profile.
 *
 * In `slim` profile EVERY recipient is delivered verifier→gateway→agent over
 * SLIM — managed and no-Management modes converge on the same data-plane path.
 * The recipient stays a plain HTTP agent; the gateway (subscribed to the
 * recipient's slimName) proxies the SLIM message to the agent's
 * `/_spellguard/receive` callback and publishes the reply back. So the verifier
 * only needs two things for a recipient to be SLIM-deliverable:
 *
 *   1. a stable 3-component slimName (the gateway's `doSubscribe` requires
 *      exactly 3 parts), and
 *   2. the gateway subscribed to that slimName and holding its callback URL
 *      (pushed over the SLIM control channel — `push-registry.ts`).
 *
 * No-Management agents get this at registration (they all self-register eagerly
 * via `createSpellguard`). Managed pure-recipients (e.g. the demo fleet's
 * `newsletter-editor`) never self-register, so the router registers them with
 * the gateway lazily at resolve time. Both go through `ensureGatewayRegistered`
 * here, which is idempotent + cached so the push happens once per recipient.
 */

import { pushControlMessage } from './push-registry';

/**
 * The canonical 3-component slimName for an agent — `<org>/<group>/<agentId>`.
 * org/group come from env (single-tenant `default/default` by default). The
 * value only has to be (a) unique per agent and (b) IDENTICAL on the verifier's
 * delivery side and the gateway's subscription side; agentId guarantees (a) and
 * deriving it here in one place guarantees (b).
 */
export function deriveAgentSlimName(agentId: string): string {
  const org = process.env.SPELLGUARD_DEFAULT_ORG_SLIM_PREFIX ?? 'default';
  const group = process.env.SPELLGUARD_DEFAULT_GROUP_SLIM ?? 'default';
  return `${org}/${group}/${agentId}`;
}

// agentId → callbackUrl we last successfully registered with the gateway, so a
// re-resolve of the same recipient skips the push. A changed callback re-pushes.
const registered = new Map<string, string>();
// In-flight pushes, so concurrent first-deliveries to the same recipient share
// one push instead of racing duplicate registers.
const inflight = new Map<string, Promise<string | null>>();

/**
 * Ensure the gateway is subscribed to the agent's slimName and knows its
 * callback URL, so a SLIM send to that slimName reaches the agent. Idempotent
 * and cached. Returns the slimName on success, or `null` if the push failed
 * (caller falls back / surfaces the failure).
 */
export async function ensureGatewayRegistered(
  agentId: string,
  callbackBaseUrl: string,
): Promise<string | null> {
  const slimName = deriveAgentSlimName(agentId);
  if (registered.get(agentId) === callbackBaseUrl) return slimName;
  const existing = inflight.get(agentId);
  if (existing) return existing;
  const push = (async () => {
    const out = await pushControlMessage({
      type: 'register',
      agentId,
      slimName,
      callbackUrl: callbackBaseUrl,
    });
    inflight.delete(agentId);
    if (out.ok) {
      registered.set(agentId, callbackBaseUrl);
      return slimName;
    }
    console.warn(
      `[ManagedSlim] gateway registry push failed for ${agentId}: ${out.error}`,
    );
    return null;
  })();
  inflight.set(agentId, push);
  return push;
}

/**
 * Forget a cached registration so the next `ensureGatewayRegistered` re-pushes.
 * Used by the delivery retry: a `session-failed` SLIM send means the gateway
 * wasn't subscribed (subscription still propagating, or the gateway restarted
 * and lost its in-memory registry), so we re-register before retrying.
 */
export function invalidateGatewayRegistration(agentId: string): void {
  registered.delete(agentId);
}

export function _resetForTesting(): void {
  registered.clear();
  inflight.clear();
}
