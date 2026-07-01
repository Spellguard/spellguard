// SPDX-License-Identifier: Apache-2.0

import { getAgent } from '@spellguard/ctls';
import { signRequest } from '../management/request-signer';
import type { AgentCard } from '../types';

/**
 * Cache for resolved agent cards.
 * TTL: 5 minutes
 */
const agentCardCache = new Map<
  string,
  { card: AgentCard; fetchedAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve an agent name or URL to its Agent Card using A2A discovery.
 * Fetches from /.well-known/agent.json at the agent's URL.
 */
export async function resolveAgentCard(
  agentNameOrUrl: string,
): Promise<AgentCard | null> {
  // Check cache first
  const cached = agentCardCache.get(agentNameOrUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.card;
  }

  // Determine the URL to fetch from
  let agentCardUrl: string | null;

  if (
    agentNameOrUrl.startsWith('http://') ||
    agentNameOrUrl.startsWith('https://')
  ) {
    // Full URL provided
    agentCardUrl = agentNameOrUrl.endsWith('/agent.json')
      ? agentNameOrUrl
      : `${agentNameOrUrl.replace(/\/$/, '')}/.well-known/agent.json`;
  } else {
    // Agent name provided - need a discovery mechanism
    agentCardUrl = await discoverAgentUrl(agentNameOrUrl);
    if (!agentCardUrl) {
      console.warn(`[Discovery] Could not discover agent: ${agentNameOrUrl}`);
      return null;
    }
  }

  try {
    const response = await fetch(agentCardUrl, {
      headers: { Accept: 'application/json' },
      // Static well-known card fetch — must be fast. WITHOUT a deadline a
      // slow/cold agent host holds the event loop here too (this runs on
      // the verifier main loop during resolution). 8s matches the sibling
      // discoverAgentUrl fetch; deliberately NOT the 110s LLM budget.
      signal: AbortSignal.timeout(
        Number(process.env.SPELLGUARD_VERIFIER_DISCOVERY_TIMEOUT_MS) || 8_000,
      ),
    });

    if (!response.ok) {
      console.warn(
        `[Discovery] Failed to fetch agent card from ${agentCardUrl}: ${response.status}`,
      );
      return null;
    }

    const card = (await response.json()) as AgentCard;

    // Validate required fields
    if (!card.name || !card.url || !card.skills) {
      console.warn(
        `[Discovery] Invalid agent card from ${agentCardUrl}: missing required fields`,
      );
      return null;
    }

    // Cache the result
    agentCardCache.set(agentNameOrUrl, { card, fetchedAt: Date.now() });

    console.log(`[Discovery] Resolved agent: ${card.name} at ${card.url}`);
    return card;
  } catch (error) {
    console.error(`[Discovery] Error fetching agent card: ${error}`);
    return null;
  }
}

/**
 * Discover agent URL from name.
 * Tries in order:
 * 1. Verifier agent registry (agents that have completed attestation)
 * 2. Management server (agent endpoint_url from DB)
 * 3. Direct A2A probe at the resolved URL
 */
async function discoverAgentUrl(agentName: string): Promise<string | null> {
  // Normalize agent name
  const normalized = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // 1. Check the Verifier's own agent registry (agents registered via attestation)
  const registeredAgent = getAgent(normalized);
  if (registeredAgent?.agentCardUrl) {
    console.log(
      `[Discovery] Found ${normalized} in Verifier registry at ${registeredAgent.agentCardUrl}`,
    );
    return registeredAgent.agentCardUrl;
  }
  if (registeredAgent?.endpoint) {
    // Fallback for agents registered without agentCardUrl
    const registryUrl = `${registeredAgent.endpoint.replace(/\/$/, '')}/.well-known/agent.json`;
    console.log(
      `[Discovery] Found ${normalized} in Verifier registry at ${registeredAgent.endpoint}`,
    );
    return registryUrl;
  }

  // 2. Query management server for the agent's endpoint URL
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  const verifierId = process.env.VERIFIER_ID || 'verifier-local-dev';

  if (managementUrl) {
    try {
      // GET request — sign with empty body
      const headers = await signRequest('');
      const response = await fetch(
        `${managementUrl}/v1/internal/agents/resolve/${encodeURIComponent(normalized)}`,
        {
          headers,
          signal: AbortSignal.timeout(5000),
        },
      );

      if (response.ok) {
        const data = (await response.json()) as {
          agentId: string;
          name: string;
          endpointUrl: string | null;
        };
        if (data.endpointUrl) {
          const url = `${data.endpointUrl.replace(/\/$/, '')}/.well-known/agent.json`;
          console.log(
            `[Discovery] Management resolved ${normalized} to ${data.endpointUrl}`,
          );
          return url;
        }
      }
    } catch (error) {
      console.warn(
        `[Discovery] Management resolution failed for ${normalized}: ${error}`,
      );
    }
  }

  return null;
}

/**
 * Resolve multiple agents in parallel.
 */
export async function resolveAgentCards(
  agentNamesOrUrls: string[],
): Promise<Map<string, AgentCard>> {
  const results = new Map<string, AgentCard>();

  const resolutions = await Promise.all(
    agentNamesOrUrls.map(async (name) => {
      const card = await resolveAgentCard(name);
      return { name, card };
    }),
  );

  for (const { name, card } of resolutions) {
    if (card) {
      results.set(name, card);
    }
  }

  return results;
}

/**
 * Clear the agent card cache (for testing).
 */
export function clearAgentCardCache(): void {
  agentCardCache.clear();
}
