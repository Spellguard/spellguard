# SPDX-License-Identifier: Apache-2.0

"""
Tests for Python tool policy wrappers: check_tool_policy and spellguard_tool.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from spellguard_client.attestation import ToolCheckResult, check_tool_policy
from spellguard_client.ai import spellguard_tool


class TestPythonToolCheckResult:
    """ToolCheckResult dataclass tests."""

    def test_default_values(self):
        result = ToolCheckResult(effect="allow")
        assert result.effect == "allow"
        assert result.message is None
        assert result.data is None

    def test_block_with_message(self):
        result = ToolCheckResult(effect="block", message="Secrets detected")
        assert result.effect == "block"
        assert result.message == "Secrets detected"

    def test_redact_with_data(self):
        result = ToolCheckResult(effect="redact", data=None)
        assert result.effect == "redact"
        assert result.data is None


class TestPythonCheckToolPolicy:
    """check_tool_policy() tests."""

    @pytest.mark.asyncio
    async def test_fails_open_when_no_channel(self):
        """When no channel is configured, check_tool_policy should fail open."""
        # get_or_create_channel will raise since nothing is configured
        result = await check_tool_policy("input", "testTool", {"key": "value"})
        assert result.effect == "allow"

    @pytest.mark.asyncio
    async def test_fails_open_on_exception(self):
        """Network errors should result in allow (fail-open)."""
        with patch(
            "spellguard_client.attestation.get_or_create_channel",
            side_effect=RuntimeError("Connection refused"),
        ):
            result = await check_tool_policy("output", "testTool", result="data")
            assert result.effect == "allow"


class TestPythonSpellguardTool:
    """spellguard_tool() wrapper tests."""

    @pytest.mark.asyncio
    async def test_passes_through_on_allow(self):
        """When both phases allow, the tool result passes through."""

        async def my_tool(params):
            return {"data": "result"}

        wrapped = spellguard_tool(my_tool, name="myTool")

        with patch(
            "spellguard_client.attestation.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="allow"),
        ):
            result = await wrapped({"key": "value"})
            assert result == {"data": "result"}

    @pytest.mark.asyncio
    async def test_blocks_on_input(self):
        """Block on input phase prevents execution."""

        execute_called = False

        async def my_tool(params):
            nonlocal execute_called
            execute_called = True
            return "should-not-run"

        wrapped = spellguard_tool(my_tool, name="myTool")

        with patch(
            "spellguard_client.attestation.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(
                effect="block", message="Blocked by policy"
            ),
        ):
            result = await wrapped({"key": "value"})
            assert result == "Blocked by policy"
            assert not execute_called

    @pytest.mark.asyncio
    async def test_input_redact_as_block(self):
        """Redact on input phase is treated as block."""

        execute_called = False

        async def my_tool(params):
            nonlocal execute_called
            execute_called = True
            return "should-not-run"

        wrapped = spellguard_tool(my_tool, name="myTool")

        with patch(
            "spellguard_client.attestation.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="redact"),
        ):
            result = await wrapped({"key": "value"})
            assert result == "[BLOCKED]"
            assert not execute_called

    @pytest.mark.asyncio
    async def test_blocks_on_output(self):
        """Block on output phase returns the block message."""

        async def my_tool(params):
            return {"sensitive": "data"}

        wrapped = spellguard_tool(my_tool, name="myTool")

        call_count = 0

        async def mock_check(phase, name, params=None, result=None):
            nonlocal call_count
            call_count += 1
            if phase == "input":
                return ToolCheckResult(effect="allow")
            return ToolCheckResult(effect="block", message="PHI detected")

        with patch("spellguard_client.attestation.check_tool_policy", side_effect=mock_check):
            result = await wrapped({"key": "value"})
            assert result == "PHI detected"

    @pytest.mark.asyncio
    async def test_redacts_output(self):
        """Redact on output phase returns redacted data."""

        async def my_tool(params):
            return {"sensitive": "data"}

        wrapped = spellguard_tool(my_tool, name="myTool")

        call_count = 0

        async def mock_check(phase, name, params=None, result=None):
            nonlocal call_count
            call_count += 1
            if phase == "input":
                return ToolCheckResult(effect="allow")
            return ToolCheckResult(effect="redact", data=None)

        with patch("spellguard_client.attestation.check_tool_policy", side_effect=mock_check):
            result = await wrapped({"key": "value"})
            assert result is None

    @pytest.mark.asyncio
    async def test_flag_passes_through(self):
        """Flag effect lets the result through."""

        async def my_tool(params):
            return "flagged-result"

        wrapped = spellguard_tool(my_tool, name="myTool")

        with patch(
            "spellguard_client.attestation.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="flag"),
        ):
            result = await wrapped({"key": "value"})
            assert result == "flagged-result"

    def test_preserves_function_name(self):
        """spellguard_tool preserves the function name."""

        async def my_custom_tool(params):
            return "result"

        wrapped = spellguard_tool(my_custom_tool, name="customName")
        assert wrapped.__name__ == "customName"

    def test_infers_name_from_function(self):
        """When name is not provided, infers from function."""

        async def auto_named_tool(params):
            return "result"

        wrapped = spellguard_tool(auto_named_tool)
        assert wrapped.__name__ == "auto_named_tool"
