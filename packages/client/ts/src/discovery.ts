// SPDX-License-Identifier: Apache-2.0

import type { AgentCard } from '@spellguard/ctls';
import { getConfig } from './attestation';
import type { ResolvedAgent } from './types';

/**
 * Cache for discovered agent cards.
 */
const agentCache = new Map<string, { card: AgentCard; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Runtime port overrides for testing.  Empty by default — all discovery
 * goes through the Verifier (which queries management for agent URLs).
 */
const LOCAL_PORTS: Record<string, number> = {};

/**
 * Discover agents by their names/identifiers.
 * Resolves agent names to full AgentCard information via A2A discovery.
 * If full discovery fails but Verifier is configured, creates stub entries
 * so the Verifier router can resolve agents from its own registry.
 */
export async function discoverAgents(
  agentRefs: string[],
): Promise<ResolvedAgent[]> {
  const results: ResolvedAgent[] = [];

  await Promise.all(
    agentRefs.map(async (ref) => {
      const card = await resolveAgentCard(ref);
      if (card) {
        results.push({
          name: ref,
          url: card.url,
          agentCard: card,
        });
      } else if (getConfig()?.verifierUrl) {
        // Full A2A discovery failed, but we have a Verifier connection.
        // Create a stub entry — the Verifier router will resolve the agent
        // from its own registry when we send the message.
        console.log(
          `[Discovery] Creating Verifier-routed stub for ${ref} (Verifier will resolve)`,
        );
        results.push({
          name: ref,
          url: 'verifier-routed',
          agentCard: { name: ref, url: 'verifier-routed', skills: [] },
        });
      }
    }),
  );

  return results;
}

/**
 * Resolve an agent name or URL to its Agent Card.
 */
export async function resolveAgentCard(
  agentNameOrUrl: string,
): Promise<AgentCard | null> {
  // Check cache first
  const cached = agentCache.get(agentNameOrUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.card;
  }

  // Determine URL to fetch from
  let agentCardUrl: string;

  if (
    agentNameOrUrl.startsWith('http://') ||
    agentNameOrUrl.startsWith('https://')
  ) {
    // Full URL provided
    agentCardUrl = agentNameOrUrl.endsWith('/agent.json')
      ? agentNameOrUrl
      : `${agentNameOrUrl.replace(/\/$/, '')}/.well-known/agent.json`;
  } else {
    // Agent name - try local discovery, then Verifier resolution
    const url = await discoverAgentByName(agentNameOrUrl);
    if (!url) {
      console.warn(`[Discovery] Could not discover agent: ${agentNameOrUrl}`);
      return null;
    }
    agentCardUrl = url;
  }

  try {
    const response = await fetch(agentCardUrl, {
      headers: { Accept: 'application/json' },
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

    // DNS hijacking protection: verify URL matches requested domain
    try {
      const requestedUrl = new URL(agentCardUrl);
      const returnedUrl = new URL(card.url);

      // Check if the domain matches (prevents DNS hijacking attacks)
      if (requestedUrl.hostname !== returnedUrl.hostname) {
        console.warn(
          `[Discovery] DNS hijacking detected: requested ${requestedUrl.hostname}, got ${returnedUrl.hostname}`,
        );
        return null;
      }
    } catch {
      console.warn(`[Discovery] Invalid URL in agent card: ${card.url}`);
      return null;
    }

    // Cache the result
    agentCache.set(agentNameOrUrl, { card, fetchedAt: Date.now() });

    console.log(`[Discovery] Resolved agent: ${card.name} at ${card.url}`);
    return card;
  } catch (error) {
    console.error(`[Discovery] Error fetching agent card: ${error}`);
    return null;
  }
}

/**
 * Discover an agent by name.
 * Tries in order:
 * 1. Local port overrides (registered programmatically for testing)
 * 2. Verifier agent resolution (Verifier checks its registry + management server)
 */
async function discoverAgentByName(agentName: string): Promise<string | null> {
  const normalized = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // 1. Check runtime port overrides (for testing)
  const port = LOCAL_PORTS[normalized];
  if (port) {
    const url = `http://localhost:${port}/.well-known/agent.json`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return url;
      }
    } catch {
      // Port not available, continue to Verifier resolution
    }
  }

  // 2. Ask the Verifier to resolve the agent (Verifier checks its own registry +
  //    queries management for the agent's endpoint URL)
  const config = getConfig();
  if (config?.verifierUrl) {
    try {
      const verifierResolveUrl = `${config.verifierUrl}/agents/resolve/${encodeURIComponent(normalized)}`;
      const response = await fetch(verifierResolveUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const card = (await response.json()) as AgentCard;
        if (card.url) {
          console.log(
            `[Discovery] Verifier resolved ${normalized} to ${card.url}`,
          );
          // Return the agent card URL (the Verifier already gave us the full card,
          // but we return the URL so the standard flow fetches + validates it)
          return `${card.url.replace(/\/$/, '')}/.well-known/agent.json`;
        }
      }
    } catch (error) {
      console.warn(
        `[Discovery] Verifier resolution failed for ${normalized}: ${error}`,
      );
    }
  }

  return null;
}

/**
 * Clear the agent cache (for testing).
 */
export function clearAgentCache(): void {
  agentCache.clear();
}

/**
 * Register local port mapping for an agent (for testing).
 */
export function registerLocalAgent(agentName: string, port: number): void {
  LOCAL_PORTS[agentName.toLowerCase()] = port;
}
