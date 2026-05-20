// SPDX-License-Identifier: Apache-2.0

/**
 * Slack block notice adapter.
 *
 * Extracted from block-notice.ts and inbound-observer.ts — same logic,
 * now behind the BlockNoticeAdapter interface.
 */
import { isDuplicate } from './dispatcher';
import type { BlockNoticeAdapter } from './types';

/** Resolve the Slack bot token for the given OpenClaw account. */
function resolveSlackBotToken(
  openclawConfig: Record<string, unknown> | undefined,
  accountId: string | undefined,
): string | undefined {
  const slack = (
    openclawConfig as Record<string, Record<string, unknown>> | undefined
  )?.channels?.slack as Record<string, unknown> | undefined;

  // Try multi-account config FIRST when accountId is available
  const accounts = slack?.accounts as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (accounts && accountId) {
    const acct = accounts[accountId];
    if (acct?.botToken && typeof acct.botToken === 'string') {
      return acct.botToken;
    }
  }

  // Fall back to top-level token
  if (slack?.botToken && typeof slack.botToken === 'string') {
    return slack.botToken;
  }

  // Convention-based env var: socket-a -> SOCKET_A_BOT_TOKEN
  if (accountId) {
    const envKey = `${accountId.toUpperCase().replace(/-/g, '_')}_BOT_TOKEN`;
    if (process.env[envKey]) return process.env[envKey];
  }

  // Wildcard fallback
  if (process.env.HTTP_BOT_TOKEN) return process.env.HTTP_BOT_TOKEN;

  return undefined;
}

export const slackAdapter: BlockNoticeAdapter = {
  platform: 'slack',

  async postBlockNotice(channel, threadRef, reason, creds) {
    if (!creds.botToken) return;

    const dedupKey = this.buildDedupKey(channel, threadRef);
    if (isDuplicate(dedupKey)) return;

    const text = `:shield: ${reason || 'This message was blocked by a security policy.'}`;
    const headers = {
      Authorization: `Bearer ${creds.botToken}`,
      'Content-Type': 'application/json',
    };

    // Post the notice only. Reactions are added by `handleBlock` via
    // `adapter.addReaction` to avoid double-calling reactions.add per
    // blocked message (Slack returns `already_reacted` on the second call).
    try {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          channel,
          text,
          ...(threadRef ? { thread_ts: threadRef } : {}),
        }),
      });
      if (!resp.ok) {
        console.error(
          '[spellguard] Slack chat.postMessage non-2xx:',
          resp.status,
          resp.statusText,
        );
        return;
      }
      const body = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (body && body.ok === false) {
        console.error(
          '[spellguard] Slack chat.postMessage rejected:',
          body.error,
        );
      }
    } catch (err) {
      console.error('[spellguard] Slack: Failed to post block notice:', err);
    }
  },

  async addReaction(channel, messageRef, emoji, creds) {
    if (!creds.botToken || !messageRef) return;

    const headers = {
      Authorization: `Bearer ${creds.botToken}`,
      'Content-Type': 'application/json',
    };

    try {
      const resp = await fetch('https://slack.com/api/reactions.add', {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel, timestamp: messageRef, name: emoji }),
      });
      if (!resp.ok) {
        console.error(
          '[spellguard] Slack reactions.add non-2xx:',
          resp.status,
          resp.statusText,
        );
        return;
      }
      const body = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (body && body.ok === false && body.error !== 'already_reacted') {
        console.error('[spellguard] Slack reactions.add rejected:', body.error);
      }
    } catch (err) {
      console.error('[spellguard] Slack: Failed to add reaction:', err);
    }
  },

  resolveCredentials(openclawConfig, accountId) {
    const token = resolveSlackBotToken(openclawConfig, accountId);
    if (!token) return null;
    return { botToken: token };
  },

  extractChannelId(conversationId) {
    if (!conversationId) return undefined;
    const idx = conversationId.indexOf(':');
    return idx >= 0 ? conversationId.slice(idx + 1) : conversationId;
  },

  buildDedupKey(channel, messageRef) {
    return `${channel}:${messageRef ?? ''}`;
  },
};
