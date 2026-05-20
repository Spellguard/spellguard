// SPDX-License-Identifier: Apache-2.0

import { getAdapter } from './adapters/dispatcher';
import { evaluateContent } from './evaluate';
import type { HookConfig } from './types';

/**
 * TODO: Restore once upstream OpenClaw merges blocking support for
 * `message_received`. This hook runs earlier in the pipeline (before
 * internal hooks) but currently cannot cancel messages on stock OpenClaw.
 *
 *   PR: https://github.com/openclaw/openclaw/pull/53343
 *   Branch: nickfujita/openclaw#feat/message-received-blocking-opt-in
 *
 * export function createInboundGuard(config: HookConfig) {
 *   return async (event: {
 *     content?: string;
 *     from?: string;
 *     metadata?: Record<string, unknown>;
 *   }) => {
 *     const content = event.content;
 *     if (!content) return {};
 *
 *     const result = await evaluateContent(config, content, 'inbound', {
 *       channel:
 *         typeof event.metadata?.provider === 'string'
 *           ? event.metadata.provider
 *           : undefined,
 *     });
 *
 *     if (result.result === 'block') {
 *       return { cancel: true };
 *     }
 *
 *     return {};
 *   };
 * }
 */

// ── messageId stash ────────────────────────────────────────────────────────
//
// Upstream OpenClaw's `before_dispatch` event does not include `messageId`
// (the Slack message `ts`), but `message_received` exposes it in
// `event.metadata.messageId`. Since `message_received` fires (and its
// handler body executes synchronously within the runVoidHook .map() call)
// before `before_dispatch`, we stash the value here and look it up later.
//
// Key: `${accountId}:${conversationId}:${timestamp}` — unique per message.
// Entries auto-expire after 30 seconds to prevent leaks.

const messageIdStash = new Map<string, string>();

/** Stash size visible for tests. */
export function getMessageIdStashSize(): number {
  return messageIdStash.size;
}

// ── platform stash ─────────────────────────────────────────────────────────
//
// Stashes the platform identifier for a given session so the tool guard
// (before_tool_call) can resolve the platform when posting block notices.
//
// Key: `${accountId}:${conversationId}` — unique per session.
// Entries auto-expire after 5 minutes to prevent leaks.

const platformStash = new Map<string, string>();
const platformTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Stash the platform identifier for a session.
 * Called by before_dispatch so before_tool_call can read it later.
 *
 * Per-session timers are tracked and cleared on overwrite so a refresh at
 * T+Δ never lets an older T+0 timer delete the newly-stashed value.
 */
export function stashPlatform(sessionKey: string, platform: string): void {
  platformStash.set(sessionKey, platform);
  const prev = platformTimers.get(sessionKey);
  if (prev) clearTimeout(prev);
  const handle = setTimeout(() => {
    platformStash.delete(sessionKey);
    platformTimers.delete(sessionKey);
  }, 300_000);
  platformTimers.set(sessionKey, handle);
}

/**
 * Retrieve the platform identifier for a session.
 * Returns undefined if the session is not found or has expired.
 */
export function getPlatformForSession(sessionKey: string): string | undefined {
  return platformStash.get(sessionKey);
}

/**
 * Observer hook for `message_received` that captures messageId from
 * event metadata and stashes it for the downstream `before_dispatch` guard.
 *
 * Runs as a fire-and-forget observer on stock upstream OpenClaw. The handler
 * body is synchronous so the stash write completes within the runVoidHook
 * .map() call — before `before_dispatch` fires.
 */
export function createMessageIdObserver() {
  return (
    event: {
      content: string;
      timestamp?: number;
      metadata?: Record<string, unknown>;
    },
    ctx?: {
      channelId?: string;
      accountId?: string;
      conversationId?: string;
    },
  ) => {
    const messageId = event.metadata?.messageId;
    if (typeof messageId !== 'string' || !messageId) return;

    const key = buildStashKey(
      ctx?.accountId,
      ctx?.conversationId,
      event.timestamp,
    );
    if (!key) return;

    messageIdStash.set(key, messageId);
    setTimeout(() => messageIdStash.delete(key), 30_000);
  };
}

function buildStashKey(
  accountId?: string,
  conversationId?: string,
  timestamp?: number,
): string | undefined {
  if (!accountId || !conversationId || timestamp == null) return undefined;
  // Normalize conversationId: message_received provides "channel:C0ABC"
  // while before_dispatch provides "C0ABC". Strip the prefix so both match.
  const parts = conversationId.split(':');
  const normalizedConvId = conversationId.includes(':')
    ? (parts[parts.length - 1] ?? conversationId)
    : conversationId;
  return `${accountId}:${normalizedConvId}:${timestamp}`;
}

