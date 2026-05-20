# SPDX-License-Identifier: Apache-2.0

"""Audit log and policy management helpers for integration tests."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import httpx


def iso_now() -> str:
    """Return current UTC time in JS-compatible ISO format (Z suffix)."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


async def get_audit_logs(
    management_url: str,
    headers: dict[str, str],
    agent_id: str,
    from_ts: str,
    to_ts: str,
) -> dict[str, Any]:
    """Fetch audit logs for *agent_id* in the given time range.

    Parses JSONB ``policyChecks`` strings automatically.
    """
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{management_url}/agents/{agent_id}/logs",
            headers=headers,
            params={"from": from_ts, "to": to_ts, "limit": "100"},
        )
        resp.raise_for_status()
        data = resp.json()

    for log in data.get("logs", []):
        if isinstance(log.get("policyChecks"), str):
            try:
                log["policyChecks"] = json.loads(log["policyChecks"])
            except (json.JSONDecodeError, TypeError):
                log["policyChecks"] = []
    return data


async def poll_audit_logs(
    management_url: str,
    headers: dict[str, str],
    agent_id: str,
    since: str,
    *,
    timeout_seconds: float = 30,
    interval: float = 3,
) -> list[dict[str, Any]]:
    """Poll audit logs until entries appear or *timeout_seconds* elapses."""
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    logs: list[dict[str, Any]] = []
    while asyncio.get_event_loop().time() < deadline:
        now = iso_now()
        result = await get_audit_logs(
            management_url, headers, agent_id, since, now
        )
        logs = result.get("logs", [])
        if logs:
            break
        await asyncio.sleep(interval)
    return logs


async def create_policy(
    management_url: str, headers: dict[str, str], body: dict[str, Any]
) -> dict[str, Any]:
    """Create a policy and return ``{"id": ..., "slug": ...}``."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{management_url}/policies", headers=headers, json=body
        )
        if not resp.is_success:
            raise RuntimeError(
                f"Failed to create policy: {resp.status_code} {resp.text}"
            )
        return resp.json()


async def get_policy_by_slug(
    management_url: str, headers: dict[str, str], slug: str
) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{management_url}/policies/{slug}", headers=headers
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


async def delete_policy(
    management_url: str, headers: dict[str, str], policy_id: str
) -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            f"{management_url}/policies/{policy_id}", headers=headers
        )
        if not resp.is_success and resp.status_code != 404:
            raise RuntimeError(
                f"Failed to delete policy {policy_id}: {resp.status_code}"
            )
