# SPDX-License-Identifier: Apache-2.0

"""Management API helpers for integration tests.

Mirrors tests/helpers/management-api.ts.
"""

from __future__ import annotations

import httpx

from .urls import MANAGEMENT_URL


async def resolve_test_org_id(token: str) -> str:
    """List the user's organizations and return the seeded ``test-org`` id."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{MANAGEMENT_URL}/organizations",
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        data = resp.json()

    for org in data.get("items", []):
        if org.get("slug") == "test-org":
            return org["id"]

    slugs = [o.get("slug") for o in data.get("items", [])]
    raise RuntimeError(
        f"Test org not found. Available: {slugs}. Run: pnpm run db:seed"
    )


def org_auth_headers(token: str, org_id: str) -> dict[str, str]:
    """Build auth + org headers for management API calls."""
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "X-Organization-Id": org_id,
    }
