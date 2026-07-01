// SPDX-License-Identifier: Apache-2.0

/**
 * Per-process registry of agents that have asked the gateway to receive
 * SLIM-inbound messages on their behalf.
 *
 * Each registration carries:
 * - agentId: stable identifier the agent uses elsewhere
 * - slimName: the SLIM hierarchical name the agent is reachable at
 * - callbackUrl: the agent's HTTPS endpoint that handles inbound messages
 *   (typically `${selfUrl}/_spellguard/receive`). On inbound SLIM frames,
 *   the gateway POSTs the message envelope to this URL and uses the HTTP
 *   response body as the SRPC reply going back through the SLIM data
 *   plane to the original sender.
 *
 * Registration is idempotent — re-registering an agent updates its
 * callbackUrl + lastSeen and is a no-op otherwise. Workers redeployments
 * naturally re-register on their next init.
 *
 * Stateful in process memory only; this is intentional. The gateway is
 * meant to run as a single-instance per deployment (the staging stack
 * provisions one EC2 + one gateway container). If we ever need HA
 * gateways, this map becomes a shared store (Redis / DO storage / dir
 * itself) — the abstraction here is small enough that the swap is local.
 */

export interface AgentRegistration {
  agentId: string;
  slimName: string;
  callbackUrl: string;
  lastSeen: number;
}

const bySlimName = new Map<string, AgentRegistration>();
const byAgentId = new Map<string, AgentRegistration>();

/** Idempotent register/update of an agent's SLIM-inbound callback. */
export function registerAgent(
  reg: Omit<AgentRegistration, 'lastSeen'>,
): AgentRegistration {
  const full: AgentRegistration = { ...reg, lastSeen: Date.now() };
  // Drop the previous slimName mapping if the agentId is being re-pointed.
  const prev = byAgentId.get(reg.agentId);
  if (prev && prev.slimName !== reg.slimName) {
    bySlimName.delete(prev.slimName);
  }
  bySlimName.set(reg.slimName, full);
  byAgentId.set(reg.agentId, full);
  return full;
}

/** Remove an agent registration. Returns true if anything was removed. */
export function unregisterAgent(agentId: string): boolean {
  const reg = byAgentId.get(agentId);
  if (!reg) return false;
  bySlimName.delete(reg.slimName);
  byAgentId.delete(agentId);
  return true;
}

export function lookupBySlimName(slimName: string): AgentRegistration | null {
  return bySlimName.get(slimName) ?? null;
}

export function lookupByAgentId(agentId: string): AgentRegistration | null {
  return byAgentId.get(agentId) ?? null;
}

export function listRegistrations(): AgentRegistration[] {
  return [...byAgentId.values()];
}

export function _clearForTesting(): void {
  bySlimName.clear();
  byAgentId.clear();
}
