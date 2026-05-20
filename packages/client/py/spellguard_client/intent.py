# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client - Intent Detection

Detect agent references in natural language prompts via AI-based
detection or pattern-matching fallback.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Awaitable, Callable

logger = logging.getLogger("spellguard")

# ===================================================================
# Module-level state
# ===================================================================

_intent_detection_model: Any | None = None
_intent_detect_fn: Callable[[str], Awaitable[list[str]]] | None = None

# ===================================================================
# System prompt for AI-based detection
# ===================================================================

AGENT_DETECTION_SYSTEM_PROMPT = """You analyze prompts to detect references to other AI agents.
Extract agent names/identifiers mentioned in the prompt.
Return ONLY a JSON array of agent IDs (lowercase, hyphenated), or empty array if none.

Rules:
- Agent names often follow patterns like "Agent X", "agent-x", "the X agent"
- Convert to lowercase with hyphens: "Agent B" -> "agent-b"
- Only extract explicit agent references, not general mentions of agents
- If unsure, return empty array

Examples:
- "get data from Agent B" -> ["agent-b"]
- "ask the analytics-agent to process this" -> ["analytics-agent"]
- "have Agent C and Agent D collaborate" -> ["agent-c", "agent-d"]
- "hello world" -> []
- "I need an agent to help me" -> []
- "send this to the report-generator" -> ["report-generator"]"""


# ===================================================================
# Public API
# ===================================================================


def set_intent_detection_model(model: Any) -> None:
    """Set the model to use for intent detection.

    Should be a fast, low-latency model — small/haiku-tier or GPT-4o-mini class.
    """
    global _intent_detection_model
    _intent_detection_model = model


def set_intent_detect_fn(
    fn: Callable[[str], Awaitable[list[str]]],
) -> None:
    """Set a raw detect function for agent-reference detection.

    Used by adapter packages so they can use their native SDK for
    detection without requiring AI SDK dependencies.
    """
    global _intent_detect_fn
    _intent_detect_fn = fn


def get_intent_detection_model() -> Any:
    """Get the configured intent detection model."""
    if _intent_detection_model is None:
        raise RuntimeError(
            "Intent detection model not configured. "
            "Call set_intent_detection_model() first."
        )
    return _intent_detection_model


async def detect_agent_references(prompt: str) -> list[str]:
    """Detect agent references in a natural language prompt.

    Uses AI to understand the user's intent and extract agent names.

    Examples::

        "analyze data from Agent B" -> ["agent-b"]
        "ask Agent C and Agent D about X" -> ["agent-c", "agent-d"]
        "what's 2+2?" -> []
        "get the report from the analytics-agent" -> ["analytics-agent"]
    """
    # 1. Custom detect function (set by adapter packages)
    if _intent_detect_fn is not None:
        try:
            result = await _intent_detect_fn(prompt)
            if len(result) > 0:
                return result
        except Exception as error:
            logger.warning(
                "[Intent] Custom detect function failed, falling back to "
                "pattern matching: %s",
                error,
            )
        return _detect_agent_references_pattern(prompt)

    # 2. AI model via OpenAI SDK (set by set_intent_detection_model)
    if _intent_detection_model is not None:
        try:
            import json as _json

            from openai import AsyncOpenAI

            # If model is an AsyncOpenAI client, use it directly;
            # otherwise treat as a model name string and create a client.
            if isinstance(_intent_detection_model, AsyncOpenAI):
                client = _intent_detection_model
                model_name = "gpt-4o-mini"
            elif isinstance(_intent_detection_model, str):
                client = AsyncOpenAI()
                model_name = _intent_detection_model
            else:
                # Assume it has a `chat.completions.create` interface
                client = _intent_detection_model
                model_name = "gpt-4o-mini"

            response = await client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": AGENT_DETECTION_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                max_tokens=100,
            )

            text = response.choices[0].message.content or ""
            text = text.strip()
            json_match = re.search(r"\[.*\]", text, re.DOTALL)
            if json_match:
                result = _json.loads(json_match.group(0))
                if len(result) > 0:
                    return result  # type: ignore[no-any-return]
        except Exception as error:
            logger.warning(
                "[Intent] Failed to detect agent references: %s", error
            )
        # AI returned empty or failed — fall through to pattern matching
        return _detect_agent_references_pattern(prompt)

    # 3. Pattern matching fallback
    return _detect_agent_references_pattern(prompt)


def might_contain_agent_reference(prompt: str) -> bool:
    """Check if a prompt contains any agent references.

    Faster than full detection -- useful for early filtering.
    """
    lower_prompt = prompt.lower()

    # Quick checks for common patterns
    if re.search(r"@[a-z0-9]+-[a-z0-9]", lower_prompt, re.IGNORECASE):
        return True
    if re.search(r"agent[\s-][a-z0-9]", lower_prompt, re.IGNORECASE):
        return True
    if re.search(r"[a-z0-9]+-agent", lower_prompt, re.IGNORECASE):
        return True
    if re.search(
        r"(?:from|to|ask|tell|consult)\s+@?[a-z0-9]+-[a-z0-9]",
        lower_prompt,
        re.IGNORECASE,
    ):
        return True

    return False


# ===================================================================
# Internal: pattern-based fallback
# ===================================================================


def _detect_agent_references_pattern(prompt: str) -> list[str]:
    """Pattern-based fallback for agent reference detection.

    Less accurate than LLM but works without API calls.
    """
    agents: list[str] = []
    lower_prompt = prompt.lower()

    # Pattern: "Agent X" or "agent X"
    agent_pattern = re.compile(r"agent[\s-]([a-z0-9]+)", re.IGNORECASE)
    for match in agent_pattern.finditer(lower_prompt):
        agent_name = f"agent-{match.group(1).lower()}"
        if agent_name not in agents:
            agents.append(agent_name)

    # Pattern: "the X-agent" or "X-agent"
    suffix_pattern = re.compile(r"(?:the\s+)?([a-z0-9]+)-agent", re.IGNORECASE)
    for match in suffix_pattern.finditer(lower_prompt):
        agent_name = f"{match.group(1).lower()}-agent"
        if agent_name not in agents:
            agents.append(agent_name)

    # Pattern: "@agent-name" explicit mention
    at_mention_pattern = re.compile(
        r"@([a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*)", re.IGNORECASE
    )
    for match in at_mention_pattern.finditer(lower_prompt):
        agent_name = match.group(1).lower()
        if agent_name not in agents:
            agents.append(agent_name)

    # Pattern: kebab-case names that look like agents
    kebab_pattern = re.compile(
        r"(?:from|to|ask|tell|consult|send\s+to|get\s+from)\s+"
        r"@?([a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*)",
        re.IGNORECASE,
    )
    for match in kebab_pattern.finditer(lower_prompt):
        agent_name = match.group(1).lower()
        if agent_name not in agents:
            agents.append(agent_name)

    return agents
