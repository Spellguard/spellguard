# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for spellguard_client.usage_telemetry — the self-reported token-usage emit,
Python mirror of the TS usage-telemetry.ts.

Covers the load-bearing trust-boundary rules: fail-open (never raises), correct
camelCase wire shape, all-zero events dropped, negative counts clamped, and that
the emit skips when the agent has no secret / no management URL. No network: the
httpx client is mocked.
"""
import os

import pytest

from spellguard_client.attestation import configure, reset
from spellguard_client.types import SpellguardConfig
from spellguard_client.usage_telemetry import (
    UsageEvent,
    report_usage_async,
    report_usage_event,
    report_openai_usage,
    usage_event_from_openai,
)
from spellguard_ctls.types import AgentCard


def _configured(agent_id="agent-x", agent_secret="sek", management_url="https://mgmt.example.com"):
    reset()
    card = AgentCard(name="a", url="http://a", skills=[])
    configure(
        SpellguardConfig(
            agent_id=agent_id,
            verifier_url="http://localhost:3000",
            self_url="http://localhost:9999",
            code_hash="abc",
            expected_verifier_image_hash="sha384:dev-placeholder",
            agent_card=card,
            agent_secret=agent_secret,
            management_url=management_url,
        )
    )


class _FakeAsyncClient:
    """Records the single POST it receives; mimics httpx.AsyncClient.post."""

    def __init__(self, *, raise_exc: Exception | None = None):
        self.calls: list[dict] = []
        self._raise = raise_exc

    async def post(self, url, *, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        if self._raise is not None:
            raise self._raise
        return None


class _Usage:
    def __init__(self, p, c, t):
        self.prompt_tokens = p
        self.completion_tokens = c
        self.total_tokens = t


class _Response:
    def __init__(self, usage):
        self.usage = usage


class TestPythonUsageTelemetryWire:
    @pytest.mark.asyncio
    async def test_posts_camelcase_to_correct_url(self):
        _configured()
        client = _FakeAsyncClient()
        await report_usage_async(
            UsageEvent("openai/gpt-4.1-mini", 10, 5, 15),
            http_client=client,
        )
        assert len(client.calls) == 1
        call = client.calls[0]
        assert call["url"] == "https://mgmt.example.com/v1/agents/agent-x/usage"
        assert call["headers"]["Authorization"] == "Bearer sek"
        body = call["json"]["events"][0]
        # camelCase ONLY — the Zod schema rejects snake_case.
        assert body == {
            "model": "openai/gpt-4.1-mini",
            "promptTokens": 10,
            "completionTokens": 5,
            "totalTokens": 15,
        }
        reset()

    @pytest.mark.asyncio
    async def test_strips_v1_suffix_from_management_url(self):
        _configured(management_url="https://mgmt.example.com/v1")
        client = _FakeAsyncClient()
        await report_usage_async(UsageEvent("m", 1, 1, 2), http_client=client)
        assert client.calls[0]["url"] == "https://mgmt.example.com/v1/agents/agent-x/usage"
        reset()

    @pytest.mark.asyncio
    async def test_optional_cached_and_reasoning_tokens_included_when_positive(self):
        _configured()
        client = _FakeAsyncClient()
        await report_usage_async(
            UsageEvent("m", 10, 5, 15, cached_input_tokens=3, reasoning_tokens=2),
            http_client=client,
        )
        body = client.calls[0]["json"]["events"][0]
        assert body["cachedInputTokens"] == 3
        assert body["reasoningTokens"] == 2
        reset()


class TestPythonUsageTelemetryGuards:
    @pytest.mark.asyncio
    async def test_all_zero_event_dropped(self):
        _configured()
        client = _FakeAsyncClient()
        await report_usage_async(UsageEvent("m", 0, 0, 0), http_client=client)
        assert client.calls == []
        reset()

    @pytest.mark.asyncio
    async def test_negative_counts_clamped(self):
        _configured()
        client = _FakeAsyncClient()
        await report_usage_async(UsageEvent("m", -5, 7, -1), http_client=client)
        body = client.calls[0]["json"]["events"][0]
        assert body["promptTokens"] == 0
        assert body["completionTokens"] == 7
        assert body["totalTokens"] == 0
        reset()

    @pytest.mark.asyncio
    async def test_skips_when_no_agent_secret(self):
        _configured(agent_secret=None)
        client = _FakeAsyncClient()
        await report_usage_async(UsageEvent("m", 10, 5, 15), http_client=client)
        assert client.calls == []
        reset()

    @pytest.mark.asyncio
    async def test_skips_when_no_management_url(self, monkeypatch):
        monkeypatch.delenv("SPELLGUARD_MANAGEMENT_URL", raising=False)
        monkeypatch.delenv("SPELLGUARD_BASE_URL", raising=False)
        _configured(management_url=None)
        client = _FakeAsyncClient()
        await report_usage_async(UsageEvent("m", 10, 5, 15), http_client=client)
        assert client.calls == []
        reset()

    @pytest.mark.asyncio
    async def test_env_fallback_for_management_url(self, monkeypatch):
        monkeypatch.setenv("SPELLGUARD_MANAGEMENT_URL", "https://env-mgmt.example.com")
        _configured(management_url=None)
        client = _FakeAsyncClient()
        await report_usage_async(UsageEvent("m", 1, 1, 2), http_client=client)
        assert client.calls[0]["url"] == "https://env-mgmt.example.com/v1/agents/agent-x/usage"
        reset()


class TestPythonUsageTelemetryFailOpen:
    @pytest.mark.asyncio
    async def test_httpx_exception_never_propagates(self):
        _configured()
        client = _FakeAsyncClient(raise_exc=RuntimeError("network down"))
        # Must NOT raise — fail-open is the whole point (§6.2).
        await report_usage_async(UsageEvent("m", 10, 5, 15), http_client=client)
        reset()

    @pytest.mark.asyncio
    async def test_report_usage_event_fire_and_forget_awaits_cleanly(self):
        _configured()
        client = _FakeAsyncClient()
        task = report_usage_event(UsageEvent("m", 10, 5, 15), http_client=client)
        # Inside a running loop → a Task is scheduled; awaiting it must not raise.
        assert task is not None
        await task
        assert len(client.calls) == 1
        reset()

    @pytest.mark.asyncio
    async def test_report_usage_event_none_is_noop(self):
        _configured()
        assert report_usage_event(None) is None
        reset()


class TestPythonUsageTelemetryOpenAIExtraction:
    def test_usage_event_from_openai_reads_snake_case(self):
        ev = usage_event_from_openai(_Response(_Usage(12, 8, 20)), "openai/gpt-4o")
        assert ev is not None
        assert (ev.prompt_tokens, ev.completion_tokens, ev.total_tokens) == (12, 8, 20)
        assert ev.model == "openai/gpt-4o"

    def test_usage_event_from_openai_none_when_no_usage(self):
        assert usage_event_from_openai(_Response(None), "m") is None

    @pytest.mark.asyncio
    async def test_report_openai_usage_end_to_end(self):
        _configured()
        client = _FakeAsyncClient()
        task = report_openai_usage(_Response(_Usage(3, 4, 7)), "m", http_client=client)
        if task is not None:
            await task
        assert client.calls[0]["json"]["events"][0]["totalTokens"] == 7
        reset()
