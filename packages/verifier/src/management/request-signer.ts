// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier Request Signer
 *
 * Signs outgoing requests to the management server using the Verifier's
 * ephemeral Ed25519 session key. Management verifies these signatures
 * against the public key the Verifier registered during boot.
 *
 * In mock mode (VERIFIER_MOCK_MODE=true), signatures are still generated
 * but management skips attestation verification during registration.
 */

import { getSessionPublicKey, signWithSessionKey } from '../crypto/ephemeral';

/**
 * Build authenticated headers for a Verifier → management request.
 *
 * Signs the payload `timestamp|body` with the Verifier's Ed25519 session key.
 * For GET requests with no body, pass an empty string.
 *
 * @param body - The serialized request body (or "" for GET requests)
 * @returns Headers with Verifier ID, signature, timestamp, and public key
 */
export async function signRequest(
  body: string,
): Promise<Record<string, string>> {
  const verifierId = process.env.VERIFIER_ID || 'verifier-local-dev';
  const timestamp = Date.now().toString();
  const publicKey = getSessionPublicKey();

  // If session keys aren't initialized yet (e.g. unit tests, pre-boot),
  // fall back to unsigned headers so callers don't crash. Management will
  // still accept the request if it's in mock/legacy mode.
  if (!publicKey) {
    return {
      'Content-Type': 'application/json',
      'X-Verifier-Id': verifierId,
    };
  }

  // Sign: timestamp|body
  const dataToSign = `${timestamp}|${body}`;
  const dataBytes = new TextEncoder().encode(dataToSign);
  const signature = await signWithSessionKey(dataBytes);

  return {
    'Content-Type': 'application/json',
    'X-Verifier-Id': verifierId,
    'X-Verifier-Signature': signature,
    'X-Verifier-Timestamp': timestamp,
    'X-Verifier-Public-Key': publicKey,
  };
}
