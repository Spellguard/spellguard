# SPDX-License-Identifier: Apache-2.0

"""
Tests for SpellguardCheckedTool (CrewAI BaseTool with policy checks).

Mocks check_tool_policy to verify the wrapper handles all effect paths.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from spellguard_client.attestation import ToolCheckResult
from spellguard_crewai.checked_tool import SpellguardCheckedTool


class _MockTool(SpellguardCheckedTool):
    """Concrete test subclass."""

    name: str = "testTool"
    description: str = "A test tool"
    _execute_called: bool = False
    _execute_return: str = "real-result"

    def _execute(self, **kwargs: Any) -> str:
        self._execute_called = True
        return self._execute_return


class TestPythonCrewaiCheckedTool:
    """SpellguardCheckedTool tests."""

    @pytest.mark.asyncio
    async def test_passes_through_on_allow(self):
        tool = _MockTool()
        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="allow"),
        ):
            result = await tool._checked_execute({"key": "val"})
            assert result == "real-result"
            assert tool._execute_called

    @pytest.mark.asyncio
    async def test_blocks_on_input(self):
        tool = _MockTool()
        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="block", message="Blocked"),
        ):
            result = await tool._checked_execute({"key": "val"})
            assert result == "Blocked"
            assert not tool._execute_called

    @pytest.mark.asyncio
    async def test_input_redact_as_block(self):
        tool = _MockTool()
        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="redact"),
        ):
            result = await tool._checked_execute({"key": "val"})
            assert result == "[BLOCKED]"
            assert not tool._execute_called

    @pytest.mark.asyncio
    async def test_blocks_on_output(self):
        tool = _MockTool()
        call_count = 0

        async def mock_check(phase, name, params=None, result=None):
            nonlocal call_count
            call_count += 1
            if phase == "input":
                return ToolCheckResult(effect="allow")
            return ToolCheckResult(effect="block", message="PHI detected")

        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy",
            side_effect=mock_check,
        ):
            result = await tool._checked_execute({"key": "val"})
            assert result == "PHI detected"
            assert tool._execute_called

    @pytest.mark.asyncio
    async def test_redacts_output(self):
        tool = _MockTool()
        call_count = 0

        async def mock_check(phase, name, params=None, result=None):
            nonlocal call_count
            call_count += 1
            if phase == "input":
                return ToolCheckResult(effect="allow")
            return ToolCheckResult(effect="redact", data=None)

        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy",
            side_effect=mock_check,
        ):
            result = await tool._checked_execute({"key": "val"})
            assert result == ""

    @pytest.mark.asyncio
    async def test_flag_passes_through(self):
        tool = _MockTool()
        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="flag"),
        ):
            result = await tool._checked_execute({"key": "val"})
            assert result == "real-result"

    @pytest.mark.asyncio
    async def test_policy_receives_tool_name(self):
        tool = _MockTool()
        mock = AsyncMock(return_value=ToolCheckResult(effect="allow"))
        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy",
            mock,
        ):
            await tool._checked_execute({"key": "val"})
            assert mock.call_args_list[0].args[1] == "testTool"
            assert mock.call_args_list[1].args[1] == "testTool"
