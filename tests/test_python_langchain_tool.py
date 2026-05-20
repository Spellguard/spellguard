# SPDX-License-Identifier: Apache-2.0

"""
Tests for SpellguardStructuredTool (LangChain StructuredTool with policy checks).

Mocks check_tool_policy to verify the wrapper handles all effect paths.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from pydantic import BaseModel, Field

from spellguard_client.attestation import ToolCheckResult
from spellguard_langchain.checked_tool import SpellguardStructuredTool


class _SearchInput(BaseModel):
    query: str = Field(description="Search query")


def _fake_search(query: str) -> str:
    return f"results for {query}"


class TestPythonLangchainCheckedTool:
    """SpellguardStructuredTool tests."""

    @pytest.mark.asyncio
    async def test_passes_through_on_allow(self):
        tool = SpellguardStructuredTool.from_function(
            func=_fake_search,
            name="search",
            description="Search the database",
            args_schema=_SearchInput,
        )
        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="allow"),
        ):
            result = await tool._arun(query="test")
            assert result == "results for test"

    @pytest.mark.asyncio
    async def test_blocks_on_input(self):
        tool = SpellguardStructuredTool.from_function(
            func=_fake_search,
            name="search",
            description="Search the database",
            args_schema=_SearchInput,
        )
        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="block", message="Blocked"),
        ):
            result = await tool._arun(query="test")
            assert result == "Blocked"

    @pytest.mark.asyncio
    async def test_input_redact_as_block(self):
        tool = SpellguardStructuredTool.from_function(
            func=_fake_search,
            name="search",
            description="Search the database",
            args_schema=_SearchInput,
        )
        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="redact"),
        ):
            result = await tool._arun(query="test")
            assert result == "[BLOCKED]"

    @pytest.mark.asyncio
    async def test_blocks_on_output(self):
        tool = SpellguardStructuredTool.from_function(
            func=_fake_search,
            name="search",
            description="Search the database",
            args_schema=_SearchInput,
        )

        async def mock_check(phase, name, params=None, result=None):
            if phase == "input":
                return ToolCheckResult(effect="allow")
            return ToolCheckResult(effect="block", message="PHI detected")

        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            side_effect=mock_check,
        ):
            result = await tool._arun(query="test")
            assert result == "PHI detected"

    @pytest.mark.asyncio
    async def test_redacts_output(self):
        tool = SpellguardStructuredTool.from_function(
            func=_fake_search,
            name="search",
            description="Search the database",
            args_schema=_SearchInput,
        )

        async def mock_check(phase, name, params=None, result=None):
            if phase == "input":
                return ToolCheckResult(effect="allow")
            return ToolCheckResult(effect="redact", data=None)

        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            side_effect=mock_check,
        ):
            result = await tool._arun(query="test")
            assert result == ""

    @pytest.mark.asyncio
    async def test_flag_passes_through(self):
        tool = SpellguardStructuredTool.from_function(
            func=_fake_search,
            name="search",
            description="Search the database",
            args_schema=_SearchInput,
        )
        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            new_callable=AsyncMock,
            return_value=ToolCheckResult(effect="flag"),
        ):
            result = await tool._arun(query="test")
            assert result == "results for test"

    @pytest.mark.asyncio
    async def test_policy_receives_tool_name(self):
        tool = SpellguardStructuredTool.from_function(
            func=_fake_search,
            name="mySearch",
            description="Search the database",
            args_schema=_SearchInput,
        )
        mock = AsyncMock(return_value=ToolCheckResult(effect="allow"))
        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            mock,
        ):
            await tool._arun(query="test")
            assert mock.call_args_list[0].args[1] == "mySearch"
            assert mock.call_args_list[1].args[1] == "mySearch"
