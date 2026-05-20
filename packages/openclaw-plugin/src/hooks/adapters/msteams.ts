// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft Teams block notice adapter.
 *
 * Posts block notices via Bot Framework Connector REST:
 *   POST {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}
 * The outbound Activity sets `replyToId = activityId` to thread the reply
 * under the offending message regardless of the user's OpenClaw
 * `replyStyle` preference.
 *
 * Credentials (appId / appPassword / tenantId) come from OpenClaw's
 * `channels.msteams` config.  The adapter exchanges them for a short-lived
 * AAD bearer token via the `client_credentials` grant and caches it in
 * memory (keyed on `${appId}:${tenantId}`) with a 60-second refresh buffer.
 * Concurrent callers coalesce via single-flight fetch.
 *
 * Bot Framework has no outbound reaction API, so addReaction is a no-op.
 */
import {
  type TeamsActivityContext,
  getTeamsActivityContext,
} from '../msteams-activity-stash';
import { isDuplicate } from './dispatcher';
import type { BlockNoticeAdapter } from './types';

interface CachedToken {
  token: string;
  expiresAt: number; // epoch seconds
}

interface TokenKey {
  appId: string;
  tenantId: string;
}

const REFRESH_BUFFER_SEC = 60;
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

function keyFor({ appId, tenantId }: TokenKey): string {
  return `${appId}:${tenantId}`;
}

async function acquireToken(
  creds: {
    appId: string;
    appPassword: string;
    tenantId: string;
  },
  forceRefresh = false,
): Promise<string> {
  const key = keyFor(creds);
  const now = Math.floor(Date.now() / 1000);

  if (!forceRefresh) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - REFRESH_BUFFER_SEC > now)
      return cached.token;
    const pending = inflight.get(key);
    if (pending) return pending;
  } else {
    tokenCache.delete(key);
  }

  // Build the inflight promise synchronously, register it BEFORE awaiting,
  // so concurrent callers see it and coalesce on the same fetch.
  const fetchPromise = (async () => {
    const res = await fetch(
      `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: creds.appId,
          client_secret: creds.appPassword,
          scope: 'https://api.botframework.com/.default',
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(
        `AAD token request failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };
    tokenCache.set(key, {
      token: body.access_token,
      expiresAt: now + body.expires_in,
    });
    return body.access_token;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, fetchPromise);
  return fetchPromise;
}

async function postActivity(
  token: string,
  ctx: TeamsActivityContext,
  text: string,
): Promise<Response> {
  const url = `${ctx.serviceUrl.replace(/\/$/, '')}/v3/conversations/${ctx.conversationId}/activities/${ctx.activityId}`;
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'message',
      from: ctx.from,
      conversation: { id: ctx.conversationId },
      recipient: ctx.recipient,
      text,
      replyToId: ctx.activityId,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

export const msteamsAdapter: BlockNoticeAdapter = {
  platform: 'msteams',

  async postBlockNotice(channel, threadRef, reason, creds) {
    if (!creds.appId || !creds.appPassword || !creds.tenantId) return;

    // Dedup check FIRST — before doing any stash lookup or token work —
    // so repeat blocks within the 60-second window are cheap no-ops.
    const dedupKey = this.buildDedupKey(channel, threadRef);
    if (isDuplicate(dedupKey)) return;

    const ctx = getTeamsActivityContext(channel);
    if (!ctx) {
      console.error(
        `[spellguard] msteams: no activity context for conversation ${channel}; cannot post block notice`,
      );
      return;
    }

    // The prefix is REQUIRED — the cross-bot loop guard in
    // inbound-observer.ts keys on it. Do not change the format.
    const text = `\u{1F6E1}\u{FE0F} ${reason || 'This message was blocked by a security policy.'}`;

    const tokenCreds = {
      appId: creds.appId,
      appPassword: creds.appPassword,
      tenantId: creds.tenantId,
    };

    try {
      let token = await acquireToken(tokenCreds);
      let res = await postActivity(token, ctx, text);

      if (res.status === 401) {
        token = await acquireToken(tokenCreds, true);
        res = await postActivity(token, ctx, text);
      }

      if (!res.ok) {
        console.error(
          `[spellguard] msteams: block notice failed (${res.status}): ${await res.text().catch(() => '')}`,
        );
      }
    } catch (err) {
      console.error('[spellguard] msteams: block notice error', err);
    }
  },

  async addReaction(_channel, _messageRef, _emoji, _creds) {
    // Bot Framework exposes no outbound reaction API.  Silent no-op.
  },

  resolveCredentials(openclawConfig, _accountId) {
    const msteams = (
      openclawConfig as Record<string, Record<string, unknown>> | undefined
    )?.channels?.msteams as Record<string, unknown> | undefined;

    const appId = msteams?.appId;
    const appPassword = msteams?.appPassword;
    const tenantId = msteams?.tenantId;

    if (
      typeof appId === 'string' &&
      typeof appPassword === 'string' &&
      typeof tenantId === 'string' &&
      appId &&
      appPassword &&
      tenantId
    ) {
      return { appId, appPassword, tenantId };
    }
    return null;
  },

  extractChannelId(conversationId) {
    if (!conversationId) return undefined;
    // Teams conversation IDs start with `19:...@thread.tacv2` and contain
    // colons, so we only strip a leading `channel:` prefix — NOT a generic
    // prefix-up-to-first-colon like the Discord adapter uses.
    return conversationId.startsWith('channel:')
      ? conversationId.slice('channel:'.length)
      : conversationId;
  },

  buildDedupKey(channel, messageRef) {
    return `${channel}:${messageRef ?? ''}`;
  },
};

/** Visible for tests. */
export function _resetTokenCacheForTest(): void {
  tokenCache.clear();
  inflight.clear();
}
