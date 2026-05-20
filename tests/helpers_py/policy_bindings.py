# SPDX-License-Identifier: Apache-2.0

"""Agent policy binding helpers for integration tests.

Mirrors tests/helpers/policy-bindings.ts.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


async def _resolve_policy_id(
    management_url: str, headers: dict[str, str], slug_or_id: str
) -> str | None:
    if _UUID_RE.match(slug_or_id):
        return slug_or_id
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{management_url}/policies/{slug_or_id}", headers=headers
        )
        if not resp.is_success:
            return None
        return resp.json()["id"]


async def list_agent_bindings(
    management_url: str, headers: dict[str, str], agent_id: str
) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{management_url}/agents/{agent_id}/bindings", headers=headers
        )
        resp.raise_for_status()
        return resp.json().get("items", [])


async def clear_agent_bindings(
    management_url: str, headers: dict[str, str], agent_id: str
) -> None:
    bindings = await list_agent_bindings(management_url, headers, agent_id)
    async with httpx.AsyncClient(timeout=10.0) as client:
        for b in bindings:
            await client.delete(
                f"{management_url}/agents/{agent_id}/bindings/{b['id']}",
                headers=headers,
            )


async def create_agent_binding(
    management_url: str,
    headers: dict[str, str],
    agent_id: str,
    policy_uuid: str,
    direction: str,
    effect: str,
    config: dict[str, Any] | None = None,
    fail_behavior: str | None = None,
) -> None:
    body: dict[str, Any] = {
        "policyId": policy_uuid,
        "direction": direction,
        "effect": effect,
    }
    if config:
        body["config"] = config
    if fail_behavior:
        body["failBehavior"] = fail_behavior
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{management_url}/agents/{agent_id}/bindings",
            headers=headers,
            json=body,
        )
        if not resp.is_success:
            raise RuntimeError(
                f"Failed to create binding for {agent_id}: {resp.status_code} {resp.text}"
            )


async def set_agent_policies(
    management_url: str,
    headers: dict[str, str],
    agent_id: str,
    inbound: list[dict[str, Any]],
    outbound: list[dict[str, Any]],
) -> None:
    """Clear existing bindings and recreate from *inbound*/*outbound* arrays."""
    await clear_agent_bindings(management_url, headers, agent_id)
    for b in inbound:
        raw_id = b.get("policyId")
        if not raw_id:
            continue  # skip bindings without a policy ID
        policy_uuid = await _resolve_policy_id(
            management_url, headers, raw_id
        )
        if not policy_uuid:
            raise RuntimeError(f"Policy not found: {raw_id}")
        await create_agent_binding(
            management_url,
            headers,
            agent_id,
            policy_uuid,
            b.get("direction", "inbound"),
            b.get("effect", "block"),
            b.get("config"),
            b.get("failBehavior"),
        )
    for b in outbound:
        raw_id = b.get("policyId")
        if not raw_id:
            continue
        policy_uuid = await _resolve_policy_id(
            management_url, headers, raw_id
        )
        if not policy_uuid:
            raise RuntimeError(f"Policy not found: {raw_id}")
        await create_agent_binding(
            management_url,
            headers,
            agent_id,
            policy_uuid,
            b.get("direction", "outbound"),
            b.get("effect", "block"),
            b.get("config"),
            b.get("failBehavior"),
        )


async def get_agent_policies(
    management_url: str, headers: dict[str, str], agent_id: str
) -> dict[str, list[dict[str, Any]]]:
    """Return bindings grouped into ``{"inbound": [...], "outbound": [...]}``."""
    bindings = await list_agent_bindings(management_url, headers, agent_id)
    inbound: list[dict[str, Any]] = []
    outbound: list[dict[str, Any]] = []
    for b in bindings:
        d = b.get("direction", "")
        if d in ("inbound", "both"):
            inbound.append(b)
        if d in ("outbound", "both"):
            outbound.append(b)
    return {"inbound": inbound, "outbound": outbound}
