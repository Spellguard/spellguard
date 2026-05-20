# SPDX-License-Identifier: Apache-2.0

"""Bilateral integration tests for CrewAI agent (agent-pc).

Tests:
1. Agent PC standalone chat (care-domain query, no routing)
2. Agent PC -> Agent PB bilateral communication
3. Agent PB -> Agent PC bilateral communication

Requires: Verifier server, agent-pb, agent-pc
"""

from __future__ import annotations

import asyncio

import pytest

from tests.conftest import (
    VERIFIER_URL,
    MANAGEMENT_URL,
    MANAGEMENT_ROOT,
    AGENT_PB_URL,
    AGENT_PC_URL,
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
    """Check that core services (Verifier + agent-pb + agent-pc) are running."""
    verifier_ok = await check_server_running(VERIFIER_URL)
    pb_ok = await check_server_running(AGENT_PB_URL)
    pc_ok = await check_server_running(AGENT_PC_URL)

    all_ready = verifier_ok and pb_ok and pc_ok
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


class TestPythonCrewai00Warmup:
    async def test_warmup_pb(self, services_ready):
        """Warm-up: simple ping to agent-pb to prime its LLM connection."""
        if not services_ready:
            pytest.skip("Services not running")
        response = await chat(AGENT_PB_URL, "What is 2 + 2?")
        assert len(response) > 0

    async def test_warmup_pc(self, services_ready):
        """Warm-up: simple ping to agent-pc to prime its CrewAI crew.

        CrewAI cold-starts are very slow (crew init + LLM round-trip), so
        this warmup uses a 240 s timeout — double the default.
        """
        if not services_ready:
            pytest.skip("Services not running")
        response = await chat(AGENT_PC_URL, "What is 2 + 2?", timeout=240.0)
        assert len(response) > 0


# ---------------------------------------------------------------------------
# 1. Standalone Chat (CrewAI crew runs without routing)
# ---------------------------------------------------------------------------


class TestPythonCrewaiSimpleChat:
    async def test_standalone_care_query(self, services_ready):
        """Agent PC handles a care-domain question without routing to other agents."""
        if not services_ready:
            pytest.skip("Services not running")
        response = await chat(
            AGENT_PC_URL,
            "Create a general care plan outline for a patient with chronic hypertension.",
        )
        assert len(response) > 100, f"Expected substantial response, got: {response}"
        lower = response.lower()
        assert any(
            kw in lower
            for kw in ("hypertension", "blood pressure", "care", "patient", "monitor")
        ), f"Expected care-related keywords in: {response[:300]}"


# ---------------------------------------------------------------------------
# 2. Agent PC -> Agent PB (bilateral via CrewAI)
# ---------------------------------------------------------------------------


class TestPythonCrewaiPCToPB:
    async def test_pc_routes_to_pb_bilateral(self, services_ready):
        """Agent PC routes to Agent PB bilaterally via SpellguardRouteTool."""
        if not services_ready:
            pytest.skip("Services not running")

        # Snapshot Verifier state before
        stats_before = await get_verifier_stats(VERIFIER_URL)
        assert stats_before is not None
        commitment_count_before = stats_before["logging"]["commitments"]
        commitments_before = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_before is not None
        before_count = commitments_before["count"]

        # PC -> Verifier -> Agent PB
        response = await chat(
            AGENT_PC_URL,
            "Ask Agent PB for a summary of available data sets and their statistics.",
        )

        # Response should contain data-analysis keywords
        lower = response.lower()
        assert any(
            kw in lower
            for kw in ("data", "statistic", "analysis", "available", "patient")
        ), f"Expected data-related keywords in: {response[:300]}"

        # Flush Verifier reporter and poll for commitment count increase.
        # The reporter may not have queued the commitment before the first
        # flush, so retry a few times with short delays.
        stats_after = None
        for _ in range(3):
            await flush_verifier_reporter(VERIFIER_URL)
            stats_after = await get_verifier_stats(VERIFIER_URL)
            assert stats_after is not None
            if stats_after["logging"]["commitments"] > commitment_count_before:
                break
            await asyncio.sleep(2)

        assert stats_after["logging"]["commitments"] > commitment_count_before

        # New commitments should be bilateral between agent-pc and agent-pb
        commitments_after = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_after is not None
        new_commitments = commitments_after["commitments"][before_count:]
        assert len(new_commitments) > 0

        bilateral = [
            c
            for c in new_commitments
            if c.get("attestationLevel") == "bilateral"
            and c.get("sender") in ("agent-pc", "agent-pb")
            and c.get("recipient") in ("agent-pc", "agent-pb")
        ]
        assert len(bilateral) > 0, (
            "Expected bilateral commitments between agent-pc and agent-pb"
        )


# ---------------------------------------------------------------------------
# 3. Agent PB -> Agent PC (bilateral cross-agent)
# ---------------------------------------------------------------------------


class TestPythonCrewaiBilateralPBToPC:
    async def test_pb_routes_to_pc_bilateral(self, services_ready):
        """Agent PB routes to Agent PC bilaterally."""
        if not services_ready:
            pytest.skip("Services not running")

        # Snapshot Verifier state before
        stats_before = await get_verifier_stats(VERIFIER_URL)
        assert stats_before is not None
        commitment_count_before = stats_before["logging"]["commitments"]
        commitments_before = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_before is not None
        before_count = commitments_before["count"]

        # PB -> Verifier -> Agent PC (CrewAI processing can be slow)
        response = await chat(
            AGENT_PB_URL,
            "Ask Agent PC to create a care coordination summary for our patients.",
            timeout=180.0,
        )

        # Response should contain care-related content
        lower = response.lower()
        assert any(
            kw in lower
            for kw in ("care", "coordination", "summary", "patient", "agent pc")
        ), f"Expected care-related keywords in: {response[:300]}"

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

        # New commitments should be bilateral between agent-pb and agent-pc
        commitments_after = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_after is not None
        new_commitments = commitments_after["commitments"][before_count:]
        assert len(new_commitments) > 0

        bilateral = [
            c
            for c in new_commitments
            if c.get("attestationLevel") == "bilateral"
            and c.get("sender") in ("agent-pb", "agent-pc")
            and c.get("recipient") in ("agent-pb", "agent-pc")
        ]
        assert len(bilateral) > 0, (
            "Expected bilateral commitments between agent-pb and agent-pc"
        )
