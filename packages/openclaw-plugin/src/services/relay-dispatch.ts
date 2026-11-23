// SPDX-License-Identifier: Apache-2.0

/**
 * Shared relay dispatch — forwards inbound Slack/Teams relay events to the
 * plugin's local bot surface (Bolt / OpenClaw msteams endpoint) and posts block
 * notices.
 *
 * Consolidated agent socket: relay frames arrive on the agent-control socket and
 * `credentials/credential-service.ts` wires `AgentControlClient.onRelayEvent`
 * into `dispatchRelayEnvelope` here. (Originally extracted from the standalone
 * relay client that opened its own WebSocket; that separate transport was
 * removed once the relay family was folded onto the single agent-control socket.)
 *
 * The forwarders are a PURE MOVE — no behavior change. `postBlockNotice`'s
 * per-instance dedup `recentBlocks` set lives inside the factory so each
 * dispatcher keeps its own dedup window, exactly as the relay client did.
 */

import { createHmac } from 'node:crypto';
import { getAdapter } from '../hooks/adapters/dispatcher';
import { stashTeamsActivityContext } from '../hooks/msteams-activity-stash';

/** Non-secret identity used only for observability log lines. */
export interface RelayDispatchConfig {
  agentId: string;
}

/**
 * Platform-forward parameters. Slack fields drive `forwardToBolt` /
 * `postBlockNotice`; Teams fields drive `forwardToTeamsEndpoint` /
 * `postTeamsBlockNotice`. A single dispatcher can carry BOTH (the consolidated
 * agent socket multiplexes Slack + Teams relay frames onto one connection).
 */
export interface RelayForwardOptions {
  slackSigningSecret?: string;
  slackBotToken?: string;
  gatewayPort?: number;
  teamsPort?: number;
  teamsPath?: string;
  openclawConfig?: Record<string, unknown>;
}

export interface RelayDispatcher {
  dispatchRelayEnvelope(data: {
    type?: string;
    payload?: unknown;
    channel?: string;
    threadTs?: string;
    reason?: string;
    authorization?: string;
  }): Promise<void>;
  forwardToBolt(payload: unknown): Promise<void>;
  postBlockNotice(
    channel: string,
    threadTs?: string,
    reason?: string,
  ): Promise<void>;
  forwardToTeamsEndpoint(
    payload: unknown,
    authorization?: string,
  ): Promise<void>;
  postTeamsBlockNotice(envelope: {
    conversationId?: string;
    activityId?: string;
    serviceUrl?: string;
    from?: { id?: string; name?: string };
    recipient?: { id?: string; name?: string };
    reason?: string;
  }): Promise<void>;
}

