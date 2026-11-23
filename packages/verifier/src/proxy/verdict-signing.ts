// SPDX-License-Identifier: Apache-2.0
//
// Signed verdicts (#1259).
//
// Management acts on a policy verdict only when this Verifier signed it with
// the session key management attested. When a request to `/v1/mcp/evaluate`
// or `/admin/evaluate` carries `X-Spellguard-Verdict-Nonce`, the answer, error
// or not, carries `X-Spellguard-Verdict-Signature` over the exact body bytes.
// A middleware rather than per-return code, so no branch of either handler can
// answer unsigned.

import {
  VERDICT_NONCE_HEADER,
  VERDICT_SIGNATURE_HEADER,
  isVerdictNonce,
  signVerdict,
  signWithSessionKey,
} from '@spellguard/ctls';
import type { MiddlewareHandler } from 'hono';

/** The id this Verifier registers with management under. */
function verifierId(): string {
  return process.env.VERIFIER_ID || 'verifier-local-dev';
}

export const signVerdictResponses: MiddlewareHandler = async (c, next) => {
  await next();
  const nonce = c.req.header(VERDICT_NONCE_HEADER);
  if (!isVerdictNonce(nonce)) return;
  const body = await c.res.clone().text();
  let signature: string;
  try {
    signature = await signVerdict({
      verifierId: verifierId(),
      nonce: nonce as string,
      body,
      sign: signWithSessionKey,
    });
  } catch (error) {
    // Without session keys the verdict goes out unsigned, and management
    // treats it as unverified (fail closed on its side).
    console.error(`[Verifier] Could not sign verdict: ${error}`);
    return;
  }
  const headers = new Headers(c.res.headers);
  headers.set(VERDICT_SIGNATURE_HEADER, signature);
  c.res = new Response(body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};
