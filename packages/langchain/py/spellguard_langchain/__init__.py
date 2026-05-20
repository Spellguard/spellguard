# SPDX-License-Identifier: Apache-2.0

"""
spellguard_langchain - LangChain integration for Spellguard

Wraps any LangChain ``BaseChatModel`` with transparent Spellguard Verifier
agent routing, matching the adapter pattern used by the TypeScript
``@spellguard/langchain`` package.
"""

from __future__ import annotations

from .chat_model import SpellguardChatModel, create_spellguard_chat_model
from .checked_tool import SpellguardStructuredTool
from spellguard_client import check_tool_policy, ToolCheckResult, spellguard_tool

__all__ = [
    "SpellguardChatModel",
    "SpellguardStructuredTool",
    "create_spellguard_chat_model",
    "check_tool_policy",
    "ToolCheckResult",
    "spellguard_tool",
]
