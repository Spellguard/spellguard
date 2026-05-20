# SPDX-License-Identifier: Apache-2.0

"""Bilateral integration tests for LangChain agent (agent-pd).

Tests:
1. Agent PD standalone chat (research query, no routing)
2. Agent PD -> Agent B bilateral communication
3. Agent B -> Agent PD bilateral communication

Requires: Verifier server, agent-b (TS), agent-pd (Python/LangChain)
"""

from __future__ import annotations

import asyncio

import pytest

from tests.conftest import (
    VERIFIER_URL,
    MANAGEMENT_URL,
    MANAGEMENT_ROOT,
    AGENT_B_URL,
    AGENT_PD_URL,
    REQUIRE_INTEGRATION,
    check_server_running,
)
from tests.helpers_py.urls import chat, flush_verifier_reporter
from tests.helpers_py.verifier import get_verifier_stats, get_verifier_commitments
from tests.helpers_py.supabase_auth import ensure_supabase_session
from tests.helpers_py.management_api import resolve_test_org_id, org_auth_headers

pytestmark = pytest.mark.integration

SEED_EMAIL = "operator@spellguard.test"
SEED_PASSWORD = "Spellguard123!"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
async def services_ready():
    """Check that core services (Verifier + agent-b + agent-pd) are running."""
    verifier_ok = await check_server_running(VERIFIER_URL)
    b_ok = await check_server_running(AGENT_B_URL)
    pd_ok = await check_server_running(AGENT_PD_URL)

    all_ready = verifier_ok and b_ok and pd_ok
    if not all_ready and REQUIRE_INTEGRATION:
        pytest.fail("Required integration services not running")
    return all_ready


@pytest.fixture(scope="module")
async def management_ready():
    """Check that the management server is running."""
    return await check_server_running(MANAGEMENT_ROOT)


@pytest.fixture(scope="module")
async def management_auth(management_ready):
    """Login to management and resolve test org."""
    if not management_ready:
        pytest.skip("Management server not running")
    session = await ensure_supabase_session(SEED_EMAIL, SEED_PASSWORD)
    if not session:
        pytest.skip("Supabase auth not available")
    token = session["session"]["access_token"]
    org_id = await resolve_test_org_id(token)
    headers = org_auth_headers(token, org_id)
    return token, org_id, headers


# ---------------------------------------------------------------------------
# 0. Warm-up (primes LLM connections so subsequent tests don't cold-start)
# ---------------------------------------------------------------------------


class TestPythonLangchain00Warmup:
    async def test_warmup_b(self, services_ready):
        """Warm-up: simple ping to agent-b to prime its LLM connection."""
        if not services_ready:
            pytest.skip("Services not running")
        response = await chat(AGENT_B_URL, "What is 2 + 2?")
        assert len(response) > 0

    async def test_warmup_pd(self, services_ready):
        """Warm-up: simple ping to agent-pd to prime its LangChain model."""
        if not services_ready:
            pytest.skip("Services not running")
        response = await chat(AGENT_PD_URL, "What is 2 + 2?")
        assert len(response) > 0


# ---------------------------------------------------------------------------
# 1. Standalone Chat (LangChain model runs without routing)
# ---------------------------------------------------------------------------


class TestPythonLangchainSimpleChat:
    async def test_standalone_research_query(self, services_ready):
        """Agent PD handles a research question without routing to other agents."""
        if not services_ready:
            pytest.skip("Services not running")
        response = await chat(
            AGENT_PD_URL,
            "Summarize the key principles of distributed systems.",
        )
        assert len(response) > 100, f"Expected substantial response, got: {response}"
        lower = response.lower()
        assert any(
            kw in lower
            for kw in ("distributed", "system", "consistency", "fault", "network")
        ), f"Expected distributed-systems keywords in: {response[:300]}"


# ---------------------------------------------------------------------------
# 2. Agent PD -> Agent B (bilateral via LangChain)
# ---------------------------------------------------------------------------


