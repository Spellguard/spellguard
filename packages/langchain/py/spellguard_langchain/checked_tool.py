# SPDX-License-Identifier: Apache-2.0

"""
SpellguardStructuredTool - LangChain StructuredTool with built-in policy checks.

Matches the TypeScript ``@spellguard/langchain`` ``spellguardTool()`` API.

Usage::

    from spellguard_langchain import SpellguardStructuredTool
    from pydantic import BaseModel, Field

    class SearchInput(BaseModel):
        query: str = Field(description="Search query")

    search = SpellguardStructuredTool.from_function(
        name="search",
        description="Search the database",
        args_schema=SearchInput,
        func=lambda query: db.search(query),
    )
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Type

from langchain_core.tools import StructuredTool
from pydantic import BaseModel

from spellguard_client.attestation import check_tool_policy

logger = logging.getLogger("spellguard.langchain")


class SpellguardStructuredTool(StructuredTool):
    """LangChain StructuredTool with Spellguard tool policy checks.

    Use ``from_function()`` to create instances, same as StructuredTool.
    The ``_run`` method wraps the underlying function with input/output
    policy checks.
    """

    # The original unwrapped function, stored so _run can call it
    _original_func: Callable[..., Any] | None = None

    @classmethod
    def from_function(  # type: ignore[override]
        cls,
        func: Callable[..., str],
        name: str,
        description: str,
        args_schema: Type[BaseModel] | None = None,
        **kwargs: Any,
    ) -> "SpellguardStructuredTool":
        """Create a SpellguardStructuredTool from a plain function."""
        instance = super().from_function(
            func=func,
            name=name,
            description=description,
            args_schema=args_schema,
            **kwargs,
        )
        # Cast to our subclass (from_function returns StructuredTool)
        instance.__class__ = cls
        instance._original_func = func  # type: ignore[attr-defined]
        return instance  # type: ignore[return-value]

    async def _arun(self, *args: Any, **kwargs: Any) -> str:
        """Async entry point with policy checks."""
        # Input phase — fail open on errors
        try:
            inp = await check_tool_policy("input", self.name, kwargs or args)
            if inp.effect == "block":
                return inp.message or "[BLOCKED]"
            if inp.effect == "redact":
                return inp.message or "[BLOCKED]"
        except Exception as exc:
            logger.warning("[SpellguardStructuredTool] Input check failed, continuing: %s", exc)

        # Call the underlying function
        func = self._original_func or self.func
        result = func(*args, **kwargs)

        # Output phase — fail open on errors
        try:
            out = await check_tool_policy("output", self.name, kwargs or args, result)
            if out.effect == "block":
                return out.message or "[BLOCKED]"
            if out.effect == "redact":
                return str(out.data) if out.data is not None else ""
        except Exception as exc:
            logger.warning("[SpellguardStructuredTool] Output check failed, continuing: %s", exc)

        return result
