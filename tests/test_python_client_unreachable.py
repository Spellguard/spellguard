# SPDX-License-Identifier: Apache-2.0

"""P0 -- the confabulation fix (Python mirror of
tests/client-unreachable-fanout.test.ts). A referenced-but-UNREACHABLE agent is
surfaced to the model as an explicit "could not reach -- do not fabricate" note,
never dropped to [] (which let the unguarded LLM invent a reply on its behalf)."""

from spellguard_client import ai as sg_ai


def test_context_block_renders_reached_only():
    block = sg_ai.build_agent_context_block(
        [{"agent": "agent-a", "response": "I handle onboarding."}]
    )
    assert "Response from agent-a" in block
    assert "I handle onboarding." in block
    assert "could NOT be reached" not in block


def test_context_block_flags_unreachable_with_do_not_fabricate():
    block = sg_ai.build_agent_context_block(
        [{"agent": "agent-b", "response": "", "unreachable": True}]
    )
    assert "agent-b: UNREACHABLE" in block
    assert "could NOT be reached: agent-b" in block
    assert "Do NOT invent" in block
    # An unreachable agent must NOT render as if it returned a real reply.
    assert "Response from agent-b" not in block


def test_context_block_renders_mixed():
    block = sg_ai.build_agent_context_block(
        [
            {"agent": "agent-a", "response": "A: onboarding"},
            {"agent": "agent-b", "response": "", "unreachable": True},
        ]
    )
    assert "Response from agent-a" in block
    assert "A: onboarding" in block
    assert "could NOT be reached: agent-b" in block
    assert "Do NOT invent" in block


async def test_resolve_returns_unreachable_when_discovery_empty(monkeypatch):
    class _Cfg:
        agent_id = "self-agent"

    # These are imported locally inside resolve_and_collect_agent_responses, so
    # patch them at their SOURCE modules (not on sg_ai).
    monkeypatch.setattr("spellguard_client.attestation.get_config", lambda: _Cfg())
    monkeypatch.setattr(
        "spellguard_client.intent.might_contain_agent_reference", lambda _p: True
    )

    async def _discover_none(_refs):
        return []

    monkeypatch.setattr(
        "spellguard_client.discovery.discover_agents", _discover_none
    )

    async def _detect(_prompt):
        return ["agent-a", "agent-b"]

    out = await sg_ai.resolve_and_collect_agent_responses(
        "ask agent-a and agent-b what they do", _detect
    )
    assert out == [
        {"agent": "agent-a", "response": "", "unreachable": True},
        {"agent": "agent-b", "response": "", "unreachable": True},
    ]


async def test_resolve_returns_empty_when_no_refs(monkeypatch):
    monkeypatch.setattr(
        "spellguard_client.intent.might_contain_agent_reference", lambda _p: False
    )

    async def _detect(_prompt):
        return []

    out = await sg_ai.resolve_and_collect_agent_responses("what is 2 + 2?", _detect)
    assert out == []
