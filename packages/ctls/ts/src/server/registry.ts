// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Agent Registry
 *
 * In-memory registry for registered agents and channel tokens.
 */

import type { RegisteredAgent } from '../types';

// In-memory agent registry
const registry = new Map<string, RegisteredAgent>();
const tokenIndex = new Map<string, string>(); // token -> agentId

/**
 * Result of agent registration.
 */
export interface RegisterResult {
  success: boolean;
  error?: string;
}

/**
 * Options for {@link registerAgent}.
 */
export interface RegisterAgentOptions {
  /**
   * When true, accept a re-registration and replace the existing record,
   * including its channel token. Pass this only
   * after the caller has independently verified that the registering
   * party owns the agent identity (e.g. a successful evidence-signature
   * check against the management-tracked agent public key).
   *
   * Defaults to false — preserving the strict anti-hijacking guard for
   * paths that don't have signed evidence backing them (auto-discovery
   * via A2A, etc.).
   */
  allowEndpointUpdate?: boolean;
}

/**
 * Register an agent in the registry.
 *
 * @param agent - Agent to register
 * @param options - Registration options
 * @returns Registration result
 */
export function registerAgent(
  agent: RegisteredAgent,
  options?: RegisterAgentOptions,
): RegisterResult {
  // Evict first, then decide. An EXPIRED record blocks nothing: its channel
  // token is already invalid everywhere else in this module (getAgent,
  // getAgentByToken, and verifyChannelToken all treat an expired record as
  // gone), so blocking a re-registration on it protects no live token and is
  // pure lockout. Both the read path (getAgent) and this registration path
  // funnel through evictIfExpired so their expiry semantics cannot drift.
  const existing = evictIfExpired(agent.agentId);

  // Invariant: an ACTIVE (unexpired) record blocks unverified re-registration;
  // an EXPIRED one never does (it was evicted above). Block re-registration
  // over a live record unless the caller has explicitly proven ownership
  // upstream (allowEndpointUpdate). Protecting only endpoint changes is
  // insufficient: an actor that learns an agent ID and its public endpoint
  // could submit the same endpoint and silently replace the legitimate channel
  // token. Because an expired record is evicted here, a restarted agent in
  // standalone / fail-open mode is not permanently locked out — its lockout is
  // bounded by the previous registration's expiresAt.
  if (existing && !options?.allowEndpointUpdate) {
    return {
      success: false,
      error: `Agent ${agent.agentId} already registered`,
    };
  }

  if (existing && existing.endpoint !== agent.endpoint) {
    console.log(
      `[cTLS] Updating endpoint for agent ${agent.agentId}: ${existing.endpoint} → ${agent.endpoint}`,
    );
  }

  // Remove old token from index if updating
  if (existing) {
    tokenIndex.delete(existing.channelToken);
  }

  // Register the agent
  registry.set(agent.agentId, agent);
  tokenIndex.set(agent.channelToken, agent.agentId);

  console.log(`[cTLS] Registered agent: ${agent.agentId}`);
  return { success: true };
}

/**
 * Return the live record for an agent, evicting it (record + token index) first
 * if its registration has expired.
 *
 * This is the SINGLE source of expiry semantics for the module: any expired
 * registration is treated as gone and its channel token is removed from the
 * index. Both {@link getAgent} (read path) and {@link registerAgent}
 * (registration path) call this so they can never disagree about whether a
 * record still exists — the drift that once let an expired record permanently
 * block re-registration while every reader considered it gone.
 */
function evictIfExpired(agentId: string): RegisteredAgent | undefined {
  const agent = registry.get(agentId);
  if (!agent) return undefined;

  if (agent.expiresAt < Date.now()) {
    registry.delete(agentId);
    tokenIndex.delete(agent.channelToken);
    return undefined;
  }

  return agent;
}

/**
 * Get an agent by ID.
 */
export function getAgent(agentId: string): RegisteredAgent | undefined {
  return evictIfExpired(agentId);
}

/**
 * Get an agent by channel token.
 */
export function getAgentByToken(token: string): RegisteredAgent | undefined {
  const agentId = tokenIndex.get(token);
  if (!agentId) return undefined;
  return getAgent(agentId);
}

/**
 * Get all registered agents.
 */
export function getAllAgents(): RegisteredAgent[] {
  const now = Date.now();
  const agents: RegisteredAgent[] = [];

  for (const [agentId, agent] of registry) {
    if (agent.expiresAt < now) {
      // Clean up expired agent
      registry.delete(agentId);
      tokenIndex.delete(agent.channelToken);
    } else {
      agents.push(agent);
    }
  }

  return agents;
}

/**
 * Check if an agent is registered.
 */
export function isAgentRegistered(agentId: string): boolean {
  return getAgent(agentId) !== undefined;
}

/**
 * Verify a channel token is valid.
 */
export function verifyChannelToken(token: string): boolean {
  return getAgentByToken(token) !== undefined;
}

/**
 * Rotate the channel token for an agent.
 *
 * @param agentId - ID of the agent
 * @returns New token and expiry, or null if agent not found
 */
export function rotateChannelToken(
  agentId: string,
): { token: string; expiresAt: number } | null {
  const agent = getAgent(agentId);
  if (!agent) return null;

  // Remove old token from index
  tokenIndex.delete(agent.channelToken);

  // Generate new token
  const newToken = generateToken();
  const newExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  // Update agent
  agent.channelToken = newToken;
  agent.expiresAt = newExpiresAt;
  registry.set(agentId, agent);
  tokenIndex.set(newToken, agentId);

  console.log(`[cTLS] Rotated token for agent: ${agentId}`);
  return { token: newToken, expiresAt: newExpiresAt };
}

/**
 * Clear the registry (for testing).
 */
export function clearRegistry(): void {
  registry.clear();
  tokenIndex.clear();
}

/**
 * Generate a secure random token.
 */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
