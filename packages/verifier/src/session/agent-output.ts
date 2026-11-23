// SPDX-License-Identifier: Apache-2.0

/**
 * What an agent sends, in one shape whatever the leg
 * (internal design notes). Each leg that observes an
 * output builds one and hands it to the policy evaluation; the
 * `agent-conduct` engine reads only this, never a leg's own shape.
 *
 *   leg                        kind / channel        target
 *   /v1/tools/check (input)    tool / sdk-tool        the tool name
 *   /messages/send (sender)    message / a2a          the recipient agent id
 *   the recipient's reply      message / reply        the original sender
 *   /messages/unilateral       message / a2a-external the A2A URL's host
 *
 * The tool leg's output phase is a source (`tool:output`), not an output.
 * Plugin tool calls, shell commands and channel messages
 * (`/v1/mcp/evaluate`) build none yet.
 */

import type { AgentConductChannel } from '@spellguard/amp';
import type { ResolvedPolicyBinding } from '../proxy/policy-evaluator-types';
import { ledgerMessage } from './attachments';

export interface AgentOutput {
  kind: 'tool' | 'message' | 'command';
  /** Tool name, recipient agent id, or external host. */
  target: string;
  /**
   * The transport, for matching. The legs build sdk-tool, a2a, reply and
   * a2a-external today; the rest are the design's plugin transports.
   */
  channel: AgentConductChannel;
  /** A tool call's parameters, when they are an object. */
  params?: Record<string, unknown>;
  /** The content as text: a message's payload, or the parameters as JSON. */
  text: string;
  /** Where it was observed, for the audit row. */
  leg: string;
}

/** The policy type that reads an output. */
export const AGENT_CONDUCT_POLICY_TYPE = 'agent-conduct';

/**
 * Whether a leg's bindings include one that judges outputs. A leg builds its
 * output only then, so an agent without the policy pays nothing for it.
 */
export function judgesOutputs(
  bindings: readonly Pick<ResolvedPolicyBinding, 'policyType'>[],
): boolean {
  return bindings.some((b) => b.policyType === AGENT_CONDUCT_POLICY_TYPE);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A tool call through the SDK, at its input phase. */
export function toolCallOutput(toolName: string, params: unknown): AgentOutput {
  const object = asObject(params);
  return {
    kind: 'tool',
    target: toolName,
    channel: 'sdk-tool',
    ...(object ? { params: object } : {}),
    text: JSON.stringify(params ?? {}) ?? '{}',
    leg: '/v1/tools/check',
  };
}

/**
 * A message to another Spellguard agent. The text is the payload as the
 * recipient's ledger keeps it: the Verifier's own `_spellguard*` stamps and
 * attachment data left out, an attachment kept as its name and type.
 */
export function a2aMessageOutput(
  recipient: string,
  decryptedContent: string | null,
): AgentOutput {
  return {
    kind: 'message',
    target: recipient,
    channel: 'a2a',
    text: ledgerMessage(decryptedContent).text,
    leg: '/messages/send',
  };
}

/**
 * What the agent wrote in a reply. The SDK wraps an agent's `{ response }`
 * in its own envelope (`{ success, response: { response } }`), so the
 * `response` field is followed down, a few levels at most, to the text.
 */
function writtenReply(reply: unknown): unknown {
  let value = reply;
  for (let depth = 0; depth < 3; depth++) {
    const object = asObject(value);
    if (!object || !('response' in object)) break;
    value = object.response;
  }
  return value;
}

/** The recipient's reply to the message it was sent: what the agent wrote. */
export function replyOutput(
  originalSender: string,
  reply: unknown,
): AgentOutput {
  const written = writtenReply(reply);
  return {
    kind: 'message',
    target: originalSender,
    channel: 'reply',
    text:
      typeof written === 'string'
        ? ledgerMessage(written).text
        : ledgerMessage(JSON.stringify(written) ?? '').text,
    leg: 'reply',
  };
}

/** The host of an A2A URL, or the URL as given when it does not parse. */
export function a2aHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** A message to an outside A2A agent. */
export function externalMessageOutput(
  a2aAgentUrl: string,
  payload: unknown,
): AgentOutput {
  return {
    kind: 'message',
    target: a2aHost(a2aAgentUrl),
    channel: 'a2a-external',
    text: ledgerMessage(
      typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? ''),
    ).text,
    leg: '/messages/unilateral',
  };
}
