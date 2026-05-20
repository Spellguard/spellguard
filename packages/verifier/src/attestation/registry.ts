// SPDX-License-Identifier: Apache-2.0

import type { RegisteredAgent } from '../types';

/**
 * In-memory registry of attested agents.
 * In production, this could be backed by a database or distributed cache.
 */
const registry = new Map<string, RegisteredAgent>();

/**
 * Register an agent after successful attestation.
 * Returns success status - fails if agent already registered with different endpoint.
 */
export function registerAgent(agent: RegisteredAgent): {
  success: boolean;
  error?: string;
} {
  const existing = registry.get(agent.agentId);

  // Check for existing agent with different endpoint (hijacking attempt)
  if (existing && existing.endpoint !== agent.endpoint) {
    console.log(
      `[Registry] Rejected re-registration attempt for agent: ${agent.agentId}`,
    );
    return {
      success: false,
      error: 'Agent already registered with different endpoint',
    };
  }

  registry.set(agent.agentId, agent);
  console.log(`[Registry] Registered agent: ${agent.agentId}`);
  return { success: true };
}

/**
 * Get a registered agent by ID.
 */
export function getAgent(agentId: string): RegisteredAgent | undefined {
  return registry.get(agentId);
}

/**
 * Check if an agent is registered and not expired.
 */
export function isAgentRegistered(agentId: string): boolean {
  const agent = registry.get(agentId);
  if (!agent) return false;
  if (agent.expiresAt < Date.now()) {
    // Remove expired registration
    registry.delete(agentId);
    return false;
  }
  return true;
}

/**
 * Get all registered agents.
 */
export function getAllAgents(): RegisteredAgent[] {
  const now = Date.now();
  const agents: RegisteredAgent[] = [];

  for (const [id, agent] of registry) {
    if (agent.expiresAt < now) {
      registry.delete(id);
    } else {
      agents.push(agent);
    }
  }

  return agents;
}

/**
 * Remove an agent from the registry.
 */
export function unregisterAgent(agentId: string): boolean {
  return registry.delete(agentId);
}

/**
 * Verify a channel token for an agent.
 */
export function verifyChannelToken(
  agentId: string,
  channelToken: string,
): boolean {
  const agent = registry.get(agentId);
  if (!agent) return false;
  if (agent.expiresAt < Date.now()) {
    registry.delete(agentId);
    return false;
  }
  return agent.channelToken === channelToken;
}

/**
 * Get agent by endpoint URL.
 */
export function getAgentByEndpoint(
  endpoint: string,
): RegisteredAgent | undefined {
  for (const agent of registry.values()) {
    if (agent.endpoint === endpoint) {
      return agent;
    }
  }
  return undefined;
}

/**
 * Get agent by channel token.
 */
export function getAgentByToken(
  channelToken: string,
): RegisteredAgent | undefined {
  const now = Date.now();
  for (const [id, agent] of registry) {
    if (agent.channelToken === channelToken) {
      if (agent.expiresAt < now) {
        registry.delete(id);
        return undefined;
      }
      return agent;
    }
  }
  return undefined;
}

/**
 * Rotate the channel token for an agent.
 * Generates a new token and updates the expiry.
 */
export function rotateChannelToken(
  agentId: string,
): { token: string; expiresAt: number } | null {
  const agent = registry.get(agentId);
  if (!agent) return null;

  // Generate new token using crypto-secure random
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const newToken = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1000;
  const newExpiresAt = Date.now() + TOKEN_VALIDITY_MS;

  // Update the agent record
  agent.channelToken = newToken;
  agent.expiresAt = newExpiresAt;
  registry.set(agentId, agent);

  console.log(`[Registry] Rotated token for agent: ${agentId}`);

  return { token: newToken, expiresAt: newExpiresAt };
}

/**
 * Clear all registrations (for testing).
 */
export function clearRegistry(): void {
  registry.clear();
}