export function createRelayDispatcher(
  config: RelayDispatchConfig,
  options?: RelayForwardOptions,
): RelayDispatcher {
  const localBoltUrl = `http://localhost:${options?.gatewayPort ?? 4000}/slack/events`;
  const teamsEndpoint = `http://localhost:${options?.teamsPort ?? 3978}${options?.teamsPath ?? '/api/messages'}`;
  // Dedup: Slack delivers multiple event types (app_mention + message) for
  // the same message.  Track recently blocked message timestamps so we only
  // post one block notice per original message.
  const recentBlocks = new Set<string>();

  /** Post a block notice directly to Slack (no LLM, no hooks). */
  async function postBlockNotice(
    channel: string,
    threadTs?: string,
    reason?: string,
  ): Promise<void> {
    const token = options?.slackBotToken;
    if (!token) return;

    // Dedup: Slack sends multiple event types for the same message.
    const dedupKey = `${channel}:${threadTs ?? ''}`;
    if (recentBlocks.has(dedupKey)) return;
    recentBlocks.add(dedupKey);
    setTimeout(() => recentBlocks.delete(dedupKey), 60_000);

    const text = `:shield: ${reason || 'This message was blocked by a security policy.'}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // Post the block notice as a thread reply and add a reaction to the
    // original message so it's visible from the main channel view.
    await Promise.all([
      fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      }),
      threadTs
        ? fetch('https://slack.com/api/reactions.add', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              channel,
              timestamp: threadTs,
              name: 'no_entry_sign',
            }),
          })
        : Promise.resolve(),
    ]).catch((err) => {
      console.error('[spellguard] Failed to post block notice:', err);
    });
  }

  /** Forward an allowed Slack event to the local Bolt server with re-signed headers. */
  async function forwardToBolt(payload: unknown): Promise<void> {
    const body =
      typeof payload === 'string' ? payload : JSON.stringify(payload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options?.slackSigningSecret) {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = `v0=${createHmac('sha256', options.slackSigningSecret).update(`v0:${ts}:${body}`).digest('hex')}`;
      headers['X-Slack-Request-Timestamp'] = ts;
      headers['X-Slack-Signature'] = sig;
    }

    // Fail-loud, like forwardToTeamsEndpoint above. This hop was previously a
    // bare `await fetch` with no .ok check, no try/catch, and no log — so a
    // refused port (gateway not on the expected port) or a Bolt rejection
    // vanished silently: the inbound mention reached the bot but produced no
    // reply and no trace anywhere. Bolt ACKs 200 BEFORE it dispatches, so a 200
    // here only proves the receiver accepted the frame, not that a reply went
    // out — but a non-200 or a throw is a definitive, grep-able failure signal.
    console.log(
      `[spellguard-relay] forward->slack url=${localBoltUrl} bodyLen=${body.length} hasSig=${!!options?.slackSigningSecret} agentId=${config.agentId}`,
    );
    try {
      const resp = await fetch(localBoltUrl, { method: 'POST', headers, body });
      const respText =
        typeof resp.text === 'function'
          ? await resp.text().catch(() => '<no-body>')
          : '';
      console.log(
        `[spellguard-relay] forward->slack status=${resp.status} respLen=${respText.length} agentId=${config.agentId}`,
      );
      if (!resp.ok) {
        console.error(
          `[spellguard-relay] forward->slack NON-OK status=${resp.status} body=${respText.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.error(
        '[spellguard-relay] forward->slack fetch threw (gateway not listening on the configured port?):',
        err,
      );
    }
  }

  /**
   * Forward an allowed Teams activity to the local OpenClaw Teams messaging
   * endpoint, and seed the msteams activity stash with outbound-oriented
   * context so a later block (e.g. the plugin's own `before_dispatch`
   * catching something the relay Verifier allowed) can post a threaded
   * reply without needing to rehydrate Activity metadata from OpenClaw.
   *
   * Outbound orientation: the inbound `recipient` (the bot) becomes the
   * outbound `from`; the inbound `from` (the user) becomes the outbound
   * `recipient`.  This is what Bot Framework expects when replying.
   */
  async function forwardToTeamsEndpoint(
    payload: unknown,
    authorization?: string,
  ): Promise<void> {
    const body =
      typeof payload === 'string' ? payload : JSON.stringify(payload);

    // Seed the stash.  Best-effort — swallow parse errors.
    try {
      const activity = (
        typeof payload === 'string' ? JSON.parse(payload) : payload
      ) as {
        id?: string;
        conversation?: { id?: string };
        serviceUrl?: string;
        from?: { id?: string; name?: string };
        recipient?: { id?: string; name?: string };
      };
      const conversationId = activity.conversation?.id;
      if (conversationId && activity.id && activity.serviceUrl) {
        stashTeamsActivityContext(conversationId, {
          serviceUrl: activity.serviceUrl,
          activityId: activity.id,
          from: activity.recipient ?? {},
          recipient: activity.from ?? {},
          conversationId,
        });
      }
    } catch {
      // Malformed activity — OpenClaw will reject it downstream.
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authorization) {
      // Pass through the original Bot Framework JWT so OpenClaw's msteams
      // extension can verify it as if the request came from Azure directly.
      headers.Authorization = `Bearer ${authorization.replace(/^Bearer\s+/i, '')}`;
    }

    console.log(
      `[spellguard-relay] forward->msteams url=${teamsEndpoint} bodyLen=${body.length} hasAuth=${!!authorization} agentId=${config.agentId}`,
    );
    try {
      const resp = await fetch(teamsEndpoint, {
        method: 'POST',
        headers,
        body,
      });
      const respText = await resp.text().catch(() => '<no-body>');
      console.log(
        `[spellguard-relay] forward->msteams status=${resp.status} respLen=${respText.length} respPreview=${respText.slice(0, 200)}`,
      );
    } catch (err) {
      console.error('[spellguard-relay] forward->msteams fetch threw:', err);
    }
  }

  /**
   * Post a Teams block notice via the msteams BlockNoticeAdapter.
   *
   * The envelope carries full inbound activity context (serviceUrl, from,
   * recipient, conversationId, activityId) so the adapter can build a
   * threaded reply without needing a prior stash.
   */
  async function postTeamsBlockNotice(envelope: {
    conversationId?: string;
    activityId?: string;
    serviceUrl?: string;
    from?: { id?: string; name?: string };
    recipient?: { id?: string; name?: string };
    reason?: string;
  }): Promise<void> {
    const adapter = getAdapter('msteams');
    if (!adapter) return;
    if (!envelope.conversationId || !envelope.activityId) return;

    // Seed the stash so postBlockNotice (which uses extractChannelId → stash)
    // has the outbound-reply context it needs.
    stashTeamsActivityContext(envelope.conversationId, {
      serviceUrl: envelope.serviceUrl ?? '',
      activityId: envelope.activityId,
      from: envelope.recipient ?? {}, // our outbound "from" is their inbound "recipient"
      recipient: envelope.from ?? {},
      conversationId: envelope.conversationId,
    });

    const creds = adapter.resolveCredentials(
      options?.openclawConfig,
      undefined,
    );
    if (!creds) {
      console.error(
        '[spellguard] msteams: no credentials; cannot post block notice',
      );
      return;
    }
    const channel = adapter.extractChannelId(envelope.conversationId);
    if (!channel) return;

    console.log(
      `[spellguard-relay] postTeamsBlockNotice channel=${channel} activityId=${envelope.activityId} reason=${envelope.reason} agentId=${config.agentId}`,
    );
    try {
      await adapter.postBlockNotice(
        channel,
        envelope.activityId,
        `Blocked by Spellguard policy: ${envelope.reason ?? 'Policy violation'}`,
        creds,
      );
      console.log('[spellguard-relay] postTeamsBlockNotice sent');
    } catch (err) {
      console.error('[spellguard-relay] postTeamsBlockNotice threw:', err);
    }
  }

  async function dispatchRelayEnvelope(data: {
    type?: string;
    payload?: unknown;
    channel?: string;
    threadTs?: string;
    reason?: string;
    authorization?: string;
  }): Promise<void> {
    if (data.type === 'slack_event' && data.payload) {
      await forwardToBolt(data.payload);
    } else if (data.type === 'slack_event_blocked') {
      await postBlockNotice(data.channel ?? '', data.threadTs, data.reason);
    } else if (data.type === 'teams_activity' && data.payload) {
      await forwardToTeamsEndpoint(data.payload, data.authorization);
    } else if (data.type === 'teams_activity_blocked') {
      await postTeamsBlockNotice(data);
    } else {
      // Pass the value as an argument, never inside the format string
      // (CodeQL js/tainted-format-string).
      console.log('[spellguard-relay] onmessage ignored', { type: data.type });
    }
  }

  return {
    dispatchRelayEnvelope,
    forwardToBolt,
    postBlockNotice,
    forwardToTeamsEndpoint,
    postTeamsBlockNotice,
  };
}
