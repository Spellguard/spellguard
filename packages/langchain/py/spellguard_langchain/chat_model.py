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
        return self.wrapped_model._generate(
            prepared, stop=stop, run_manager=run_manager, **kwargs
        )

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        prepared = await self._prepare_messages(messages)
        return await self.wrapped_model._agenerate(
            prepared, stop=stop, run_manager=run_manager, **kwargs
        )

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
