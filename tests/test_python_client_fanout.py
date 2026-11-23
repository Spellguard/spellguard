# SPDX-License-Identifier: Apache-2.0

"""Peer fan-out for the Python client — mirrors tests/client-concurrency.test.ts,
tests/client-fanout-partial.test.ts and tests/client-fanout-concurrency.test.ts.
Covers (a) bounded parallel dispatch (order-preserving, capped, and — finding
§11 — CONFIGURABLE with the previous hard-coded 1 as its default) and (b)
partial tolerance: one peer's transient failure must not discard another peer's
reply, while a genuine policy block still propagates (never answered from the
unguarded path)."""

import asyncio

import pytest

from spellguard_client import ai as sg_ai
from spellguard_client.types import ResolvedAgent


def _agent(name: str) -> ResolvedAgent:
    # agent_card is unused — _send_to_agent is fully mocked in every test.
    return ResolvedAgent(name=name, url="verifier-routed", agent_card=None)  # type: ignore[arg-type]


def _patch_channel(monkeypatch):
    class _Cfg:
        agent_id = "self-agent"

    async def _channel():
        return object()

    monkeypatch.setattr(
        "spellguard_client.attestation.get_or_create_channel", _channel
    )
    monkeypatch.setattr(
        "spellguard_client.attestation.get_config", lambda: _Cfg()
    )


async def _instant_sleep(_delay):
    """Drop-in for asyncio.sleep so the 5s/10s transient backoff is instant."""
    return None


# ── Bounded parallel dispatch ──────────────────────────────────────────────


async def test_fan_out_is_sequential_and_preserves_order(monkeypatch):
    _patch_channel(monkeypatch)
    completed: list[str] = []

    async def fake_send(channel, agent, prompt, from_agent_id, timeout_ms=None):
        # 'a' is slower. Under the default SEQUENTIAL dispatch (width 1) 'a'
        # runs to completion before 'b' starts, so 'a' finishes FIRST despite
        # being slower (under parallel dispatch 'b' would have finished first).
        await asyncio.sleep(0.05 if agent.name == "a" else 0.01)
        completed.append(agent.name)
        return f"reply-from-{agent.name}"

    monkeypatch.setattr(sg_ai, "_send_to_agent", fake_send)

    out = await sg_ai._collect_agent_responses([_agent("a"), _agent("b")], "hi")

    assert [r["agent"] for r in out] == ["a", "b"]  # input order preserved
    assert out[0]["response"] == "reply-from-a"
    assert completed == ["a", "b"]  # 'a' finished first → sequential


async def _peak_in_flight(monkeypatch, peer_count: int) -> int:
    """Run a fan-out over `peer_count` peers; return the peak overlap."""
    _patch_channel(monkeypatch)
    active = 0
    peak = 0

    async def fake_send(channel, agent, prompt, from_agent_id, timeout_ms=None):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return "ok"

    monkeypatch.setattr(sg_ai, "_send_to_agent", fake_send)

    await sg_ai._collect_agent_responses(
        [_agent(f"a{i}") for i in range(peer_count)], "hi"
    )
    return peak


async def test_fan_out_runs_one_at_a_time_by_default(monkeypatch):
    monkeypatch.delenv(sg_ai._FANOUT_CONCURRENCY_ENV, raising=False)
    peak = await _peak_in_flight(monkeypatch, 13)
    # Sequential: one in flight — and that IS the resolved default, not a
    # hard-coded literal the resolver could have drifted away from.
    assert peak == sg_ai._resolve_fanout_concurrency() == 1
    assert sg_ai._DEFAULT_FANOUT_CONCURRENCY == 1


async def test_fan_out_width_is_configurable(monkeypatch):
    """Finding §11: the fan-out width plumbs through from configuration."""
    monkeypatch.setenv(sg_ai._FANOUT_CONCURRENCY_ENV, "4")
    assert sg_ai._resolve_fanout_concurrency() == 4
    peak = await _peak_in_flight(monkeypatch, 12)
    assert peak == 4


