# SPDX-License-Identifier: Apache-2.0

"""
spellguard_crewai - CrewAI integration for Spellguard

Provides a CrewAI BaseTool subclass that routes prompts through the
Spellguard Verifier, enabling CrewAI agents to participate in the Spellguard
agent network.
"""

from __future__ import annotations

from .tool import SpellguardRouteTool, pre_route
from .checked_tool import SpellguardCheckedTool
from spellguard_client import check_tool_policy, ToolCheckResult, spellguard_tool

__all__ = [
    "SpellguardRouteTool",
    "SpellguardCheckedTool",
    "pre_route",
    "check_tool_policy",
    "ToolCheckResult",
    "spellguard_tool",
]
