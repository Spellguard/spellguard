# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the spellguard_crewai package.

Tests the SpellguardRouteTool with mocked dependencies (no Verifier needed).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from spellguard_crewai import SpellguardRouteTool, pre_route
from spellguard_crewai.tool import SpellguardRouteInput


# =====================================================================
# Tool Metadata
# =====================================================================


class TestPythonCrewaiToolMetadata:
    def test_tool_name(self):
        tool = SpellguardRouteTool()
        assert tool.name == "spellguard_route"

    def test_tool_description_mentions_agents(self):
        tool = SpellguardRouteTool()
        assert "agent" in tool.description.lower()

    def test_args_schema_is_spellguard_route_input(self):
        tool = SpellguardRouteTool()
        assert tool.args_schema is SpellguardRouteInput

    def test_args_schema_has_prompt_field(self):
        schema = SpellguardRouteInput.model_json_schema()
        assert "prompt" in schema["properties"]
        assert "prompt" in schema["required"]


# =====================================================================
# Routing with agent responses
# =====================================================================


class TestPythonCrewaiRouteWithResponses:
    async def test_returns_context_block_when_agents_respond(self):
        tool = SpellguardRouteTool()

        mock_responses = [
            {"agent": "agent-pa", "response": "Patient records: John Doe, 3 visits"},
            {"agent": "agent-pb", "response": "Lab analysis: cholesterol normal"},
        ]

        with (
            patch(
                "spellguard_crewai.tool.resolve_and_collect_agent_responses",
                new_callable=AsyncMock,
                return_value=mock_responses,
            ),
            patch(
                "spellguard_crewai.tool.build_agent_context_block",
                return_value="Mocked context block with agent responses",
            ) as mock_build,
        ):
            result = await tool._arun(prompt="Ask Agent PA for patient records")

        assert result == "Mocked context block with agent responses"
        mock_build.assert_called_once_with(mock_responses)

    async def test_returns_no_agents_message_when_none_found(self):
        tool = SpellguardRouteTool()

        with patch(
            "spellguard_crewai.tool.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await tool._arun(prompt="What is 2 + 2?")

        assert "no agents" in result.lower()


# =====================================================================
# Error propagation
# =====================================================================


class TestPythonCrewaiErrorPropagation:
    async def test_propagates_policy_error(self):
        tool = SpellguardRouteTool()

        with patch(
            "spellguard_crewai.tool.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            side_effect=RuntimeError("Blocked by policy: six-seven-detector"),
        ):
            with pytest.raises(RuntimeError, match="Blocked by policy"):
                await tool._arun(prompt="Ask Agent PA about employee 67")

    async def test_propagates_rate_limit_error(self):
        tool = SpellguardRouteTool()

        with patch(
            "spellguard_crewai.tool.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            side_effect=RuntimeError("Too many requests - rate_limited"),
        ):
            with pytest.raises(RuntimeError, match="rate_limited"):
                await tool._arun(prompt="Ask Agent PA for records")


# =====================================================================
# Sync wrapper
# =====================================================================


class TestPythonCrewaiSyncWrapper:
    def test_sync_run_delegates_to_async(self):
        tool = SpellguardRouteTool()

        with patch(
            "spellguard_crewai.tool.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = tool._run(prompt="Hello")

        assert "no agents" in result.lower()


# =====================================================================
# pre_route helper
# =====================================================================


class TestPythonCrewaiPreRoute:
    async def test_returns_context_block_when_agents_respond(self):
        mock_responses = [
            {"agent": "agent-pa", "response": "Patient records: John Doe, 3 visits"},
        ]

        with (
            patch(
                "spellguard_crewai.tool.resolve_and_collect_agent_responses",
                new_callable=AsyncMock,
                return_value=mock_responses,
            ),
            patch(
                "spellguard_crewai.tool.build_agent_context_block",
                return_value="Pre-routed context block",
            ) as mock_build,
        ):
            result = await pre_route("Ask Agent PA for patient records")

        assert result == "Pre-routed context block"
        mock_build.assert_called_once_with(mock_responses)

    async def test_returns_empty_string_when_no_agents(self):
        with patch(
            "spellguard_crewai.tool.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await pre_route("What is 2 + 2?")

        assert result == ""

    async def test_propagates_policy_error(self):
        with patch(
            "spellguard_crewai.tool.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            side_effect=RuntimeError("Blocked by policy: test"),
        ):
            with pytest.raises(RuntimeError, match="Blocked by policy"):
                await pre_route("Ask Agent PA about employee 67")
