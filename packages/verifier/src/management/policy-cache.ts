// SPDX-License-Identifier: Apache-2.0

/**
 * Policy Cache
 *
 * Fetches and caches resolved policies from the Management Server.
 * Verifier calls this before routing messages to get the agent's configured policies.
 *
 * A background poller periodically re-fetches policies for all cached agents,
 * so midstream policy changes on the management server are picked up within
 * the poll interval (default 30s) rather than waiting for the 5-minute TTL.
 */

import type { ResolvedPolicyConfig } from '../proxy/policy-evaluator-types';
import { getLocalAgentPolicies } from './local-policies';
import { signRequest } from './request-signer';

interface CacheEntry {
  config: ResolvedPolicyConfig;
  fetchedAt: number;
  version: string;
  /** Combined key for change detection (includes visibility state). */
  changeKey: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 30_000; // 30 seconds

const cache = new Map<string, CacheEntry>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

// ── Internal helpers ─────────────────────────────────────────────────

/** Build a change-detection key that covers both policy and visibility state.
 *  The management server already bakes visibility into the combined version hash,
 *  so the version alone is sufficient for change detection. */
function buildChangeKey(config: ResolvedPolicyConfig): string {
  return config.version;
}

function getPollIntervalMs(): number {
  const env = process.env.POLICY_CHECK_INTERVAL_MS;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_POLL_INTERVAL_MS;
}

async function fetchPolicies(
  agentId: string,
): Promise<ResolvedPolicyConfig | null> {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  const verifierId = process.env.VERIFIER_ID || 'verifier-local-dev';

  if (!managementUrl) {
    return null;
  }

  // GET request — sign with empty body
  const headers = await signRequest('');

  const response = await fetch(
    `${managementUrl}/v1/internal/agents/${encodeURIComponent(agentId)}/policies`,
    {
      headers,
      signal: AbortSignal.timeout(5000),
    },
  );

  if (!response.ok) {
    console.warn(
      `[PolicyCache] Failed to fetch policies for ${agentId}: ${response.status}`,
    );
    return null;
  }

  return (await response.json()) as ResolvedPolicyConfig;
}

async function pollAllAgents(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const agentIds = [...cache.keys()];
    for (const agentId of agentIds) {
      try {
        const config = await fetchPolicies(agentId);
        if (!config) continue;

        const newKey = buildChangeKey(config);
        const existing = cache.get(agentId);
        if (existing && existing.changeKey !== newKey) {
          console.log(
            `[PolicyCache] Policy version changed for ${agentId}: ${existing.version} → ${config.version}`,
          );
        }

        cache.set(agentId, {
          config,
          fetchedAt: Date.now(),
          version: config.version,
          changeKey: newKey,
        });
      } catch {
        // Fail-open: silently keep stale cache for this agent
      }
    }
  } finally {
    polling = false;
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start the background policy poller.
 * Called lazily on the first successful fetch. Safe to call multiple times.
 */
export function startPolicyPoller(): void {
  if (pollTimer) return;
  const intervalMs = getPollIntervalMs();
  pollTimer = setInterval(pollAllAgents, intervalMs);
  // Don't keep the process alive just for the poller
  if (typeof pollTimer === 'object' && 'unref' in pollTimer) {
    pollTimer.unref();
  }
}

/**
 * Stop the background policy poller.
 */
export function stopPolicyPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Get resolved policies for an agent from the management server.
 *
 * Returns cached result if within TTL. Falls back to null if management
 * server is unreachable (no enforcement rather than blocking).
 */
export async function getAgentPolicies(
  agentId: string,
): Promise<ResolvedPolicyConfig | null> {
  // Management is authoritative when configured. Local bindings are the
  // OSS fallback used only when MANAGEMENT_URL isn't set.
  if (!process.env.MANAGEMENT_URL) {
    return getLocalAgentPolicies(agentId);
  }

  // Check cache
  const cached = cache.get(agentId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.config;
  }

  try {
    const config = await fetchPolicies(agentId);
    if (!config) return null;

    // Log version transition on TTL-expired re-fetches
    const newKey = buildChangeKey(config);
    if (cached && cached.changeKey !== newKey) {
      console.log(
        `[PolicyCache] Policy version changed for ${agentId}: ${cached.version} → ${config.version}`,
      );
    }

    cache.set(agentId, {
      config,
      fetchedAt: Date.now(),
      version: config.version,
      changeKey: newKey,
    });

    // Ensure the background poller is running
    startPolicyPoller();

    return config;
  } catch (error) {
    console.warn(
      `[PolicyCache] Could not reach management server for ${agentId}: ${error}`,
    );
    return null;
  }
}

/**
 * Invalidate cached policies for an agent.
 */
export function invalidateAgentPolicies(agentId: string): void {
  cache.delete(agentId);
}

/**
 * Clear all cached policies and stop the background poller.
 */
export function clearPolicyCache(): void {
  cache.clear();
  stopPolicyPoller();
}
