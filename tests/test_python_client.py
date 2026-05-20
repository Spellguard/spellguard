# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the spellguard_client Python package.

Tests intent detection (pattern-matching fallback), discovery helpers,
attestation state management, and type constructors.
"""
import pytest

from spellguard_client.intent import (
    _detect_agent_references_pattern,
    detect_agent_references,
    might_contain_agent_reference,
    set_intent_detection_model,
)
from spellguard_client.attestation import (
    configure,
    get_config,
    reset,
)
from spellguard_client.types import (
    DirectConfig,
    ManagedConfig,
    MessageContext,
    ResolvedAgent,
    SpellguardConfig,
    SpellguardDiscoveryConfig,
    SpellguardOptions,
    UnilateralSendOptions,
)
from spellguard_ctls.types import AgentCard, AgentCardSkill


# =====================================================================
# Intent Detection (pattern matching, no LLM needed)
# =====================================================================


class TestPythonIntentDetection:
    async def test_detect_agent_b(self):
        """'Ask Agent B for help' should detect agent-b."""
        refs = await detect_agent_references("Ask Agent B for help")
        assert "agent-b" in refs

    async def test_detect_analytics_agent(self):
        """'Send to analytics-agent' should detect analytics-agent."""
        refs = await detect_agent_references("Send to analytics-agent")
        assert "analytics-agent" in refs

    async def test_detect_no_agents(self):
        """'hello world' should detect no agents."""
        refs = await detect_agent_references("hello world")
        assert refs == []

    async def test_detect_multiple_agents(self):
        """Multiple agent references should all be detected."""
        refs = await detect_agent_references(
            "Ask Agent C and Agent D to collaborate"
        )
        assert "agent-c" in refs
        assert "agent-d" in refs

    async def test_detect_kebab_case_agent(self):
        """Kebab-case agents should be detected."""
        refs = await detect_agent_references(
            "get data from report-generator"
        )
        assert "report-generator" in refs

    def test_pattern_fallback_agent_x(self):
        result = _detect_agent_references_pattern("Ask Agent B about this")
        assert "agent-b" in result

    def test_pattern_fallback_no_match(self):
        result = _detect_agent_references_pattern("What is the weather?")
        assert result == []


# =====================================================================
# might_contain_agent_reference
# =====================================================================


class TestPythonMightContainAgentRef:
    def test_agent_b_reference(self):
        assert might_contain_agent_reference("Ask Agent B") is True

    def test_kebab_agent_reference(self):
        assert might_contain_agent_reference("the analytics-agent") is True

    def test_no_reference(self):
        assert might_contain_agent_reference("hello world") is False

    def test_from_pattern(self):
        assert might_contain_agent_reference("get from report-gen") is True


# =====================================================================
# Configuration State
# =====================================================================


class TestPythonConfigState:
    def setup_method(self):
        reset()

    def teardown_method(self):
        reset()

    def test_configure_and_get_config(self):
        card = AgentCard(
            name="agent-test",
            url="http://localhost:9999",
            skills=[],
        )
        config = SpellguardConfig(
            agent_id="agent-test",
            verifier_url="http://localhost:3000",
            self_url="http://localhost:9999",
            code_hash="abc123",
            expected_verifier_image_hash="sha384:dev-placeholder",
            agent_card=card,
        )
        configure(config)
        retrieved = get_config()
        assert retrieved is not None
        assert retrieved.agent_id == "agent-test"
        assert retrieved.verifier_url == "http://localhost:3000"

    def test_reset_clears_state(self):
        card = AgentCard(
            name="agent-x",
            url="http://localhost",
            skills=[],
        )
        config = SpellguardConfig(
            agent_id="x",
            verifier_url="http://localhost:3000",
            self_url="http://localhost",
            code_hash="hash",
            expected_verifier_image_hash="sha384:dev-placeholder",
            agent_card=card,
        )
        configure(config)
        assert get_config() is not None
        reset()
        assert get_config() is None


# =====================================================================
# Type Constructors
# =====================================================================


class TestPythonClientTypes:
    def test_spellguard_config(self):
        card = AgentCard(name="a", url="http://a", skills=[])
        config = SpellguardConfig(
            agent_id="agent-a",
            verifier_url="http://verifier",
            self_url="http://a",
            code_hash="h",
            expected_verifier_image_hash="sha384:test",
            agent_card=card,
        )
        assert config.agent_id == "agent-a"
        assert config.agent_secret is None
        assert config.signing_private_key is None

    def test_direct_config(self):
        dc = DirectConfig(
            type="direct",
            agent_id="agent-a",
            verifier_url="http://verifier",
            self_url="http://a",
            code_hash="h",
            expected_verifier_image_hash="sha384:test",
        )
        assert dc.type == "direct"

    def test_managed_config(self):
        mc = ManagedConfig(
            type="managed",
            agent_id="agent-a",
            management_url="http://mgmt/v1",
            self_url="http://a",
            code_hash="h",
        )
        assert mc.type == "managed"
        assert mc.agent_secret is None

    def test_resolved_agent(self):
        card = AgentCard(name="b", url="http://b", skills=[])
        ra = ResolvedAgent(name="agent-b", url="http://b", agent_card=card)
        assert ra.name == "agent-b"

    def test_message_context(self):
        mc = MessageContext(
            message={"text": "hello"},
            sender_id="agent-a",
            model=None,
        )
        assert mc.sender_id == "agent-a"

    def test_unilateral_send_options(self):
        opts = UnilateralSendOptions(method="tasks/send")
        assert opts.method == "tasks/send"

    def test_discovery_config(self):
        card = AgentCard(name="a", url="http://a", skills=[])
        dc = SpellguardDiscoveryConfig(
            agent_id="agent-a",
            management_url="http://mgmt/v1",
            self_url="http://a",
            code_hash="h",
            agent_card=card,
        )
        assert dc.agent_id == "agent-a"
        assert dc.region is None
