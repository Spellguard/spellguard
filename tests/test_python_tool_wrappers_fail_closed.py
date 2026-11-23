# SPDX-License-Identifier: Apache-2.0

"""#1418: no Python tool wrapper runs a tool, or returns its result, without a
policy decision (Python twin of tests/security/tool-wrappers-fail-closed.test.ts).

``check_tool_policy`` fails closed, but the CrewAI ``SpellguardCheckedTool``
and the LangChain ``SpellguardStructuredTool`` caught any exception it raised,
logged "check failed, continuing", and ran the tool (or returned its output)
unchecked. ``check_tool_policy`` itself could also raise: anything outside its
two guarded calls (reading the channel, building the body) escaped it.

The check is now total (an unexpected error is an unavailable check,
``check_failed``, which honours ``fail_open``) and the wrappers have no
``except`` of their own.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from spellguard_client import attestation
from spellguard_client.attestation import (
    TOOL_POLICY_FAIL_OPEN_ENV_VAR,
    ToolCheckResult,
    check_tool_policy,
)

SECRET_OUTPUT = "customer ssn 000-00-0000"


class _ExplodingChannel:
    """A channel whose identity cannot be read."""

    @property
    def agent_id(self) -> str:
        raise RuntimeError("channel state unreadable")


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv(TOOL_POLICY_FAIL_OPEN_ENV_VAR, raising=False)
    attestation.reset()
    yield
    attestation.reset()


class TestPythonCheckToolPolicyNeverRaises:
    @pytest.mark.asyncio
    async def test_unexpected_error_blocks(self, monkeypatch):
        async def channel():
            return _ExplodingChannel()

        monkeypatch.setattr(attestation, "get_or_create_channel", channel)

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "check_failed"

    @pytest.mark.asyncio
    async def test_unexpected_error_allows_under_fail_open(self, monkeypatch):
        async def channel():
            return _ExplodingChannel()

        monkeypatch.setattr(attestation, "get_or_create_channel", channel)
        monkeypatch.setenv(TOOL_POLICY_FAIL_OPEN_ENV_VAR, "true")

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"
        assert result.reason == "check_failed"


def _raise_on(phase_to_raise: str):
    async def check(phase: str, *_args: Any, **_kwargs: Any) -> ToolCheckResult:
        if phase == phase_to_raise:
            raise RuntimeError("check exploded")
        return ToolCheckResult(effect="allow")

    return check


async def _settle(coro) -> tuple[str, Any]:
    try:
        return ("value", await coro)
    except Exception as exc:  # noqa: BLE001 - the outcome is what is asserted
        return ("error", exc)


class TestPythonCrewaiWrapperFailsClosed:
    @staticmethod
    def _tool():
        from spellguard_crewai.checked_tool import SpellguardCheckedTool

        class _Tool(SpellguardCheckedTool):
            name: str = "transferFunds"
            description: str = "test"
            ran: bool = False

            def _execute(self, **kwargs: Any) -> str:
                self.ran = True
                return SECRET_OUTPUT

        return _Tool()

    @pytest.mark.asyncio
    async def test_throwing_input_check_does_not_run_the_tool(self):
        pytest.importorskip("crewai")
        tool = self._tool()
        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy", _raise_on("input")
        ):
            outcome = await _settle(tool._checked_execute({"amount": 1}))

        assert tool.ran is False
        assert outcome != ("value", SECRET_OUTPUT)

    @pytest.mark.asyncio
    async def test_throwing_output_check_does_not_return_the_output(self):
        pytest.importorskip("crewai")
        tool = self._tool()
        with patch(
            "spellguard_crewai.checked_tool.check_tool_policy", _raise_on("output")
        ):
            outcome = await _settle(tool._checked_execute({"id": 1}))

        assert outcome != ("value", SECRET_OUTPUT)


class TestPythonLangchainWrapperFailsClosed:
    @staticmethod
    def _tool(record: dict[str, bool]):
        from pydantic import BaseModel

        from spellguard_langchain.checked_tool import SpellguardStructuredTool

        class _Input(BaseModel):
            amount: int

        def run(amount: int) -> str:
            record["ran"] = True
            return SECRET_OUTPUT

        return SpellguardStructuredTool.from_function(
            func=run,
            name="transferFunds",
            description="test",
            args_schema=_Input,
        )

    @pytest.mark.asyncio
    async def test_throwing_input_check_does_not_run_the_tool(self):
        pytest.importorskip("langchain_core")
        record = {"ran": False}
        tool = self._tool(record)
        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            _raise_on("input"),
        ):
            outcome = await _settle(tool._arun(amount=1))

        assert record["ran"] is False
        assert outcome != ("value", SECRET_OUTPUT)

    @pytest.mark.asyncio
    async def test_throwing_output_check_does_not_return_the_output(self):
        pytest.importorskip("langchain_core")
        record = {"ran": False}
        tool = self._tool(record)
        with patch(
            "spellguard_langchain.checked_tool.check_tool_policy",
            _raise_on("output"),
        ):
            outcome = await _settle(tool._arun(amount=1))

        assert outcome != ("value", SECRET_OUTPUT)
