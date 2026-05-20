# SPDX-License-Identifier: Apache-2.0

"""Verifier server helpers for integration tests."""

from __future__ import annotations

from typing import Any

import httpx


async def get_verifier_stats(verifier_url: str) -> dict[str, Any] | None:
    """GET /stats from the Verifier server."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{verifier_url}/stats")
            if not resp.is_success:
                return None
            return resp.json()
    except Exception:
        return None


async def get_verifier_commitments(verifier_url: str) -> dict[str, Any] | None:
    """GET /logs/commitments from the Verifier server."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{verifier_url}/logs/commitments")
            if not resp.is_success:
                return None
            return resp.json()
    except Exception:
        return None


async def invalidate_policy_cache(verifier_url: str, agent_id: str) -> None:
    """POST to the Verifier internal cache invalidation endpoint."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        await client.post(
            f"{verifier_url}/internal/policies/invalidate",
            params={"agentId": agent_id},
        )
