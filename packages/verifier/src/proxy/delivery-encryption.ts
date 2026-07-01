// SPDX-License-Identifier: Apache-2.0
//
// Gateway-opaque delivery encryption (option a).
//
// When a recipient agent has registered an X25519 public key, the Verifier
// encrypts the delivered payload TO that key so the gateway (a decrypting SLIM
// endpoint) only ever forwards an opaque `encryptedMessage` it cannot read —
// app-layer end-to-end to the agent. When the recipient has NO registered key
// (a legacy client), we fall back to plaintext `message` exactly as before, so
// old and new agents interoperate. The choice is per-recipient and decided
// here, the single place both the SLIM and HTTP delivery paths build their body.
//
// Wire compatibility: `encryptPayload` here and the agent client's
// `decryptFromVerifier` (@spellguard/amp) are the SAME X25519 + AES-256-GCM
// scheme (HKDF info `spellguard-amp-v1`, wire `0x01 || ephPub(32) || nonce(12)
// || ct || tag(16)`), so the agent decrypts what the Verifier encrypts.

import { decryptPayload, encryptPayload } from '../crypto/encrypt';

export interface AgentDeliveryBody {
  /** Legacy plaintext payload (recipient registered no public key). */
  message?: unknown;
  /** Gateway-opaque ciphertext for the recipient's X25519 key (base64). */
  encryptedMessage?: string;
  senderId: string;
  messageId: string;
  timestamp: number;
}

/**
 * Build the `/_spellguard/receive` body, encrypting to the recipient's key when
 * it has one (gateway-opaque) and otherwise sending plaintext (legacy mode).
 */
export function buildAgentDeliveryBody(
  payload: unknown,
  secureMessage: { id: string; sender: string; timestamp: number },
  recipientPublicKey?: string,
): AgentDeliveryBody {
  const base = {
    senderId: secureMessage.sender,
    messageId: secureMessage.id,
    timestamp: secureMessage.timestamp,
  };
  if (recipientPublicKey) {
    return {
      ...base,
      encryptedMessage: encryptPayload(
        JSON.stringify(payload),
        recipientPublicKey,
      ),
    };
  }
  return { ...base, message: payload };
}

/**
 * Return leg, step 1: a recipient agent encrypts its reply TO the Verifier
 * (with the Verifier's session key). Decrypt it here so the response policies +
 * audit see plaintext, reconstructing the `{ success, response }` envelope the
 * pipeline expects. A legacy plaintext reply (no `encryptedResponse`) passes
 * through unchanged.
 */
export function decryptRecipientReply(reply: unknown): unknown {
  if (
    reply &&
    typeof reply === 'object' &&
    typeof (reply as Record<string, unknown>).encryptedResponse === 'string'
  ) {
    const { encryptedResponse, ...rest } = reply as Record<string, unknown>;
    try {
      return {
        ...rest,
        response: JSON.parse(decryptPayload(encryptedResponse as string)),
      };
    } catch (err) {
      console.error(
        `[delivery-encryption] failed to decrypt recipient reply: ${err}`,
      );
    }
  }
  return reply;
}

/**
 * Return leg, step 2: re-encrypt the final response TO the requester's key
 * (gateway-opaque) when the requester registered one; otherwise return it
 * plaintext (legacy). The requester's client decrypts `encryptedResponse`.
 */
export function encryptResponseForRequester(
  finalResponse: unknown,
  requesterPublicKey?: string,
): unknown {
  if (!requesterPublicKey) return finalResponse;
  return {
    encryptedResponse: encryptPayload(
      JSON.stringify(finalResponse),
      requesterPublicKey,
    ),
  };
}
