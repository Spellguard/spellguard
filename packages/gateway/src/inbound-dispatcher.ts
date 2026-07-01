// SPDX-License-Identifier: Apache-2.0

/**
 * Inbound dispatch — when the SLIM data plane delivers a message for an
 * agent that's registered with this gateway, POST the message envelope to
 * the agent's callback URL and surface the HTTP response back as the
 * SRPC reply.
 *
 * The HTTP shape mirrors what `/_spellguard/receive` already accepts in
 * `@spellguard/client`, so receiving agents need zero code changes — the
 * gateway bridges SLIM → HTTP transparently.
 */

import { lookupBySlimName } from './agent-registry';
import type { GatewaySecureMessage } from './protocol';

export interface InboundContext {
  /** The slimName this message was addressed to. */
  recipientSlimName: string;
  /** The original sender's slimName (for audit / hops context). */
  senderSlimName: string;
  /** The SecureMessage envelope. */
  message: GatewaySecureMessage;
  /** Stable channel token for the SRPC turn — passed as
   *  `X-Spellguard-Channel-Token` on the POST so the recipient's
   *  middleware applies the same auth contract it does for HTTP. */
  channelToken: string;
}

export interface InboundResult {
  ok: boolean;
  /** Decrypted response payload from the agent's onMessage (JSON-parsed). */
  response?: unknown;
  /** Error string when the dispatch failed. */
  error?: string;
}

/**
 * Look up the recipient's registration, POST the message to its
 * callbackUrl, and return the JSON-parsed response body.
 *
 * Returns an error result when:
 * - No registration exists for the recipient slimName (gateway got an
 *   inbound for an agent it doesn't know about — likely a SLIM routing
 *   bug or unregistered subscriber)
 * - The HTTP POST fails (network, non-2xx, JSON parse failure)
 *
 * Best-effort: a 5xx from the agent surfaces as an error string; the
 * gateway reports it back to the SLIM sender so they see a structured
 * failure rather than a hang.
 */
export async function dispatchInbound(
  ctx: InboundContext,
): Promise<InboundResult> {
  const reg = lookupBySlimName(ctx.recipientSlimName);
  if (!reg) {
    return {
      ok: false,
      error: `No registered agent for slimName=${ctx.recipientSlimName}`,
    };
  }
  try {
    const response = await fetch(reg.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Spellguard-Channel-Token': ctx.channelToken,
        // Tells the agent that this delivery came from the gateway (vs the
        // direct Verifier HTTP path); useful for diagnostic logs.
        'X-Spellguard-Delivery': 'gateway',
      },
      body: JSON.stringify({
        message: tryParse(ctx.message.encryptedPayload),
        senderId: ctx.message.sender,
        messageId: ctx.message.id,
        timestamp: ctx.message.timestamp,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Agent ${reg.agentId} returned HTTP ${response.status}: ${detail || response.statusText}`,
      };
    }
    const body = (await response.json()) as {
      success?: boolean;
      response?: unknown;
      error?: string;
    };
    if (body.success === false) {
      return { ok: false, error: body.error ?? 'agent reported failure' };
    }
    return { ok: true, response: body.response };
  } catch (err) {
    return {
      ok: false,
      error: `Inbound dispatch to ${reg.callbackUrl} failed: ${(err as Error).message}`,
    };
  }
}

function tryParse(raw: string): unknown {
  try {
    // The Verifier-side SlimTransport.send() base64-encodes the decrypted
    // payload before placing it in the SecureMessage envelope. Reverse
    // that here so the agent sees the plain object its onMessage expects.
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return raw;
  }
}