@pytest.mark.parametrize(
    "junk",
    [
        "",
        "abc",
        "0",
        "-3",
        "2.5",
        # `"\u00b2".isdigit()` is True but `int("\u00b2")` RAISES -- the exception
        # escaped the resolver and broke the fan-out outright.
        "\u00b2",
        # Arabic-Indic 3: `int()` parses it as 3, but the TS twin's `/^\d+$/`
        # rejects it. Both SDKs must answer identically.
        "\u0663",
    ],
)
async def test_fan_out_width_falls_back_to_default_on_junk(monkeypatch, junk):
    monkeypatch.setenv(sg_ai._FANOUT_CONCURRENCY_ENV, junk)
    assert (
        sg_ai._resolve_fanout_concurrency() == sg_ai._DEFAULT_FANOUT_CONCURRENCY
    )


# ── Partial tolerance ──────────────────────────────────────────────────────


async def test_fan_out_marks_transient_failure_unreachable(monkeypatch):
    _patch_channel(monkeypatch)
    monkeypatch.setattr(asyncio, "sleep", _instant_sleep)

    async def fake_send(channel, agent, prompt, from_agent_id, timeout_ms=None):
        if agent.name == "agent-b":
            raise RuntimeError("SLIM delivery to agent-b failed: failed to deliver")
        return "A: records"

    monkeypatch.setattr(sg_ai, "_send_to_agent", fake_send)

    out = await sg_ai._collect_agent_responses(
        [_agent("agent-a"), _agent("agent-b")], "hi"
    )
    # agent-b is surfaced as unreachable, NOT dropped — so the model is told,
    # never left to fabricate a reply on its behalf.
    assert out == [
        {"agent": "agent-a", "response": "A: records"},
        {"agent": "agent-b", "response": "", "unreachable": True},
    ]


async def test_fan_out_marks_all_unreachable_when_all_transient(monkeypatch):
    _patch_channel(monkeypatch)
    monkeypatch.setattr(asyncio, "sleep", _instant_sleep)

    async def fake_send(channel, agent, prompt, from_agent_id, timeout_ms=None):
        raise RuntimeError("failed to deliver")

    monkeypatch.setattr(sg_ai, "_send_to_agent", fake_send)

    out = await sg_ai._collect_agent_responses(
        [_agent("agent-a"), _agent("agent-b")], "hi"
    )
    assert out == [
        {"agent": "agent-a", "response": "", "unreachable": True},
        {"agent": "agent-b", "response": "", "unreachable": True},
    ]


async def test_fan_out_propagates_policy_block(monkeypatch):
    _patch_channel(monkeypatch)
    monkeypatch.setattr(asyncio, "sleep", _instant_sleep)

    async def fake_send(channel, agent, prompt, from_agent_id, timeout_ms=None):
        if agent.name == "agent-b":
            raise RuntimeError("Blocked by policy: content violation")
        return "A ok"

    monkeypatch.setattr(sg_ai, "_send_to_agent", fake_send)

    with pytest.raises(RuntimeError, match="Blocked by policy"):
        await sg_ai._collect_agent_responses(
            [_agent("agent-a"), _agent("agent-b")], "hi"
        )


async def test_fan_out_tolerates_fail_closed(monkeypatch):
    _patch_channel(monkeypatch)
    monkeypatch.setattr(asyncio, "sleep", _instant_sleep)

    async def fake_send(channel, agent, prompt, from_agent_id, timeout_ms=None):
        if agent.name == "agent-b":
            raise RuntimeError("Blocked: policy data unavailable (fail-closed)")
        return "A ok"

    monkeypatch.setattr(sg_ai, "_send_to_agent", fake_send)

    out = await sg_ai._collect_agent_responses(
        [_agent("agent-a"), _agent("agent-b")], "hi"
    )
    assert out == [
        {"agent": "agent-a", "response": "A ok"},
        {"agent": "agent-b", "response": "", "unreachable": True},
    ]


# ── Gap A: per-turn time budget (never overrun the proxy's 60s /chat) ──


async def test_fan_out_bounds_each_send_with_a_budget_timeout(monkeypatch):
    _patch_channel(monkeypatch)
    seen: dict[str, float | None] = {}

    async def fake_send(channel, agent, prompt, from_agent_id, timeout_ms=None):
        seen[agent.name] = timeout_ms
        return "ok"

    monkeypatch.setattr(sg_ai, "_send_to_agent", fake_send)

    await sg_ai._collect_agent_responses(
        [_agent("agent-a"), _agent("agent-b")], "hi"
    )
    for peer in ("agent-a", "agent-b"):
        assert seen[peer] is not None
        assert 0 < seen[peer] <= sg_ai._FANOUT_PEER_TIMEOUT_S * 1000
