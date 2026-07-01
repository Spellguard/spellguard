# SPDX-License-Identifier: Apache-2.0

"""
SpellguardChatModel - LangChain BaseChatModel wrapper for Spellguard.

Port of ``packages/langchain/ts/src/chat-model.ts``.  Follows the same adapter
pattern as the TS LangChain / OpenAI / CrewAI integrations: wraps
``resolve_and_collect_agent_responses()`` + ``build_agent_context_block()``
with minimal framework-specific glue.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator, Iterator, List, Optional

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, SystemMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from spellguard_client.ai import (
    build_agent_context_block,
    resolve_and_collect_agent_responses,
)
from spellguard_client.usage_telemetry import UsageEvent, report_usage_event

logger = logging.getLogger("spellguard.langchain")


# ─── Private helpers ──────────────────────────────────────────────


def _get_content_text(content: Any) -> str:
    """Extract plain text from a message's content field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return str(content)


def _extract_prompt(messages: List[BaseMessage]) -> str:
    """Join all human message contents into a single prompt string."""
    return "\n".join(
        _get_content_text(m.content)
        for m in messages
        if m.type == "human"
    )


def _augment_messages(
    messages: List[BaseMessage],
    agent_responses: list[dict[str, str]],
) -> List[BaseMessage]:
    """Inject agent context into the message list.

    If a system message already exists, the context block is appended to it.
    Otherwise a new system message is prepended.  Returns the original list
    unchanged when *agent_responses* is empty.
    """
    if not agent_responses:
        return messages

    context_block = build_agent_context_block(agent_responses)
    augmented = list(messages)

    system_idx = next(
        (i for i, m in enumerate(augmented) if m.type == "system"),
        None,
    )

    if system_idx is not None:
        existing_text = _get_content_text(augmented[system_idx].content)
        augmented[system_idx] = SystemMessage(
            content=f"{existing_text}\n\n{context_block}"
        )
    else:
        augmented.insert(0, SystemMessage(content=context_block))

    return augmented


# ─── SpellguardChatModel ──────────────────────────────────────────


class SpellguardChatModel(BaseChatModel):
    """Wrap any LangChain ``BaseChatModel`` with Spellguard Verifier routing.

    When a prompt contains references to other agents, the wrapper
    automatically discovers them via A2A, collects their responses
    through the Spellguard Verifier, augments the message list with the
    gathered context, and delegates the final LLM call to the wrapped
    model.  Prompts with no agent references pass through directly
    with zero overhead.

    **Prerequisite:** Spellguard must be initialised before the first
    call (e.g. via ``create_spellguard``).
    """

    wrapped_model: BaseChatModel

    @property
    def _llm_type(self) -> str:
        return f"spellguard-{self.wrapped_model._llm_type}"

    async def _prepare_messages(
        self, messages: List[BaseMessage]
    ) -> List[BaseMessage]:
        """Detect agent references, collect Verifier responses, augment messages."""
        prompt = _extract_prompt(messages)
        agent_responses = await resolve_and_collect_agent_responses(prompt)
        return _augment_messages(messages, agent_responses)

    def _emit_usage(self, result: ChatResult) -> None:
        """emit token usage from a wrapped-model
        ``ChatResult``. Usage shape varies by provider -- read defensively across
        ``llm_output['token_usage']`` (OpenAI-family), ``llm_output['usage']``,
        and the per-generation ``usage_metadata`` (input/output tokens).
        Fire-and-forget + fail-open -- never raises into the LLM call."""
        try:
            out = result.llm_output or {}
            tu = out.get("token_usage") or out.get("usage") or {}
            meta: dict[str, Any] = {}
            gens = result.generations or []
            if gens:
                msg = getattr(gens[0], "message", None)
                meta = getattr(msg, "usage_metadata", None) or {}
            prompt = (
                tu.get("prompt_tokens")
                or tu.get("promptTokens")
                or meta.get("input_tokens")
            )
            completion = (
                tu.get("completion_tokens")
                or tu.get("completionTokens")
                or meta.get("output_tokens")
            )
            total = (
                tu.get("total_tokens")
                or tu.get("totalTokens")
                or meta.get("total_tokens")
            )
            if prompt is None and completion is None:
                return
            # NB: langchain_core defines `_llm_type` as a @property (unlike the
            # JS `_llmType()` method), so read it with getattr — calling it
            # `()` raises TypeError and (via fail-open) silently drops the event.
            model = (
                out.get("model")
                or getattr(self.wrapped_model, "model", None)
                or getattr(self.wrapped_model, "_llm_type", None)
            )
            report_usage_event(
                UsageEvent(
                    model=model if isinstance(model, str) else "unknown",
                    prompt_tokens=prompt or 0,
                    completion_tokens=completion or 0,
                    total_tokens=(
                        total if total is not None else (prompt or 0) + (completion or 0)
                    ),
                )
            )
        except Exception:
            return  # fail-open

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        prepared = asyncio.get_event_loop().run_until_complete(
            self._prepare_messages(messages)
        )
        result = self.wrapped_model._generate(
            prepared, stop=stop, run_manager=run_manager, **kwargs
        )
        self._emit_usage(result)
        return result

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        prepared = await self._prepare_messages(messages)
        result = await self.wrapped_model._agenerate(
            prepared, stop=stop, run_manager=run_manager, **kwargs
        )
        self._emit_usage(result)
        return result

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        prepared = asyncio.get_event_loop().run_until_complete(
            self._prepare_messages(messages)
        )
        try:
            yield from self.wrapped_model._stream(
                prepared, stop=stop, run_manager=run_manager, **kwargs
            )
        except NotImplementedError:
            # Wrapped model doesn't support streaming — fall back to _generate
            result = self.wrapped_model._generate(
                prepared, stop=stop, run_manager=run_manager, **kwargs
            )
            for gen in result.generations:
                yield ChatGenerationChunk(
                    text=gen.text,
                    message=AIMessageChunk(content=gen.text),
                )

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        prepared = await self._prepare_messages(messages)
        try:
            async for chunk in self.wrapped_model._astream(
                prepared, stop=stop, run_manager=run_manager, **kwargs
            ):
                yield chunk
        except NotImplementedError:
            result = await self.wrapped_model._agenerate(
                prepared, stop=stop, run_manager=run_manager, **kwargs
            )
            for gen in result.generations:
                yield ChatGenerationChunk(
                    text=gen.text,
                    message=AIMessageChunk(content=gen.text),
                )


def create_spellguard_chat_model(model: BaseChatModel) -> SpellguardChatModel:
    """Wrap any LangChain ``BaseChatModel`` with Spellguard Verifier routing.

    This is the primary entry point — mirrors
    ``createSpellguardChatModel`` from ``@spellguard/langchain``.
    """
    return SpellguardChatModel(wrapped_model=model)
