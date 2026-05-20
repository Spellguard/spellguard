# SPDX-License-Identifier: Apache-2.0

"""Tests for @mention intent detection fix in Python client."""

import pytest

from spellguard_client.intent import (
    detect_agent_references,
    might_contain_agent_reference,
    set_intent_detect_fn,
)
import spellguard_client.intent as _intent_mod


class TestPythonMightContainAgentReference:
    def test_detects_at_agent_name_mentions(self):
        assert might_contain_agent_reference("consult @data-fetcher for stats") is True
        assert might_contain_agent_reference("ask @agent-b about this") is True
        assert might_contain_agent_reference("@report-gen please run") is True

    def test_detects_consult_verb(self):
        assert might_contain_agent_reference("consult data-fetcher for stats") is True
        assert might_contain_agent_reference("consult agent-b about this") is True

    def test_detects_consult_at_agent_name(self):
        assert might_contain_agent_reference("consult @data-fetcher for stats") is True

    def test_still_detects_existing_patterns(self):
        assert might_contain_agent_reference("ask Agent B about this") is True
        assert might_contain_agent_reference("use the analytics-agent") is True
        assert might_contain_agent_reference("get data from data-fetcher") is True
        assert might_contain_agent_reference("tell report-gen to run") is True

    def test_returns_false_for_non_agent_prompts(self):
        assert might_contain_agent_reference("hello world") is False
        assert might_contain_agent_reference("what is 2+2?") is False
        assert might_contain_agent_reference("I need help with my code") is False


class TestPythonDetectAgentReferences:
    @pytest.mark.asyncio
    async def test_detects_at_agent_name_mentions(self):
        result = await detect_agent_references("consult @data-fetcher for stats")
        assert "data-fetcher" in result

    @pytest.mark.asyncio
    async def test_detects_multiple_at_mentions(self):
        result = await detect_agent_references("ask @agent-b and @agent-c")
        assert "agent-b" in result
        assert "agent-c" in result

    @pytest.mark.asyncio
    async def test_detects_at_mention_with_multi_segment_name(self):
        result = await detect_agent_references("ping @my-cool-agent please")
        assert "my-cool-agent" in result

    @pytest.mark.asyncio
    async def test_detects_consult_agent_name(self):
        result = await detect_agent_references("consult data-fetcher for stats")
        assert "data-fetcher" in result

    @pytest.mark.asyncio
    async def test_detects_consult_at_agent_name(self):
        result = await detect_agent_references("consult @data-fetcher for stats")
        assert "data-fetcher" in result

    @pytest.mark.asyncio
    async def test_no_duplicates_when_matching_multiple_patterns(self):
        result = await detect_agent_references("consult @data-fetcher for stats")
        assert result.count("data-fetcher") == 1

    @pytest.mark.asyncio
    async def test_still_detects_existing_patterns(self):
        result = await detect_agent_references("ask Agent B about this")
        assert "agent-b" in result

        result = await detect_agent_references("use the analytics-agent")
        assert "analytics-agent" in result

        result = await detect_agent_references("get data from data-fetcher")
        assert "data-fetcher" in result

        result = await detect_agent_references("send to report-gen the results")
        assert "report-gen" in result

    @pytest.mark.asyncio
    async def test_returns_empty_for_non_agent_prompts(self):
        assert await detect_agent_references("hello world") == []
        assert await detect_agent_references("what is 2+2?") == []


class TestPythonDetectFallbackToPatterns:
    """When custom detect fn returns empty, pattern matching should kick in."""

    def _reset(self):
        _intent_mod._intent_detect_fn = None

    @pytest.mark.asyncio
    async def test_falls_back_when_custom_fn_returns_empty(self):
        async def empty_fn(_prompt: str) -> list[str]:
            return []

        set_intent_detect_fn(empty_fn)
        try:
            result = await detect_agent_references("ask agent-c about the weather")
            assert "agent-c" in result
        finally:
            self._reset()

    @pytest.mark.asyncio
    async def test_falls_back_for_at_mention_when_custom_fn_returns_empty(self):
        async def empty_fn(_prompt: str) -> list[str]:
            return []

        set_intent_detect_fn(empty_fn)
        try:
            result = await detect_agent_references("consult @data-fetcher for stats")
            assert "data-fetcher" in result
        finally:
            self._reset()

    @pytest.mark.asyncio
    async def test_uses_custom_fn_result_when_non_empty(self):
        async def custom_fn(_prompt: str) -> list[str]:
            return ["custom-agent"]

        set_intent_detect_fn(custom_fn)
        try:
            result = await detect_agent_references("ask agent-c about the weather")
            assert result == ["custom-agent"]
        finally:
            self._reset()

    @pytest.mark.asyncio
    async def test_falls_back_when_custom_fn_throws(self):
        async def failing_fn(_prompt: str) -> list[str]:
            raise RuntimeError("AI model error")

        set_intent_detect_fn(failing_fn)
        try:
            result = await detect_agent_references("ask agent-c about the weather")
            assert "agent-c" in result
        finally:
            self._reset()
