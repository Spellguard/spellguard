// SPDX-License-Identifier: Apache-2.0

/**
 * Discord block notice adapter.
 *
 * Posts block notices via the Discord REST API:
 *   - POST /channels/{id}/messages with message_reference for reply threading
 *   - PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me for reactions
 *
 * Discord uses snowflake IDs (e.g., "123456789012345678") as message references,
 * unlike Slack's timestamp format ("1234567890.123456").
 */
import { isDuplicate } from './dispatcher';
import type { BlockNoticeAdapter } from './types';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export const discordAdapter: BlockNoticeAdapter = {
  platform: 'discord',

  async postBlockNotice(channel, threadRef, reason, creds) {
    if (!creds.botToken) return;

    const dedupKey = this.buildDedupKey(channel, threadRef);
    if (isDuplicate(dedupKey)) return;

    const text = `\u{1F6E1}\u{FE0F} ${reason || 'This message was blocked by a security policy.'}`;

    await fetch(`${DISCORD_API_BASE}/channels/${channel}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${creds.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: text,
        ...(threadRef ? { message_reference: { message_id: threadRef } } : {}),
      }),
    }).catch((err) => {
      console.error('[spellguard] Discord: Failed to post block notice:', err);
    });
  },

  async addReaction(channel, messageRef, emoji, creds) {
    if (!creds.botToken || !messageRef) return;

    const encodedEmoji = encodeURIComponent(emoji);

    await fetch(
      `${DISCORD_API_BASE}/channels/${channel}/messages/${messageRef}/reactions/${encodedEmoji}/@me`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${creds.botToken}`,
          'Content-Type': 'application/json',
        },
      },
    ).catch((err) => {
      console.error('[spellguard] Discord: Failed to add reaction:', err);
    });
  },

  resolveCredentials(openclawConfig, _accountId) {
    const discord = (
      openclawConfig as Record<string, Record<string, unknown>> | undefined
    )?.channels?.discord as Record<string, unknown> | undefined;

    // OpenClaw exposes Discord config with "token" field, but the wizard
    // generates config with "botToken". Accept both for compatibility.
    // OpenClaw interpolates `${DISCORD_BOT_A_TOKEN}` / `${DISCORD_BOT_B_TOKEN}`
    // into the config at startup — env vars do not need a second adapter-level
    // fallback path.
    const token = (discord?.botToken ?? discord?.token) as string | undefined;
    if (token && typeof token === 'string') {
      return { botToken: token };
    }

    return null;
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
