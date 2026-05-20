// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for integration tests that call the management API.
 *
 * After org-scoping was added, all agent endpoints require an org context
 * (either from the JWT's organizationId claim or the X-Organization-Id header).
 * These helpers resolve the test org and build the correct headers so tests
 * work regardless of which org the JWT defaults to.
 */

import { MANAGEMENT_URL } from './urls';

/**
 * Resolve the test org ID by listing the user's organizations and finding
 * the seeded `test-org`.  Throws with a descriptive message if not found.
 */
export async function resolveTestOrgId(token: string): Promise<string> {
  const res = await fetch(`${MANAGEMENT_URL}/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to list orgs: ${res.status}`);
  const data = (await res.json()) as {
    items: { id: string; slug: string; isPersonal: boolean }[];
  };
  const testOrg = data.items.find((o) => o.slug === 'test-org');
  if (!testOrg) {
    throw new Error(
      `Test org not found. Available orgs: ${data.items.map((o) => o.slug).join(', ')}. Run: pnpm run db:seed`,
    );
  }
  return testOrg.id;
}

/**
 * Build auth + org headers for management API calls.
 */
export function orgAuthHeaders(
  token: string,
  orgId: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Organization-Id': orgId,
  };
}
