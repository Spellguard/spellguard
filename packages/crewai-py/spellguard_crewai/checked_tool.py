# SPDX-License-Identifier: Apache-2.0

"""
SpellguardCheckedTool - CrewAI BaseTool with built-in policy checks.

Subclass this instead of ``BaseTool`` to get automatic input/output
policy checks via the Spellguard Verifier.  Matches the same API pattern as
``spellguardTool()`` in TypeScript AI SDK and LangChain wrappers.

Usage::

    class GetPatientRecord(SpellguardCheckedTool):
        name: str = "getPatientRecord"
        description: str = "Look up a patient record by name"
        args_schema: Type[BaseModel] = PatientInput

        def _execute(self, **kwargs) -> str:
            return db.find_patient(kwargs["name"])
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from typing import Any, Type

from crewai.tools import BaseTool
from pydantic import BaseModel

from spellguard_client.attestation import check_tool_policy

logger = logging.getLogger("spellguard.crewai")


class SpellguardCheckedTool(BaseTool):
    """CrewAI BaseTool subclass with Spellguard tool policy checks.

    Subclasses must implement ``_execute(**kwargs) -> str`` instead of
    ``_run``.  The base class wraps it with input/output policy checks.
    """

    def _execute(self, **kwargs: Any) -> str:
        """Override this with your tool logic."""
        raise NotImplementedError("Subclasses must implement _execute()")

    def _run(self, **kwargs: Any) -> str:
        """Entry point called by CrewAI — wraps _execute with policy checks."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures

            ctx = contextvars.copy_context()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    ctx.run, asyncio.run, self._checked_execute(kwargs)
                )
                return future.result()
        else:
            return asyncio.run(self._checked_execute(kwargs))

    async def _checked_execute(self, kwargs: dict[str, Any]) -> str:
        """Run policy checks around _execute."""
        # Input phase — fail open on errors
        try:
            inp = await check_tool_policy("input", self.name, kwargs)
            if inp.effect == "block":
                return inp.message or "[BLOCKED]"
            if inp.effect == "redact":
                return inp.message or "[BLOCKED]"
        except Exception as exc:
            logger.warning("[SpellguardCheckedTool] Input check failed, continuing: %s", exc)

        result = self._execute(**kwargs)

        # Output phase — fail open on errors
        try:
            out = await check_tool_policy("output", self.name, kwargs, result)
            if out.effect == "block":
                return out.message or "[BLOCKED]"
            if out.effect == "redact":
                return str(out.data) if out.data is not None else ""
        except Exception as exc:
            logger.warning("[SpellguardCheckedTool] Output check failed, continuing: %s", exc)

        return result