/**
 * Inbound message guard for the `before_dispatch` hook.
 *
 * Evaluates incoming messages against Spellguard policies via the Verifier.
 * When a violation is detected the guard:
 *   1. Posts a threaded block notice (:shield: prefix) in the platform channel
 *   2. Adds a platform reaction to the original message
 *   3. Returns `{ handled: true }` to suppress LLM dispatch
 *
 * This mirrors the block-notice behavior of the HTTP Events pipeline
 * (management → relay → postBlockNotice) so both Socket Mode and HTTP
 * Events bots produce identical user-facing feedback.
 *
 * The messageId (Slack message `ts`) is resolved from the stash populated
 * by the `message_received` observer, or from `event.messageId` if the
 * upstream fork is installed. This allows full threaded-reply + reaction
 * functionality on stock OpenClaw without any fork dependency.
 *
 * This replaces the `message_received` guard above while we wait for
 * upstream blocking support on that hook.
 *
 * Uses the adapter pattern — platform-specific behavior is delegated to
 * registered BlockNoticeAdapter implementations via the dispatcher.
 */
export function createBeforeDispatchGuard(
  config: HookConfig,
  options?: {
    /** OpenClaw config object for resolving platform credentials. */
    openclawConfig?: Record<string, unknown>;
  },
) {
  return async (
    event: {
      content: string;
      body?: string;
      channel?: string;
      sessionKey?: string;
      senderId?: string;
      isGroup?: boolean;
      timestamp?: number;
      messageId?: string;
    },
    ctx?: {
      channelId?: string;
      accountId?: string;
      conversationId?: string;
      sessionKey?: string;
      senderId?: string;
    },
  ) => {
    const content = event.content;
    if (!content) return {};

    // Suppress Spellguard block notices from other bots in the same channel
    // to prevent cross-bot reply loops (Bot A blocks → posts notice → Bot B
    // sees it → blocks → posts notice → Bot A sees it → ...).
    //
    // Slack renders `:shield:` as a shortcode in message.text, while Discord
    // renders it as a literal 🛡️ character. Match both so multi-bot setups
    // on either platform can't re-trigger each other.
    const SLACK_NOTICE_PREFIX = ':shield: Blocked by Spellguard policy:';
    const UNICODE_NOTICE_PREFIX =
      '\u{1F6E1}\u{FE0F} Blocked by Spellguard policy:';
    if (
      content.startsWith(SLACK_NOTICE_PREFIX) ||
      content.startsWith(UNICODE_NOTICE_PREFIX)
    ) {
      return { handled: true };
    }

    // Stash platform for tool guard
    const platform = event.channel;
    if (platform && ctx?.accountId && ctx?.conversationId) {
      stashPlatform(`${ctx.accountId}:${ctx.conversationId}`, platform);
    }

    const result = await evaluateContent(config, content, 'inbound', {
      channel: event.channel,
    });

    if (result.result !== 'block') return {};

    return handleBlock(result, event, ctx, platform, options?.openclawConfig);
  };
}

/** Handle a block result: post a notice via the appropriate adapter and return handled. */
async function handleBlock(
  result: { result: string; detections: Array<{ detail?: string }> },
  event: { timestamp?: number; messageId?: string },
  ctx?: { accountId?: string; conversationId?: string },
  platform?: string,
  openclawConfig?: Record<string, unknown>,
): Promise<{ handled: true; text?: string }> {
  const reason =
    result.detections[0]?.detail ||
    'This message was blocked by a security policy.';

  // Resolve messageId: prefer event.messageId (available when our fork
  // is installed), fall back to the stash populated by message_received.
  const stashKey = buildStashKey(
    ctx?.accountId,
    ctx?.conversationId,
    event.timestamp,
  );
  const messageTs =
    event.messageId ?? (stashKey ? messageIdStash.get(stashKey) : undefined);

  // Clean up the consumed stash entry.
  if (stashKey) messageIdStash.delete(stashKey);

  // Dispatch to platform adapter
  const adapter = platform ? getAdapter(platform) : undefined;
  if (adapter) {
    const channel = adapter.extractChannelId(ctx?.conversationId);
    const creds = adapter.resolveCredentials(openclawConfig, ctx?.accountId);
    if (creds && channel) {
      await adapter.postBlockNotice(
        channel,
        messageTs,
        `Blocked by Spellguard policy: ${reason}`,
        creds,
      );
      // Use platform-appropriate emoji: Slack uses text names, Discord uses Unicode
      const emoji = platform === 'slack' ? 'no_entry_sign' : '\u{1F6AB}';
      await adapter.addReaction(channel, messageTs, emoji, creds);
      return { handled: true };
    }
  }

  // Fallback: no adapter, no token, or no channel — let OpenClaw reply with plain text.
  return {
    handled: true,
    text: ':shield: Message blocked by Spellguard policy',
  };
}
