// SPDX-License-Identifier: Apache-2.0
//
// Signed deliveries (#1244).
//
// Every delivery the Verifier makes to an agent's `/_spellguard/receive`, over
// HTTP or through the gateway over SLIM, carries a v1 signature by the
// Verifier's session key: the key the agent pinned from its attested
// registration (#1259). The agent refuses a delivery its Verifier did not
// sign, so reaching an agent's URL no longer bypasses the Verifier's policy,
// sender identity or audit.
//
// The signature covers the exact body bytes the recipient receives, so the
// caller serializes the body once and sends that same string.

import {
  getSessionPublicKey,
  signDelivery,
  signWithSessionKey,
} from '@spellguard/ctls';

/**
 * The headers that authenticate one delivery to `recipientAgentId`. Throws if
 * the session keys are not initialised: an unsigned delivery would be refused
 * by every enforcing agent, and the Verifier must never send one.
 */
export async function signedDeliveryHeaders(
  recipientAgentId: string,
  channelToken: string,
  body: string,
): Promise<Record<string, string>> {
  const publicKeyHex = getSessionPublicKey();
  if (!publicKeyHex) {
    throw new Error(
      'Session keys not initialized: refusing to send an unsigned delivery',
    );
  }
  return signDelivery({
    recipientAgentId,
    channelToken,
    body,
    publicKeyHex,
    sign: signWithSessionKey,
  });
}
