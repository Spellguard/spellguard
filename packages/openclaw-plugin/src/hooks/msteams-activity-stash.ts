// SPDX-License-Identifier: Apache-2.0

/**
 * Per-conversation inbound-Activity context for Teams block-notice replies.
 *
 * Bot Framework requires the outbound reply to include serviceUrl, from,
 * recipient, and conversationId copied from the inbound activity.  The
 * BlockNoticeAdapter interface does not carry these fields; we stash them
 * here, keyed on conversationId, with a 5-minute TTL.
 *
 * Populated by:
 *   - packages/openclaw-plugin/src/hooks/inbound-observer.ts on before_dispatch
 *   - packages/openclaw-plugin/src/services/platform-relay-client.ts on
 *     receipt of teams_activity_blocked envelope
 *
 * Consumed by:
 *   - packages/openclaw-plugin/src/hooks/adapters/msteams.ts
 *     when building the outbound reply Activity.
 */

export interface TeamsActivityContext {
  serviceUrl: string;
  activityId: string;
  from: { id?: string; name?: string };
  recipient: { id?: string; name?: string };
  conversationId: string;
}

const TTL_MS = 5 * 60 * 1000;

const stash = new Map<
  string,
  { ctx: TeamsActivityContext; timer: ReturnType<typeof setTimeout> }
>();

export function stashTeamsActivityContext(
  conversationId: string,
  ctx: TeamsActivityContext,
): void {
  const existing = stash.get(conversationId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => stash.delete(conversationId), TTL_MS);
  stash.set(conversationId, { ctx, timer });
}

export function getTeamsActivityContext(
  conversationId: string,
): TeamsActivityContext | undefined {
  return stash.get(conversationId)?.ctx;
}

/** Visible for tests. */
export function _clearTeamsActivityStashForTest(): void {
  for (const { timer } of stash.values()) clearTimeout(timer);
  stash.clear();
}
