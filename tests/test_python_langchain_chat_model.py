# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the spellguard_langchain package.

Port of tests/langchain-chat-model.test.ts to pytest.
Tests the SpellguardChatModel with mocked dependencies (no Verifier needed).
"""

from __future__ import annotations

from typing import Any, Iterator, List, Optional
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from spellguard_langchain import SpellguardChatModel, create_spellguard_chat_model


# ─── Test doubles ─────────────────────────────────────────────────

MOCK_RESPONSE = "Mock LLM response"


class MockChatModel(BaseChatModel):
    """Minimal chat model that returns a canned response."""

    @property
    def _llm_type(self) -> str:
        return "mock"

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(
            generations=[
                ChatGeneration(
                    text=MOCK_RESPONSE,
                    message=AIMessage(content=MOCK_RESPONSE),
                )
            ]
        )


class MockStreamingChatModel(BaseChatModel):
    """Chat model that supports streaming."""

    @property
    def _llm_type(self) -> str:
        return "mock-streaming"

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(
            generations=[
                ChatGeneration(
                    text=MOCK_RESPONSE,
                    message=AIMessage(content=MOCK_RESPONSE),
                )
            ]
        )

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        yield ChatGenerationChunk(
            text="chunk1",
            message=AIMessageChunk(content="chunk1"),
        )
        yield ChatGenerationChunk(
            text="chunk2",
            message=AIMessageChunk(content="chunk2"),
        )


# ─── Mock builder ─────────────────────────────────────────────────


def _build_context_block(responses: list[dict[str, str]]) -> str:
    """Reproduce the real build_agent_context_block format for assertions."""
    agent_context = "\n\n".join(
        f"--- Response from {r['agent']} ---\n{r['response']}\n"
        f"--- End response from {r['agent']} ---"
        for r in responses
    )
    instruction = (
        "You have received responses from other agents. Use this information "
        "along with your own data to provide a comprehensive answer to the "
        "user's query."
    )
    return f"{instruction}\n\n{agent_context}"


# =====================================================================
# Pass-through (no agent references)
# =====================================================================


class TestPythonLangchainPassThrough:
    async def test_delegates_directly_when_no_agent_responses(self):
        inner = MockChatModel()
        model = create_spellguard_chat_model(inner)

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await model.ainvoke([HumanMessage(content="What is 2+2?")])

        assert result.content == MOCK_RESPONSE

    async def test_calls_resolve_with_extracted_prompt(self):
        model = create_spellguard_chat_model(MockChatModel())

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_resolve:
            await model.ainvoke([HumanMessage(content="Hello")])

        mock_resolve.assert_called_once_with("Hello")

    async def test_concatenates_multiple_human_messages(self):
        model = create_spellguard_chat_model(MockChatModel())

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_resolve:
            await model.ainvoke([
                HumanMessage(content="First message"),
                SystemMessage(content="System"),
                HumanMessage(content="Second message"),
            ])

        mock_resolve.assert_called_once_with("First message\nSecond message")


# =====================================================================
# Agent routing and message augmentation
# =====================================================================


class TestPythonLangchainAugmentation:
    async def test_augments_messages_with_agent_context(self):
        mock_responses = [
            {"agent": "agent-b", "response": "Agent B response"},
        ]

        inner = MockChatModel()
        original_generate = inner._generate

        captured_messages: list[list[BaseMessage]] = []

        def spy_generate(*args, **kwargs):
            captured_messages.append(args[0])
            return original_generate(*args, **kwargs)

        inner._generate = spy_generate

        model = create_spellguard_chat_model(inner)

        with (
            patch(
                "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
                new_callable=AsyncMock,
                return_value=mock_responses,
            ),
            patch(
                "spellguard_langchain.chat_model.build_agent_context_block",
                return_value=_build_context_block(mock_responses),
            ),
        ):
            await model.ainvoke([HumanMessage(content="Ask agent-b for data")])

        assert len(captured_messages) == 1
        msgs = captured_messages[0]
        system_msgs = [m for m in msgs if m.type == "system"]
        assert len(system_msgs) == 1
        assert "agent-b" in system_msgs[0].content
        assert "Agent B response" in system_msgs[0].content

    async def test_augments_existing_system_message(self):
        mock_responses = [
            {"agent": "agent-b", "response": "Agent B data"},
        ]

        inner = MockChatModel()
        original_generate = inner._generate
        captured_messages: list[list[BaseMessage]] = []

        def spy_generate(*args, **kwargs):
            captured_messages.append(args[0])
            return original_generate(*args, **kwargs)

        inner._generate = spy_generate
        model = create_spellguard_chat_model(inner)

        with (
            patch(
                "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
                new_callable=AsyncMock,
                return_value=mock_responses,
            ),
            patch(
                "spellguard_langchain.chat_model.build_agent_context_block",
                return_value=_build_context_block(mock_responses),
            ),
        ):
            await model.ainvoke([
                SystemMessage(content="You are a helpful assistant."),
                HumanMessage(content="Ask agent-b"),
            ])

        msgs = captured_messages[0]
        system_msgs = [m for m in msgs if m.type == "system"]
        assert len(system_msgs) == 1
        assert "You are a helpful assistant." in system_msgs[0].content
        assert "agent-b" in system_msgs[0].content

    async def test_handles_multiple_agent_responses(self):
        mock_responses = [
            {"agent": "agent-b", "response": "B data"},
            {"agent": "agent-c", "response": "C data"},
        ]

        inner = MockChatModel()
        original_generate = inner._generate
        captured_messages: list[list[BaseMessage]] = []

        def spy_generate(*args, **kwargs):
            captured_messages.append(args[0])
            return original_generate(*args, **kwargs)

        inner._generate = spy_generate
        model = create_spellguard_chat_model(inner)

        with (
            patch(
                "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
                new_callable=AsyncMock,
                return_value=mock_responses,
            ),
            patch(
                "spellguard_langchain.chat_model.build_agent_context_block",
                return_value=_build_context_block(mock_responses),
            ),
        ):
            await model.ainvoke([
                HumanMessage(content="Ask agent-b and agent-c"),
            ])

        msgs = captured_messages[0]
        system_msg = next(m for m in msgs if m.type == "system")
        assert "agent-b" in system_msg.content
        assert "agent-c" in system_msg.content


# =====================================================================
# Error handling
# =====================================================================


class TestPythonLangchainErrorHandling:
    async def test_propagates_policy_block_errors(self):
        model = create_spellguard_chat_model(MockChatModel())

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            side_effect=RuntimeError("Blocked by policy"),
        ):
            with pytest.raises(RuntimeError, match="Blocked by policy"):
                await model.ainvoke([HumanMessage(content="Ask agent-b")])

    async def test_propagates_rate_limit_errors(self):
        model = create_spellguard_chat_model(MockChatModel())

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            side_effect=RuntimeError("RATE_LIMITED"),
        ):
            with pytest.raises(RuntimeError, match="RATE_LIMITED"):
                await model.ainvoke([HumanMessage(content="Ask agent-b")])

    async def test_passes_through_when_collect_returns_empty(self):
        inner = MockChatModel()
        original_generate = inner._generate
        captured_messages: list[list[BaseMessage]] = []

        def spy_generate(*args, **kwargs):
            captured_messages.append(args[0])
            return original_generate(*args, **kwargs)

        inner._generate = spy_generate
        model = create_spellguard_chat_model(inner)

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await model.ainvoke([HumanMessage(content="Ask agent-b")])

        assert result.content == MOCK_RESPONSE
        msgs = captured_messages[0]
        system_msgs = [m for m in msgs if m.type == "system"]
        assert len(system_msgs) == 0


# =====================================================================
# _llm_type
# =====================================================================


class TestPythonLangchainLlmType:
    def test_prefixes_wrapped_model_type(self):
        model = create_spellguard_chat_model(MockChatModel())
        assert model._llm_type == "spellguard-mock"


# =====================================================================
# Streaming
# =====================================================================


class TestPythonLangchainStreaming:
    async def test_delegates_to_wrapped_model_stream(self):
        inner = MockStreamingChatModel()
        model = create_spellguard_chat_model(inner)

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ):
            chunks: list[str] = []
            async for chunk in model.astream([HumanMessage(content="Hello")]):
                chunks.append(chunk.content)

        # LangChain astream may append a trailing empty chunk; filter it
        non_empty = [c for c in chunks if c]
        assert non_empty == ["chunk1", "chunk2"]

    async def test_falls_back_to_generate_when_no_stream(self):
        inner = MockChatModel()  # no _stream
        model = create_spellguard_chat_model(inner)

        with patch(
            "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
            new_callable=AsyncMock,
            return_value=[],
        ):
            chunks: list[str] = []
            async for chunk in model.astream([HumanMessage(content="Hello")]):
                chunks.append(chunk.content)

        non_empty = [c for c in chunks if c]
        assert len(non_empty) == 1
        assert non_empty[0] == MOCK_RESPONSE

    async def test_augments_messages_before_streaming(self):
        mock_responses = [
            {"agent": "agent-b", "response": "Agent B stream response"},
        ]

        inner = MockStreamingChatModel()
        original_stream = inner._stream
        captured_messages: list[list[BaseMessage]] = []

        def spy_stream(*args, **kwargs):
            captured_messages.append(args[0])
            return original_stream(*args, **kwargs)

        inner._stream = spy_stream
        model = create_spellguard_chat_model(inner)

        with (
            patch(
                "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
                new_callable=AsyncMock,
                return_value=mock_responses,
            ),
            patch(
                "spellguard_langchain.chat_model.build_agent_context_block",
                return_value=_build_context_block(mock_responses),
            ),
        ):
            chunks: list[str] = []
            async for chunk in model.astream([
                HumanMessage(content="Ask agent-b"),
            ]):
                chunks.append(chunk.content)

        assert len(captured_messages) == 1
        msgs = captured_messages[0]
        system_msg = next(m for m in msgs if m.type == "system")
        assert "agent-b" in system_msg.content


# =====================================================================
# token-usage emit (_emit_usage)
# =====================================================================


class UsageEchoModel(BaseChatModel):
    """Returns token_usage in llm_output but NO model id, and exposes no
    `.model` attr — forcing the `_llm_type` (@property) fallback. This is the
    exact shape that regressed when `_llm_type` was called as a method."""

    @property
    def _llm_type(self) -> str:
        return "mock"

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(
            generations=[
                ChatGeneration(
                    text=MOCK_RESPONSE,
                    message=AIMessage(content=MOCK_RESPONSE),
                )
            ],
            llm_output={
                "token_usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                }
            },
        )


class TestPythonLangchainUsageEmit:
    async def test_emits_usage_with_llm_type_fallback_when_no_model_echoed(self):
        """Regression: with no echoed model id and no `.model` attr the emit
        must STILL fire, using the wrapped model's `_llm_type` @property — not
        drop the event because `_llm_type` was called as a method."""
        model = create_spellguard_chat_model(UsageEchoModel())

        with (
            patch(
                "spellguard_langchain.chat_model.resolve_and_collect_agent_responses",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch(
                "spellguard_langchain.chat_model.report_usage_event"
            ) as mock_emit,
        ):
            await model._agenerate([HumanMessage(content="hi")])

        assert mock_emit.call_count == 1
        event = mock_emit.call_args.args[0]
        assert event.model == "mock"
        assert event.prompt_tokens == 10
        assert event.completion_tokens == 5
        assert event.total_tokens == 15
