# SPDX-License-Identifier: Apache-2.0

"""Bilateral integration tests for Python agents.

Mirrors tests/bilateral-integration.test.ts using Python agents (agent-pa,
agent-pb) instead of TypeScript agents (agent-a, agent-b).

Tests:
1. Simple AI call (no routing)
2. Agent PA -> Agent B bilateral communication with audit trail
3. Agent B -> Agent PA cross-agent communication
4. Verifier logging backends
5. Attestation categorization (bilateral vs unilateral)

NOTE: Policy enforcement tests that require the management server have been
moved to tests/test_python_bilateral_policy_integration.py so OSS builds
(which never run management) don't print skip noise.

Requires: Verifier server, agent-pa, agent-pb, agent-a, agent-b
"""

from __future__ import annotations

import pytest

from tests.conftest import (
    VERIFIER_URL,
    AGENT_PA_URL,
    AGENT_PB_URL,
    AGENT_A_URL,
    AGENT_B_URL,
    REQUIRE_INTEGRATION,
    check_server_running,
)
from tests.helpers_py.urls import chat
from tests.helpers_py.verifier import get_verifier_stats, get_verifier_commitments

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
async def services_ready():
    """Check that core services (Verifier + agents) are running."""
    verifier_ok = await check_server_running(VERIFIER_URL)
    pa_ok = await check_server_running(AGENT_PA_URL)
    pb_ok = await check_server_running(AGENT_PB_URL)
    a_ok = await check_server_running(AGENT_A_URL)
    b_ok = await check_server_running(AGENT_B_URL)

    all_ready = verifier_ok and pa_ok and pb_ok and a_ok and b_ok
    if not all_ready and REQUIRE_INTEGRATION:
        pytest.fail("Required integration services not running")
    return all_ready


# ---------------------------------------------------------------------------
# 1. Simple AI Call (No Agent Routing)
# ---------------------------------------------------------------------------


class TestPythonBilateralSimpleAI:
    async def test_simple_math_no_routing(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")
        response = await chat(AGENT_PA_URL, "What is 2 + 2?")
        assert "4" in response or "four" in response.lower()
        assert "agent b" not in response.lower()


# ---------------------------------------------------------------------------
# 2. Agent PA -> Agent B (bilateral with audit trail)
# ---------------------------------------------------------------------------


class TestPythonBilateralPAToB:
    async def test_salary_request_bilateral_audit_trail(self, services_ready):
        """PA asks Agent B for salary stats; verify response and Verifier audit trail."""
        if not services_ready:
            pytest.skip("Services not running")

        # Snapshot Verifier state before
        stats_before = await get_verifier_stats(VERIFIER_URL)
        assert stats_before is not None
        commitment_count_before = stats_before["logging"]["commitments"]
        commitments_before = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_before is not None
        before_count = commitments_before["count"]

        # PA -> Verifier -> Agent B
        response = await chat(
            AGENT_PA_URL,
            "Ask Agent B what confidential data sets it has available and get "
            "a summary of the employee salary statistics.",
        )

        # Response should contain salary-related content
        lower = response.lower()
        assert any(
            kw in lower for kw in ("salary", "salaries", "employee", "statistic")
        ), f"Expected salary keywords in: {response[:300]}"
        assert any(ch.isdigit() for ch in response)

        # Commitment count should have increased
        stats_after = await get_verifier_stats(VERIFIER_URL)
        assert stats_after is not None
        assert stats_after["logging"]["commitments"] > commitment_count_before

        # New commitments should be bilateral between agent-pa and agent-b
        commitments_after = await get_verifier_commitments(VERIFIER_URL)
        assert commitments_after is not None
        new_commitments = commitments_after["commitments"][before_count:]
        assert len(new_commitments) > 0

        bilateral = [
            c
            for c in new_commitments
            if c.get("attestationLevel") == "bilateral"
            and c.get("sender") in ("agent-pa", "agent-b")
            and c.get("recipient") in ("agent-pa", "agent-b")
        ]
        assert len(bilateral) > 0, "Expected bilateral commitments between agent-pa and agent-b"


# ---------------------------------------------------------------------------
# 3. Agent B -> Agent PA (cross-agent)
# ---------------------------------------------------------------------------


class TestPythonBilateralBToPA:
    async def test_medication_lookup_cross_agent(self, services_ready):
        """Agent B asks Agent PA for Benjamin Blake's medications."""
        if not services_ready:
            pytest.skip("Services not running")

        response = await chat(
            AGENT_B_URL,
            "What medications is Benjamin Blake taking? Please get this from Agent PA.",
        )
        lower = response.lower()
        assert any(
            kw in lower
            for kw in ("ibuprofen", "medication", "benjamin", "blake")
        ), f"Expected medication keywords in: {response[:300]}"


# ---------------------------------------------------------------------------
# 4. Verifier Logging Backends
# ---------------------------------------------------------------------------


class TestPythonBilateralVerifierLogging:
    async def test_logging_backends(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")

        stats = await get_verifier_stats(VERIFIER_URL)
        assert stats is not None

        assert stats["backends"]["commitment"] in ("memory", "rekor")
        assert stats["backends"]["archive"] in ("memory", "s3")


# ---------------------------------------------------------------------------
# 5. Attestation Categorization
# ---------------------------------------------------------------------------


class TestPythonBilateralAttestationCategorization:
    async def test_bilateral_vs_unilateral_distinction(self, services_ready):
        if not services_ready:
            pytest.skip("Services not running")

        all_commitments = await get_verifier_commitments(VERIFIER_URL)
        assert all_commitments is not None

        commitments = all_commitments["commitments"]
        bilateral = [c for c in commitments if c.get("attestationLevel") == "bilateral"]
        unilateral = [c for c in commitments if c.get("attestationLevel") == "unilateral"]
        none_level = [c for c in commitments if c.get("attestationLevel") == "none"]

        # No 'none' attestation level
        assert len(none_level) == 0, "Should have no 'none' attestation commitments"

        # Unilateral commitments should have A2A-specific fields
        for c in unilateral:
            assert "a2aAgentUrl" in c, f"Unilateral commitment missing a2aAgentUrl: {c}"
            assert "direction" in c, f"Unilateral commitment missing direction: {c}"
            assert "correlationId" in c, f"Unilateral commitment missing correlationId: {c}"

        print(
            f"[Attestation Categorization] Bilateral: {len(bilateral)}, "
            f"Unilateral: {len(unilateral)}"
        )
