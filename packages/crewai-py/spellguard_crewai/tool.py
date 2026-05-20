# SPDX-License-Identifier: Apache-2.0

"""
SpellguardRouteTool - CrewAI BaseTool for routing prompts through Spellguard.

Follows the same adapter pattern as the TS LangChain / OpenAI integrations:
wraps ``resolve_and_collect_agent_responses()`` + ``build_agent_context_block()``
with minimal framework-specific glue.

Agent developers should import from ``spellguard_crewai`` only — never from
``spellguard_client`` directly.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from typing import Any, Type

from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from spellguard_client.ai import (
    build_agent_context_block,
    resolve_and_collect_agent_responses,
)

logger = logging.getLogger("spellguard.crewai")


# ===================================================================
# Public helper — pre-route before crew kickoff
# ===================================================================


async def pre_route(prompt: str) -> str:
    """Detect agent references and collect responses before crew kickoff.

    Returns a context-block string ready to inject into a CrewAI task
    description, or ``""`` when no agents are found.

    This is the pre-routing counterpart to :class:`SpellguardRouteTool`
    (which handles ad-hoc routing during crew execution).  Together they
    let agent developers work entirely through ``spellguard_crewai``
    without importing ``spellguard_client`` directly.
    """
    responses = await resolve_and_collect_agent_responses(prompt)
    if not responses:
        return ""
    return build_agent_context_block(responses)


class SpellguardRouteInput(BaseModel):
    """Input schema for SpellguardRouteTool."""

    prompt: str = Field(
        ...,
        description="The text containing agent references to route through Spellguard.",
    )


class SpellguardRouteTool(BaseTool):
    """Route prompts to other Spellguard agents.

    Use this tool when a prompt references another agent by name
    (e.g. "ask Agent PA for patient records"). The tool detects agent
    references, routes the request through the Spellguard Verifier, and returns
    the collected responses formatted as a context block.
    """

    name: str = "spellguard_route"
    description: str = (
        "Route a prompt to other Spellguard agents. Use this when the prompt "
        "references another agent by name (e.g. 'ask Agent PA for patient "
        "records', 'get data from Agent PB'). Returns the agents' responses "
        "formatted as a context block."
    )
    args_schema: Type[BaseModel] = SpellguardRouteInput

    def _run(self, prompt: str, **kwargs: Any) -> str:
        """Synchronous entry point -- delegates to async implementation."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            # Already inside an event loop (e.g. FastAPI) -- run in a new
            # thread to avoid blocking the loop.  Copy the current context
            # so that the hop-count ContextVar propagates into the thread.
            import concurrent.futures

            ctx = contextvars.copy_context()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(ctx.run, asyncio.run, self._aroute(prompt))
                return future.result()
        else:
            return asyncio.run(self._aroute(prompt))

    async def _arun(self, prompt: str, **kwargs: Any) -> str:
        """Async entry point for native async callers."""
        return await self._aroute(prompt)

    async def _aroute(self, prompt: str) -> str:
        """Core routing logic shared by _run and _arun."""
        logger.info("[SpellguardRouteTool] Routing prompt: %s", prompt[:120])

        responses = await resolve_and_collect_agent_responses(prompt)

        if not responses:
            return "No agents were found matching the references in the prompt."

        context = build_agent_context_block(responses)
        logger.info(
            "[SpellguardRouteTool] Collected %d agent response(s)", len(responses)
        )
        return context
