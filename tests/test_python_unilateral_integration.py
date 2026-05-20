# SPDX-License-Identifier: Apache-2.0

"""Unilateral integration tests for Python agents.

Mirrors tests/unilateral-integration.test.ts using Agent PA (Python) as the
Spellguard-attested sender communicating with Agent C (A2A-only, non-Spellguard).

Tests:
1.  Agent C discovery (agent card, no spellguard-verifier auth)
2.  Verifier resolver discovery
3.  A2A JSON-RPC protocol compliance (ping, weather, stocks)
4.  Verifier unilateral endpoint validation
5.  A2A JSON-RPC format validation
6.  Verifier logging backends
7.  Agent C standalone health/data tests

NOTE: Outbound policy enforcement tests that require the management server
have been moved to tests/test_python_unilateral_managed_integration.py so OSS
builds (which never run management) don't print skip noise. The end-to-end
Agent PA -> Verifier -> Agent C tests have moved to the same file because
agent-pa must resolve agent-c via management's registry.

Requires: Verifier server, agent-pa, agent-c
"""

from __future__ import annotations

import pytest
import httpx

from tests.conftest import (
    VERIFIER_URL,
    AGENT_PA_URL,
    AGENT_C_URL,
    REQUIRE_INTEGRATION,
    check_server_running,
)
from tests.helpers_py.verifier import get_verifier_stats

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
async def services_ready():
    verifier_ok = await check_server_running(VERIFIER_URL)
    pa_ok = await check_server_running(AGENT_PA_URL)
    c_ok = await check_server_running(AGENT_C_URL)
    all_ready = verifier_ok and pa_ok and c_ok
    if not all_ready and REQUIRE_INTEGRATION:
        pytest.fail("Required services not running")
    return all_ready


# ---------------------------------------------------------------------------
# 1. Agent C Discovery
# ---------------------------------------------------------------------------


class TestPythonUnilateralAgentCDiscovery:
    async def test_agent_card_no_spellguard_auth(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{AGENT_C_URL}/.well-known/agent.json")
            assert resp.status_code == 200
            card = resp.json()
            assert card["name"] == "agent-c"
            assert "skills" in card
            assert isinstance(card["skills"], list)

            # Agent C should NOT have spellguard-verifier authentication
            schemes = (card.get("authentication") or {}).get("schemes", [])
            assert "spellguard-verifier" not in schemes

    async def test_discoverable_via_verifier_resolver(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{VERIFIER_URL}/agents/resolve/agent-c")
            # May or may not succeed depending on registration, but endpoint should work
            assert resp.status_code in (200, 404)


# ---------------------------------------------------------------------------
# 2. A2A Protocol Compliance
# ---------------------------------------------------------------------------


class TestPythonUnilateralA2AProtocol:
    async def test_json_rpc_ping(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{AGENT_C_URL}/a2a",
                json={
                    "jsonrpc": "2.0",
                    "id": "test-1",
                    "method": "tasks/send",
                    "params": {
                        "id": "task-1",
                        "message": {"role": "user", "parts": [{"type": "text", "text": "ping"}]},
                    },
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["jsonrpc"] == "2.0"
            assert data["id"] == "test-1"
            assert data["result"]["status"]["state"] == "completed"

    async def test_weather_data(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{AGENT_C_URL}/a2a",
                json={
                    "jsonrpc": "2.0",
                    "id": "test-weather",
                    "method": "tasks/send",
                    "params": {
                        "id": "task-weather",
                        "message": {
                            "role": "user",
                            "parts": [{"type": "text", "text": "What is the current weather?"}],
                        },
                    },
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            text = data["result"]["artifacts"][0]["parts"][0]["text"]
            assert "weather" in text.lower()
            assert "San Francisco" in text

    async def test_stock_data(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{AGENT_C_URL}/a2a",
                json={
                    "jsonrpc": "2.0",
                    "id": "test-stocks",
                    "method": "tasks/send",
                    "params": {
                        "id": "task-stocks",
                        "message": {
                            "role": "user",
                            "parts": [{"type": "text", "text": "What are the current stock prices?"}],
                        },
                    },
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            text = data["result"]["artifacts"][0]["parts"][0]["text"]
            lower = text.lower()
            assert any(
                kw in text or kw in lower
                for kw in ("AAPL", "GOOGL", "MSFT", "NVDA", "stock", "price")
            )


# ---------------------------------------------------------------------------
# 3. Verifier Unilateral Endpoint Validation
# ---------------------------------------------------------------------------


class TestPythonUnilateralVerifierEndpoint:
    async def test_reject_without_channel_token(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{VERIFIER_URL}/messages/unilateral",
                json={
                    "sender": "agent-pa",
                    "a2aAgentUrl": AGENT_C_URL,
                    "payload": {"text": "Hello"},
                },
            )
            assert resp.status_code == 401
            error = resp.json()
            assert "Missing channel token" in error.get("error", "")

    async def test_reject_missing_fields(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{VERIFIER_URL}/messages/unilateral",
                headers={"X-Spellguard-Channel-Token": "fake-token"},
                json={"sender": "agent-pa"},  # Missing a2aAgentUrl and payload
            )
            assert resp.status_code == 400
            error = resp.json()
            assert "Missing required fields" in error.get("error", "")


# ---------------------------------------------------------------------------
# 4. A2A JSON-RPC Format Validation
# ---------------------------------------------------------------------------


class TestPythonUnilateralA2AValidation:
    async def test_json_rpc_format_validation(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{AGENT_C_URL}/a2a",
                json={
                    "id": "test-invalid",
                    "method": "tasks/send",
                    "params": {},
                    # Missing "jsonrpc": "2.0"
                },
            )
            assert resp.status_code == 400
            error = resp.json()
            assert error["error"]["code"] == -32600  # Invalid Request


# ---------------------------------------------------------------------------
# 5. Verifier Logging Backends
# ---------------------------------------------------------------------------


class TestPythonUnilateralVerifierLogging:
    async def test_logging_backends(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        stats = await get_verifier_stats(VERIFIER_URL)
        assert stats is not None
        assert stats["backends"]["commitment"] in ("memory", "rekor")
        assert stats["backends"]["archive"] in ("memory", "s3")


# ---------------------------------------------------------------------------
# 6. Agent C Standalone Tests
# ---------------------------------------------------------------------------


class TestPythonUnilateralAgentCStandalone:
    @pytest.fixture(scope="class")
    async def agent_c_running(self):
        return await check_server_running(AGENT_C_URL)

    async def test_health_status(self, agent_c_running):
        if not agent_c_running:
            pytest.skip("Agent C not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{AGENT_C_URL}/health")
            assert resp.status_code == 200
            health = resp.json()
            assert health["status"] == "ok"
            assert health["agent"] == "agent-c"
            assert health["type"] == "external-a2a-only"
            assert isinstance(health.get("llmEnabled"), bool)

    async def test_list_available_data(self, agent_c_running):
        if not agent_c_running:
            pytest.skip("Agent C not running")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{AGENT_C_URL}/a2a",
                json={
                    "jsonrpc": "2.0",
                    "id": "test-data",
                    "method": "tasks/send",
                    "params": {
                        "id": "task-data",
                        "message": {
                            "role": "user",
                            "parts": [{"type": "text", "text": "What data do you provide?"}],
                        },
                    },
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            text = data["result"]["artifacts"][0]["parts"][0]["text"]
            assert "weather" in text.lower()
            assert "stock" in text.lower()
