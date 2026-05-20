# SPDX-License-Identifier: Apache-2.0

"""Shared pytest configuration and fixtures for Python Spellguard tests."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

# ---------------------------------------------------------------------------
# Server URLs (matching tests/helpers/urls.ts)
# ---------------------------------------------------------------------------

VERIFIER_URL = os.environ.get("VERIFIER_URL", "http://localhost:3000")
MANAGEMENT_URL = os.environ.get("MANAGEMENT_URL", "http://localhost:3001/v1")
MANAGEMENT_ROOT = os.environ.get("MANAGEMENT_ROOT", "http://localhost:3001")
AGENT_PA_URL = os.environ.get("AGENT_PA_URL", "http://localhost:8801")
AGENT_PB_URL = os.environ.get("AGENT_PB_URL", "http://localhost:8802")
AGENT_A_URL = os.environ.get("AGENT_A_URL", "http://localhost:8787")
AGENT_B_URL = os.environ.get("AGENT_B_URL", "http://localhost:8788")
AGENT_C_URL = os.environ.get("AGENT_C_URL", "http://localhost:8789")
AGENT_PC_URL = os.environ.get("AGENT_PC_URL", "http://localhost:8803")
AGENT_PD_URL = os.environ.get("AGENT_PD_URL", "http://localhost:8804")

REQUIRE_INTEGRATION = (
    os.environ.get("CI") == "true"
    or os.environ.get("REQUIRE_INTEGRATION_SERVICES") == "true"
)


async def check_server_running(url: str) -> bool:
    """Check if a server is running at the given URL."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.head(url)
            return response.status_code < 500
    except Exception:
        return False
