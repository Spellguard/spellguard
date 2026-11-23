// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-identity verification cache (LLM gateway).
 *
 * Binds the otherwise-TRUSTED `X-Spellguard-Agent-Id` header to a real
 * credential: the companion `X-Spellguard-Agent-Secret` is verified against the
 * control plane's `POST /v1/internal/verify-agent` (bcrypt over
 * `agents.hashed_secret`) so a caller on the public verifier ALB cannot present
 * another agent's id to borrow its policies / spend limits. This reuses the exact
 * RPC the verifier already makes during attestation registration
 * (`app.ts` → `/v1/internal/verify-agent`).
 *
 * FAIL MODE — the OPPOSITE of the spend-gate / policy caches, on purpose. Those
 * fail OPEN (a management blip must not take the customer's agent down). Identity
 * binding FAILS CLOSED: an unreachable / erroring management call returns
 * `'unreachable'`, which the gateway DENIES in enforce mode — a management blip
 * must never become a spoofing window. Only a positive `{valid:true}` is cached
 * long; negatives are cached only briefly.
 *
 * ORACLE PROTECTION — `/v1/internal/verify-agent` is a credential brute-force
 * oracle (submit a secret, learn if it's valid). It is safe from EXTERNAL callers
 * because it sits behind `verifierAuth`, but the gateway itself is on a public
 * ALB, so a caller could try to turn the gateway into an unbounded bcrypt oracle
 * against one agent's secret. We bound that: (a) positive-cache valid pairs so a
 * legit agent re-bcrypts at most once per TTL, (b) briefly negative-cache invalid
 * pairs, and (c) rate-limit cache-MISSING verify RPCs per agentId.
 *
 * The secret is never stored raw as a cache key — the key is
 * `${agentId}:sha256(secret)`. We post `signRequest()`'s headers VERBATIM and do
 * NOT add our own content-type: signRequest already sets `Content-Type:
 * application/json`, and adding a lowercase `content-type` too would give the
 * object two keys of different casing, which undici comma-joins into
 * `application/json, application/json` on the wire — the worker then can't parse
 * the JSON body and it arrives EMPTY at the route's zod validation (that was the
 * usage-ingest 422, staging 2026-07-19). One content-type is fine; the duplicate
 * is the bug.
 */

import { signRequest } from './request-signer';

/** `'missing'` is a gateway-level verdict (no secret header); the cache returns the other three. */
export type IdentityVerdict = 'valid' | 'invalid' | 'unreachable' | 'missing';

// Read dynamically (not module-consts) so they're runtime-tunable without a
// rebuild and overridable per-test.
const positiveTtlMs = () =>
  Number(process.env.SPELLGUARD_LLM_IDENTITY_TTL_MS) || 60_000;
const negativeTtlMs = () =>
  Number(process.env.SPELLGUARD_LLM_IDENTITY_NEG_TTL_MS) || 10_000;
// Max cache-MISSING verify RPCs per agentId per window (bcrypt-oracle bound).
const missLimit = () =>
  Number(process.env.SPELLGUARD_LLM_IDENTITY_MISS_LIMIT) || 10;
const missWindowMs = () =>
  Number(process.env.SPELLGUARD_LLM_IDENTITY_MISS_WINDOW_MS) || 60_000;

interface CacheEntry {
  valid: boolean;
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>(); // key: `${agentId}:${sha256(secret)}`

interface MissBucket {
  count: number;
  resetAt: number;
}
const missBuckets = new Map<string, MissBucket>(); // key: agentId

const stats = {
  valid: 0,
  invalid: 0,
  unreachable: 0,
  missing: 0,
  rateLimited: 0,
};

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** True once this agentId has exceeded its cache-miss verify budget for the window. */
function overMissLimit(agentId: string): boolean {
  const now = Date.now();
  const bucket = missBuckets.get(agentId);
  if (!bucket || now >= bucket.resetAt) {
    missBuckets.set(agentId, { count: 1, resetAt: now + missWindowMs() });
    return false;
  }
  bucket.count += 1;
  return bucket.count > missLimit();
}

type CacheVerdict = 'valid' | 'invalid';

/** A live (non-expired) cached verdict for this key, or null. Bumps the stat. */
function cachedVerdict(key: string): CacheVerdict | null {
  const cached = cache.get(key);
  if (!cached) return null;
  const ttl = cached.valid ? positiveTtlMs() : negativeTtlMs();
  if (Date.now() - cached.fetchedAt >= ttl) return null;
  if (cached.valid) stats.valid += 1;
  else stats.invalid += 1;
  return cached.valid ? 'valid' : 'invalid';
}

/**
 * One signed verify RPC; caches + counts the result. FAILS CLOSED to
 * `'unreachable'` on any error.
 */
async function fetchVerdict(
  managementUrl: string,
  agentId: string,
  secret: string,
  key: string,
): Promise<Exclude<IdentityVerdict, 'missing'>> {
  try {
    const body = JSON.stringify({ agentId, agentSecret: secret });
    const url = `${managementUrl}/v1/internal/verify-agent`;
    const headers = await signRequest('POST', url, body); // headers verbatim — see module header
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`verify-agent HTTP ${res.status}`);
    const { valid } = (await res.json()) as { valid: boolean };
    cache.set(key, { valid, fetchedAt: Date.now() });
    if (valid) stats.valid += 1;
    else stats.invalid += 1;
    return valid ? 'valid' : 'invalid';
  } catch (err) {
    console.warn(
      `[VerifyAgentCache] verify failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    stats.unreachable += 1;
    return 'unreachable'; // FAIL CLOSED
  }
}

/**
 * Verify that `secret` authenticates `agentId`. FAILS CLOSED — returns
 * `'unreachable'` on any management error or when the per-agent miss budget is
 * exhausted, so the gateway denies in enforce mode. Returns `'unreachable'` (not
 * a pass) when `MANAGEMENT_URL` is unset — the gateway is expected to skip this
 * call entirely in unmanaged mode.
 */
export async function verifyAgentIdentity(
  agentId: string,
  secret: string,
): Promise<Exclude<IdentityVerdict, 'missing'>> {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!managementUrl) return 'unreachable';

  const key = `${agentId}:${await hashSecret(secret)}`;
  const hit = cachedVerdict(key);
  if (hit) return hit;

  // A cache miss costs a bcrypt on the control plane — rate-limit per agentId so
  // the gateway can't be turned into an unbounded oracle against one secret.
  if (overMissLimit(agentId)) {
    stats.rateLimited += 1;
    return 'unreachable'; // deny (fail-closed) without hitting the oracle
  }

  return fetchVerdict(managementUrl, agentId, secret, key);
}

/** Count a request that presented no `X-Spellguard-Agent-Secret` (observability). */
export function noteMissingSecret(): void {
  stats.missing += 1;
}

/** Read-only identity counters (surfaced via GET /internal/llm-usage-stats). */
export function getIdentityStats(): {
  valid: number;
  invalid: number;
  unreachable: number;
  missing: number;
  rateLimited: number;
} {
  return { ...stats };
}

/** Test helper. */
export function clearVerifyAgentCache(): void {
  cache.clear();
  missBuckets.clear();
}
