# SPDX-License-Identifier: Apache-2.0

"""Centralized service URLs and utilities for Python integration tests.

Mirrors tests/helpers/urls.ts.
"""

from __future__ import annotations

import asyncio
import os

import httpx

VERIFIER_URL = os.environ.get("VERIFIER_URL", "http://localhost:3000")
MANAGEMENT_URL = os.environ.get("MANAGEMENT_URL", "http://localhost:3001/v1")
MANAGEMENT_ROOT = os.environ.get("MANAGEMENT_ROOT", "http://localhost:3001")
AGENT_A_URL = os.environ.get("AGENT_A_URL", "http://localhost:8787")
AGENT_B_URL = os.environ.get("AGENT_B_URL", "http://localhost:8788")
AGENT_C_URL = os.environ.get("AGENT_C_URL", "http://localhost:8789")
AGENT_PA_URL = os.environ.get("AGENT_PA_URL", "http://localhost:8801")
AGENT_PB_URL = os.environ.get("AGENT_PB_URL", "http://localhost:8802")
AGENT_PC_URL = os.environ.get("AGENT_PC_URL", "http://localhost:8803")
AGENT_PD_URL = os.environ.get("AGENT_PD_URL", "http://localhost:8804")


async def check_server_running(url: str, path: str = "/health") -> bool:
    """Return True when the service at *url* responds with HTTP 2xx on *path*."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{url}{path}")
            return resp.is_success
    except Exception:
        return False


async def flush_verifier_reporter(verifier_url: str) -> None:
    """Force the Verifier management reporter to flush its buffer immediately.

    Falls back to a fixed 8 s wait if the flush endpoint isn't available.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{verifier_url}/internal/reporter/flush")
            if resp.is_success:
                await asyncio.sleep(2)
                return
    except Exception:
        pass
    # Fallback: wait for the periodic 5 s flush + buffer
    await asyncio.sleep(8)


async def chat(agent_url: str, message: str, timeout: float = 120.0) -> str:
    """POST to an agent's /chat endpoint and return the response text."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"{agent_url}/chat",
            json={"message": message},
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("response") or data.get("message") or str(data)
