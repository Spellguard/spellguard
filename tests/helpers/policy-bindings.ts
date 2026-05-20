// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for integration tests that manage agent policy bindings.
 *
 * After the policy hierarchy redesign (v0.17.0), per-agent JSONB policy
 * columns were replaced by a `policy_bindings` table with CRUD endpoints:
 *   GET    /v1/agents/:agentId/bindings
 *   POST   /v1/agents/:agentId/bindings
 *   DELETE  /v1/agents/:agentId/bindings/:bindingId
 *
 * These helpers provide a backward-compatible interface so integration tests
 * can set/get/clear agent bindings without caring about the CRUD details.
 */

interface BindingInput {
  policyId: string;
  level?: string;
  effect?: string;
  direction?: string;
  config?: Record<string, unknown>;
  failBehavior?: string;
}

interface BindingRow {
  id: string;
  policyId: string | null;
  direction: string;
  effect: string;
  config?: Record<string, unknown>;
}

/**
 * Resolve a policy slug to its UUID. Returns null if not found.
 */
async function resolvePolicyId(
  managementUrl: string,
  headers: Record<string, string>,
  slugOrId: string,
): Promise<string | null> {
  // If it looks like a UUID already, return as-is
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      slugOrId,
    )
  ) {
    return slugOrId;
  }

  // Look up the policy by slug
  const res = await fetch(`${managementUrl}/policies/${slugOrId}`, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * List current agent-level bindings.
 */
async function listAgentBindings(
  managementUrl: string,
  headers: Record<string, string>,
  agentId: string,
): Promise<BindingRow[]> {
  const res = await fetch(`${managementUrl}/agents/${agentId}/bindings`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to list bindings for ${agentId}: ${res.status}`);
  }
  const data = (await res.json()) as { items: BindingRow[] };
  return data.items;
}

/**
 * Delete all agent-level bindings for an agent.
 */
async function clearAgentBindings(
  managementUrl: string,
  headers: Record<string, string>,
  agentId: string,
): Promise<void> {
  const bindings = await listAgentBindings(managementUrl, headers, agentId);
  for (const b of bindings) {
    await fetch(`${managementUrl}/agents/${agentId}/bindings/${b.id}`, {
      method: 'DELETE',
      headers,
    });
  }
}

/**
 * Create a single agent-level binding.
 */
async function createAgentBinding(
  managementUrl: string,
  headers: Record<string, string>,
  agentId: string,
  policyUuid: string,
  direction: string,
  effect: string,
  config?: Record<string, unknown>,
  failBehavior?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    policyId: policyUuid,
    direction,
    effect,
  };
  if (config) body.config = config;
  if (failBehavior) body.failBehavior = failBehavior;

  const res = await fetch(`${managementUrl}/agents/${agentId}/bindings`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to create binding for ${agentId}: ${res.status} ${text}`,
    );
  }
}

/**
 * Set agent policies — backward-compatible replacement for the old
 * `PUT /agents/:agentId/policies` endpoint.
 *
 * Clears all existing agent-level bindings, then creates new ones from
 * the provided inbound/outbound arrays.
 */
export async function setAgentPolicies(
  managementUrl: string,
  headers: Record<string, string>,
  agentId: string,
  inbound: BindingInput[],
  outbound: BindingInput[],
): Promise<void> {
  await clearAgentBindings(managementUrl, headers, agentId);

  for (const b of inbound) {
    const policyUuid = await resolvePolicyId(
      managementUrl,
      headers,
      b.policyId,
    );
    if (!policyUuid) {
      throw new Error(`Policy not found: ${b.policyId}`);
    }
    await createAgentBinding(
      managementUrl,
      headers,
      agentId,
      policyUuid,
      b.direction ?? 'inbound',
      b.effect ?? 'block',
      b.config,
      b.failBehavior,
    );
  }

  for (const b of outbound) {
    const policyUuid = await resolvePolicyId(
      managementUrl,
      headers,
      b.policyId,
    );
    if (!policyUuid) {
      throw new Error(`Policy not found: ${b.policyId}`);
    }
    await createAgentBinding(
      managementUrl,
      headers,
      agentId,
      policyUuid,
      b.direction ?? 'outbound',
      b.effect ?? 'block',
      b.config,
      b.failBehavior,
    );
  }
}

/**
 * Get agent policies — backward-compatible replacement for the old
 * `GET /agents/:agentId/policies` endpoint.
 *
 * Returns bindings grouped into inbound/outbound arrays.
 */
export async function getAgentPolicies(
  managementUrl: string,
  headers: Record<string, string>,
  agentId: string,
): Promise<{ inbound: BindingRow[]; outbound: BindingRow[] }> {
  const bindings = await listAgentBindings(managementUrl, headers, agentId);
  const inbound: BindingRow[] = [];
  const outbound: BindingRow[] = [];

  for (const b of bindings) {
    if (b.direction === 'inbound' || b.direction === 'both') {
      inbound.push(b);
    }
    if (b.direction === 'outbound' || b.direction === 'both') {
      outbound.push(b);
    }
  }

  return { inbound, outbound };
}
