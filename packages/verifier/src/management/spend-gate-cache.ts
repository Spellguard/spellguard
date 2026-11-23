// SPDX-License-Identifier: Apache-2.0

/**
 * Spend-gate cache.
 *
 * Before forwarding a model call, the LLM gateway asks the Management Server
 * whether the agent is over a HARD-ENFORCED dollar budget. Cached with a short
 * TTL (usage is hourly-bucket-granular and the cron evaluator only re-checks
 * every ~5 min, so a few seconds of staleness loses no real precision) to keep
 * the management hop off the per-call hot path — bounding the Tier-0
 * availability coupling (design §9).
 *
 * FAIL MODE: on an unreachable / erroring management call we FAIL OPEN — serving
 * the last cached verdict if present, else `{ over: false }` — so a management
 * blip cannot take the customer's whole agent down at the gate. The OpenRouter
 * native cap (via cap-sync) remains the backstop for dollar budgets.
 */

import { signRequest } from './request-signer';

export interface SpendGateVerdict {
  over: boolean;
  window?: 'hour' | 'day' | 'week' | 'month';
  limitUsd?: number;
  usageUsd?: number;
}

interface CacheEntry {
  verdict: SpendGateVerdict;
  fetchedAt: number;
}

const CACHE_TTL_MS =
  Number(process.env.SPELLGUARD_LLM_SPEND_GATE_TTL_MS) || 15_000;
const cache = new Map<string, CacheEntry>();

/**
 * Spend-gate verdict for an agent, or `null` when enforcement is disabled
 * (`MANAGEMENT_URL` unset — local/OSS). Serves a cached verdict within the TTL;
 * on a management error returns the last cached verdict, else `{ over: false }`
 * (fail-open — see module header).
 */
export async function getSpendGate(
  agentId: string,
): Promise<SpendGateVerdict | null> {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!managementUrl) return null;

  const cached = cache.get(agentId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.verdict;
  }

  try {
    const url = `${managementUrl}/v1/internal/agents/${encodeURIComponent(agentId)}/spend-gate`;
    const headers = await signRequest('GET', url, '');
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`spend-gate HTTP ${res.status}`);
    const verdict = (await res.json()) as SpendGateVerdict;
    cache.set(agentId, { verdict, fetchedAt: Date.now() });
    return verdict;
  } catch (err) {
    console.warn(
      `[SpendGateCache] fetch failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return cached?.verdict ?? { over: false };
  }
}

/** Test/observability helper. */
export function clearSpendGateCache(): void {
  cache.clear();
}
