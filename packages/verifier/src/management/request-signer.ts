// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier Request Signer
 *
 * Signs every outgoing request to the management server with the Verifier's
 * `@spellguard/ctls` session key: the key it registers, that management
 * challenges and attests (#1259), and that management verifies these
 * signatures against (#1344). The signature binds the method, the path and
 * query, and the body, so it authorises exactly one request.
 *
 * There is deliberately no unsigned fallback: management refuses unsigned
 * Verifier requests in every deployed environment, and a request made before
 * the session keys exist is a bug to surface, not to paper over.
 */

import {
  VERIFIER_REQUEST_SIGNATURE_HEADER,
  getSessionPublicKey,
  signVerifierRequest,
  signWithSessionKey,
} from '@spellguard/ctls';

/**
 * Build authenticated headers for a Verifier → management request.
 *
 * @param method - The HTTP method the request is sent with
 * @param url - The full URL the request is sent to
 * @param body - The serialized request body (or "" when there is none)
 */
export async function signRequest(
  method: string,
  url: string,
  body: string,
): Promise<Record<string, string>> {
  const verifierId = process.env.VERIFIER_ID || 'verifier-local-dev';
  if (!getSessionPublicKey()) {
    throw new Error(
      'Verifier session keys are not initialised; refusing to send an unsigned management request',
    );
  }
  const target = new URL(url);
  const signature = await signVerifierRequest({
    verifierId,
    method,
    path: `${target.pathname}${target.search}`,
    body,
    sign: signWithSessionKey,
  });
  return {
    'Content-Type': 'application/json',
    'X-Verifier-Id': verifierId,
    [VERIFIER_REQUEST_SIGNATURE_HEADER]: signature,
  };
}

/** Header carrying the shared registration secret on self-attested registration (#1142). */
export const VERIFIER_REGISTRATION_SECRET_HEADER =
  'X-Spellguard-Verifier-Registration-Secret';

/**
 * Headers for `POST /v1/internal/verifiers/register`: the signed headers
 * (which prove possession of the key the body registers) plus, when
 * configured, the shared `VERIFIER_REGISTRATION_SECRET`. Management refuses a
 * self-attested registration without it outside local (#1142).
 */
export async function signRegistrationRequest(
  url: string,
  body: string,
  registrationSecret: string | undefined,
): Promise<Record<string, string>> {
  const headers = await signRequest('POST', url, body);
  if (registrationSecret) {
    headers[VERIFIER_REGISTRATION_SECRET_HEADER] = registrationSecret;
  }
  return headers;
}