class TestPythonLangchainPDToB:
    async def test_pd_routes_to_b_bilateral(self, services_ready):
        """Agent PD routes to Agent B bilaterally via LangChain adapter."""
        if not services_ready:
            pytest.skip("Services not running")

        # Snapshot Verifier state before
        stats_before = await get_verifier_stats(VERIFIER_URL)
        assert stats_before is not None
        commitment_count_before = stats_before["logging"]["commitments"]
        commitments_before = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_before is not None
        before_count = commitments_before["count"]

        # PD -> Verifier -> Agent B
        response = await chat(
            AGENT_PD_URL,
            "Ask Agent B for a summary of available data sets and their statistics.",
        )

        # Response should contain data-analysis keywords
        lower = response.lower()
        assert any(
            kw in lower
            for kw in ("data", "statistic", "analysis", "available", "patient")
        ), f"Expected data-related keywords in: {response[:300]}"

        # Flush Verifier reporter and poll for commitment count increase.
        stats_after = None
        for _ in range(3):
            await flush_verifier_reporter(VERIFIER_URL)
            stats_after = await get_verifier_stats(VERIFIER_URL)
            assert stats_after is not None
            if stats_after["logging"]["commitments"] > commitment_count_before:
                break
            await asyncio.sleep(2)

        assert stats_after["logging"]["commitments"] > commitment_count_before

        # New commitments should be bilateral between agent-pd and agent-b
        commitments_after = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_after is not None
        new_commitments = commitments_after["commitments"][before_count:]
        assert len(new_commitments) > 0

        bilateral = [
            c
            for c in new_commitments
            if c.get("attestationLevel") == "bilateral"
            and c.get("sender") in ("agent-pd", "agent-b")
            and c.get("recipient") in ("agent-pd", "agent-b")
        ]
        assert len(bilateral) > 0, (
            "Expected bilateral commitments between agent-pd and agent-b"
        )


# ---------------------------------------------------------------------------
# 3. Agent B -> Agent PD (bilateral cross-agent)
# ---------------------------------------------------------------------------


class TestPythonLangchainBilateralBToPD:
    async def test_b_routes_to_pd_bilateral(self, services_ready):
        """Agent B routes to Agent PD bilaterally."""
        if not services_ready:
            pytest.skip("Services not running")

        # Snapshot Verifier state before
        stats_before = await get_verifier_stats(VERIFIER_URL)
        assert stats_before is not None
        commitment_count_before = stats_before["logging"]["commitments"]
        commitments_before = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_before is not None
        before_count = commitments_before["count"]

        # B -> Verifier -> Agent PD
        response = await chat(
            AGENT_B_URL,
            "Ask Agent PD to summarize the key trends in our patient data.",
            timeout=180.0,
        )

        # Response should contain research-related content
        lower = response.lower()
        assert any(
            kw in lower
            for kw in ("patient", "data", "trend", "summary", "agent pd", "research")
        ), f"Expected research-related keywords in: {response[:300]}"

        # Flush Verifier reporter and poll for commitment count increase.
        stats_after = None
        for _ in range(3):
            await flush_verifier_reporter(VERIFIER_URL)
            stats_after = await get_verifier_stats(VERIFIER_URL)
            assert stats_after is not None
            if stats_after["logging"]["commitments"] > commitment_count_before:
                break
            await asyncio.sleep(2)

        assert stats_after["logging"]["commitments"] > commitment_count_before

        # New commitments should be bilateral between agent-b and agent-pd
        commitments_after = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_after is not None
        new_commitments = commitments_after["commitments"][before_count:]
        assert len(new_commitments) > 0

        bilateral = [
            c
            for c in new_commitments
            if c.get("attestationLevel") == "bilateral"
            and c.get("sender") in ("agent-b", "agent-pd")
            and c.get("recipient") in ("agent-b", "agent-pd")
        ]
        assert len(bilateral) > 0, (
            "Expected bilateral commitments between agent-b and agent-pd"
        )
