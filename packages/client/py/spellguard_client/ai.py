# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client - AI Integration

Drop-in ``generate_text`` that transparently detects agent references,
routes through the Verifier, runs a tool-calling loop, and returns the final
text.  Agent developers only need this one function -- all Spellguard
plumbing is hidden inside.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .types import ClientChannel, ResolvedAgent
from .usage_telemetry import report_openai_usage

logger = logging.getLogger("spellguard")

# ===================================================================
# Trace context — propagated transparently through async calls
# ===================================================================
#
# Two ContextVars travel together as one logical "message context":
#
#   - ``_current_hops`` — depth counter the Verifier uses to enforce
#     ``MAX_MESSAGE_HOPS`` (anti-loop guard).  Stamped on outbound
#     payloads as ``_spellguardHops``; extracted from inbound stamps
#     by the receive handler.
#
#   - ``_current_correlation_id`` — distributed-tracing id that
#     groups every audit_logs row in one logical conversation under
#     a single ``correlation_id``.  Stamped on outbound payloads as
#     ``_spellguardCorrelationId``; extracted from inbound stamps by
#     the receive handler.  When set on the originating hop, every
#     downstream send across multiple ``(sender, recipient)`` pairs
#     inherits the same id, and the dashboard's "View Related
#     Messages" surfaces them as a single multi-party session.
#
# Mirrors ``packages/client/ts/src/hop-context.ts``.

import uuid as _uuid

_current_hops: contextvars.ContextVar[int] = contextvars.ContextVar(
    "_current_hops", default=0
)

_current_correlation_id: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("_current_correlation_id", default=None)
)

_current_sender_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "_current_sender_id", default=None
)


def get_current_hops() -> int:
    """Return the hop count from the current async context (0 if unset)."""
    return _current_hops.get()


def set_current_hops(hops: int) -> contextvars.Token[int]:
    """Set the hop count for the current async context.

    Returns a reset token so the caller can restore the previous value.
    """
    return _current_hops.set(hops)


def get_current_correlation_id() -> str | None:
    """Return the correlation id from the current async context, or None."""
    return _current_correlation_id.get()


def set_current_correlation_id(
    correlation_id: str | None,
) -> contextvars.Token[str | None]:
    """Set the correlation id for the current async context.

    Returns a reset token so the caller can restore the previous value.
    Pass ``None`` to clear the id (e.g. exiting a trace scope).
    """
    return _current_correlation_id.set(correlation_id)


def get_current_sender_id() -> str | None:
    """Return the immediate inbound sender's agent id from the current async
    context, or None when there's no inbound (a top-level send or /chat call).

    The routing layer (``resolve_and_collect_agent_responses``) excludes this
    id from auto-route targets so a receiver never routes BACK to whoever just
    messaged it — that would be a 2-node cycle (A->B->A). Keeps the
    agent-communication graph a DAG; deeper cycles are backstopped by the
    Verifier's MAX_MESSAGE_HOPS.
    """
    return _current_sender_id.get()


def set_current_sender_id(
    sender_id: str | None,
) -> contextvars.Token[str | None]:
    """Set the immediate inbound sender for the current async context.

    Returns a reset token so the caller can restore the previous value.
    Set by the receive handler so nested routing excludes back-routing.
    """
    return _current_sender_id.set(sender_id)


def new_correlation_id() -> str:
    """Mint a fresh correlation id (UUID4 hex).

    Helper for top-level callers (e.g. a /chat handler initiating a
    new conversation) that want to open a trace context without
    inheriting one from upstream.  Combine with
    ``set_current_correlation_id`` to install it in the ALS scope.
    """
    return _uuid.uuid4().hex


# ===================================================================
# Result type
# ===================================================================


@dataclass
class GenerateTextResult:
    """Result of a ``generate_text`` call."""

    text: str


# Keep the old name around so existing imports don't break, but the
# public API is ``generate_text(model=..., ...)`` with keyword args.
GenerateTextOptions = None  # deprecated -- will be removed


# ===================================================================
# Public helpers (framework-agnostic)
# ===================================================================


def build_agent_context_block(
    agent_responses: list[dict[str, str]],
) -> str:
    """Format a list of agent responses into a context block string.

    Shared between the AI SDK and LangChain integrations.
    """
    agent_context = "\n\n".join(
        f"--- Response from {r['agent']} ---\n{r['response']}\n"
        f"--- End response from {r['agent']} ---"
        for r in agent_responses
    )

    instruction = (
        "You have received responses from other agents. Use this information "
        "along with your own data to provide a comprehensive answer to the "
        "user's query."
    )

    return f"{instruction}\n\n{agent_context}"


def is_spellguard_agent(agent: ResolvedAgent) -> bool:
    """Check whether a resolved agent is a Spellguard-attested (bilateral) agent."""
    if agent.url == "verifier-routed":
        return True

    auth = agent.agent_card.authentication
    if auth and isinstance(auth.schemes, list) and "spellguard-verifier" in auth.schemes:
        return True

    return False


def is_policy_or_rate_limit_error(error_message: str) -> bool:
    """Check whether an error indicates a policy block or rate limit.

    These are terminal -- the client must NOT fall back to the unguarded path.
    """
    lower = error_message.lower()
    return (
        "blocked by" in lower
        or "blocked:" in lower
        or "policy violation" in lower
        or "too many requests" in lower
        or "rate_limited" in lower
    )


def extract_text_from_response(response: Any) -> str:
    """Extract text from a potentially nested response structure."""
    if isinstance(response, str):
        return response

    if not isinstance(response, dict):
        return json.dumps(response)

    if "response" in response:
        return extract_text_from_response(response["response"])

    if "text" in response and isinstance(response["text"], str):
        return response["text"]

    return json.dumps(response)


# ===================================================================
# Agent routing pipeline
# ===================================================================


async def resolve_and_collect_agent_responses(
    prompt: str,
    detect_fn: Callable[[str], Awaitable[list[str]]] | None = None,
) -> list[dict[str, str]]:
    """Full agent-routing pipeline: detect refs -> filter self -> discover
    agents -> collect responses (with retry).

    Returns ``[]`` when no agents are found or all fail.
    Raises on policy / rate-limit errors.
    """
    from .attestation import get_config
    from .discovery import discover_agents
    from .intent import detect_agent_references, might_contain_agent_reference

    if not might_contain_agent_reference(prompt):
        return []

    _detect = detect_fn or detect_agent_references
    agent_refs = await _detect(prompt)
    config = get_config()
    # Exclude SELF and the immediate inbound SENDER from auto-route targets so
    # a receiver never routes BACK to whoever just messaged it — that would be
    # a 2-node cycle (A->B->A). Keeps the agent-communication graph a DAG. The
    # sender id (lowercased to match the detector's normalized output) comes
    # from the receive handler via the contextvar; it's None for top-level
    # sends and /chat (no inbound), so the sender clause is a no-op there.
    # Deeper cycles (A->B->C->A) are backstopped by the Verifier's
    # MAX_MESSAGE_HOPS.
    self_id = config.agent_id if config else None
    sender_id = get_current_sender_id()
    sender_lower = sender_id.lower() if sender_id else None
    filtered_refs = [
        ref
        for ref in agent_refs
        if ref != self_id
        and (sender_lower is None or ref.lower() != sender_lower)
    ]

    if not filtered_refs:
        return []

    logger.info(
        "[Spellguard] Detected agent references: %s", ", ".join(filtered_refs)
    )

    resolved_agents = await discover_agents(filtered_refs)
    if not resolved_agents:
        logger.warning("[Spellguard] No agents could be discovered")
        return []

    logger.info(
        "[Spellguard] Discovered %d agents: %s",
        len(resolved_agents),
        ", ".join(a.name for a in resolved_agents),
    )

    try:
        return await _collect_agent_responses_with_retry(resolved_agents, prompt)
    except Exception as error:
        msg = str(error)
        if is_policy_or_rate_limit_error(msg):
            raise
        logger.warning(
            "[Spellguard] Agent routing unavailable, falling back to direct LLM: %s",
            msg,
        )
        return []


# ===================================================================
# generate_text -- the only function agent code needs to call
# ===================================================================


async def generate_text(
    *,
    model: Any,
    model_name: str = "google/gemini-2.0-flash-001",
    system: str = "",
    prompt: str = "",
    messages: list[dict[str, Any]] | None = None,
    tools: list[dict[str, Any]] | None = None,
    tool_dispatch: dict[str, Callable[..., Any]] | None = None,
    max_steps: int = 1,
    max_tokens: int = 2048,
    temperature: float | None = None,
) -> GenerateTextResult:
    """Drop-in LLM call with transparent Spellguard agent routing.

    Mirrors the TypeScript ``generateText`` from ``@spellguard/client/ai``:
    detects agent references in *prompt*, collects their responses through
    the Verifier, augments the system prompt, and runs an OpenAI-compatible
    tool-calling loop.

    Args:
        model: An ``AsyncOpenAI`` (or compatible) client instance --
            typically obtained via ``spellguard.model``.
        model_name: Model identifier passed to ``chat.completions.create``.
        system: System prompt.
        prompt: User prompt (mutually exclusive with *messages*).
        messages: Full message list (mutually exclusive with *prompt*).
        tools: OpenAI function-calling tool definitions.
        tool_dispatch: ``{tool_name: handler_fn}`` -- called when the
            model invokes a tool.  Each handler receives the parsed
            arguments dict and must return a JSON-serialisable value.
        max_steps: Maximum number of tool-calling round-trips.
        max_tokens: Token limit per completion call.
        temperature: Sampling temperature (omitted when ``None``).

    Returns:
        A :class:`GenerateTextResult` whose ``.text`` attribute contains the
        final assistant response.
    """
    # 1. Determine the user prompt for agent detection
    user_prompt = prompt
    if not user_prompt and messages:
        user_prompt = "\n".join(
            m["content"] for m in messages if m.get("role") == "user"
        )

    # 2. Transparent agent routing
    agent_responses = await resolve_and_collect_agent_responses(user_prompt)
    augmented_system = system
    if agent_responses:
        context = build_agent_context_block(agent_responses)
        augmented_system = f"{system}\n\n{context}" if system else context
        logger.info("[Spellguard] Augmented system prompt with %d agent responses", len(agent_responses))

    # 3. Build the initial message list
    chat_messages: list[dict[str, Any]] = []
    if augmented_system:
        chat_messages.append({"role": "system", "content": augmented_system})
    if messages:
        chat_messages.extend(messages)
    elif prompt:
        chat_messages.append({"role": "user", "content": prompt})

    # 4. Tool-calling loop
    for _step in range(max_steps):
        kwargs: dict[str, Any] = {
            "model": model_name,
            "messages": chat_messages,
            "max_tokens": max_tokens,
        }
        if tools and tool_dispatch:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        if temperature is not None:
            kwargs["temperature"] = temperature

        response = await model.chat.completions.create(**kwargs)
        # await-and-rewrap usage emit. Fire-and-
        # forget + fail-open -- never affects the LLM call or its return value.
        report_openai_usage(response, model_name)
        choice = response.choices[0]

        # No tool calls -> we're done
        if not choice.message.tool_calls or not tool_dispatch:
            return GenerateTextResult(text=choice.message.content or "")

        # Append assistant message (with tool_calls) to the conversation
        chat_messages.append(choice.message.model_dump())

        # Execute every tool call and append results
        for tc in choice.message.tool_calls:
            fn_name = tc.function.name
            fn_args = json.loads(tc.function.arguments) if tc.function.arguments else {}
            handler = tool_dispatch.get(fn_name)
            if handler:
                result = handler(fn_args)
                # Support async tool dispatchers (e.g. spellguard_tool wrappers)
                if asyncio.iscoroutine(result):
                    result = await result
            else:
                result = {"error": f"Unknown tool: {fn_name}"}
            chat_messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result),
            })

    # Exhausted steps -- get a final response without tools
    final = await model.chat.completions.create(
        model=model_name,
        messages=chat_messages,
        max_tokens=max_tokens,
    )
    # emit the final completion's usage too.
    report_openai_usage(final, model_name)
    return GenerateTextResult(text=final.choices[0].message.content or "")


# ===================================================================
# Internal helpers
# ===================================================================


async def _send_to_agent(
    channel: ClientChannel,
    agent: ResolvedAgent,
    prompt: str,
    from_agent_id: str,
) -> str:
    """Send a request to a single agent (bilateral or unilateral)."""
    if is_spellguard_agent(agent):
        outbound: dict[str, object] = {
            "type": "agent-request",
            "prompt": prompt,
            "from": from_agent_id,
            "context": {"targetAgents": [agent.name]},
            "_spellguardHops": get_current_hops(),
        }
        # Stamp the trace id when we have one in context so the
        # Verifier and the recipient propagate the same
        # correlation_id across this hop.  See receive handler in
        # spellguard.py for the inbound side.
        correlation_id = get_current_correlation_id()
        if correlation_id is not None:
            outbound["_spellguardCorrelationId"] = correlation_id
        response = await channel.send(agent.name, outbound)
        return extract_text_from_response(response)

    logger.info(
        "[Spellguard] Using unilateral attestation for external agent: %s",
        agent.name,
    )
    result = await channel.send_to_a2a(
        agent.url or agent.name,
        {"type": "query", "text": prompt},
    )

    if not result.success:
        raise RuntimeError(
            f"External agent {agent.name} query failed: {result.error}"
        )

    if (
        result.response
        and isinstance(result.response, dict)
        and result.response.get("result")
    ):
        artifacts = result.response["result"].get("artifacts", [])
        if artifacts:
            parts = artifacts[0].get("parts", [])
            if parts:
                return parts[0].get("text", "No response text")
    return "No response text"


async def _collect_agent_responses(
    resolved_agents: list[ResolvedAgent],
    prompt: str,
) -> list[dict[str, str]]:
    from .attestation import get_config, get_or_create_channel

    channel = await get_or_create_channel()
    config = get_config()
    responses: list[dict[str, str]] = []

    for agent in resolved_agents:
        text = await _send_to_agent(
            channel, agent, prompt, config.agent_id if config else "unknown"
        )
        responses.append({"agent": agent.name, "response": text})
        logger.info(
            "[Spellguard] Received response from %s: %s...",
            agent.name,
            text[:100],
        )

    return responses


def _is_transient_error(msg: str) -> bool:
    lower = msg.lower()
    return (
        "channel expired" in lower
        or "recipient not found" in lower
        or "not registered" in lower
        or "policy data unavailable" in lower
        or "fail-closed" in lower
        or "failed to deliver" in lower
    )


async def _collect_agent_responses_with_retry(
    resolved_agents: list[ResolvedAgent],
    prompt: str,
) -> list[dict[str, str]]:
    max_retries = 3
    last_error: Exception | None = None

    for attempt in range(1, max_retries + 1):
        try:
            return await _collect_agent_responses(resolved_agents, prompt)
        except Exception as error:
            msg = str(error)
            last_error = error

            transient = _is_transient_error(msg)
            if transient and attempt < max_retries:
                delay = attempt * 5
                logger.info(
                    "[Spellguard] Retrying after transient error "
                    "(attempt %d/%d, waiting %ds): %s",
                    attempt + 1,
                    max_retries,
                    delay,
                    msg[:120],
                )
                await asyncio.sleep(delay)
                continue

            # Policy/rate-limit errors are terminal — never fallback.
            # Skip when the error was already classified as transient
            # (e.g. "Blocked: policy data unavailable (fail-closed)"
            # matches both _is_transient_error and
            # is_policy_or_rate_limit_error). After retries are exhausted
            # the error should propagate as a non-policy failure so the
            # caller can fall back to the direct LLM path.
            if not transient and is_policy_or_rate_limit_error(msg):
                raise

            logger.error(
                "[Spellguard] Agent routing failed after %d attempt(s): %s",
                attempt,
                msg,
            )
            raise

    raise last_error or RuntimeError("[Spellguard] Agent routing failed")


# ===================================================================
# Spellguard tool wrapper
# ===================================================================


def spellguard_tool(
    fn: Callable[..., Awaitable[Any]] | None = None,
    *,
    name: str | None = None,
) -> Any:
    """
    Wrap an async tool function with Spellguard tool policy checks.

    Input-phase redact is treated as block (cannot meaningfully redact input
    before execution — same behavior as the TypeScript wrapper).

    Supports three usage patterns::

        # 1. Bare decorator
        @spellguard_tool
        async def my_tool(params):
            return "result"

        # 2. Decorator factory with explicit name
        @spellguard_tool(name="myTool")
        async def my_tool(params):
            return "result"

        # 3. Direct call
        wrapped = spellguard_tool(my_tool, name="myTool")
    """

    def _wrap(func: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
        from . import attestation as _att

        tool_name = name or getattr(func, "__name__", "unknown")

        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            # Input phase — collect all args as params
            params = kwargs if kwargs else (args[0] if args else None)
            inp = await _att.check_tool_policy("input", tool_name, params)
            if inp.effect == "block":
                return inp.message or "[BLOCKED]"
            if inp.effect == "redact":
                return inp.message or "[BLOCKED]"

            result = await func(*args, **kwargs)

            # Output phase
            out = await _att.check_tool_policy("output", tool_name, params, result)
            if out.effect == "block":
                return out.message or "[BLOCKED]"
            if out.effect == "redact":
                return out.data

            return result

        wrapper.__name__ = tool_name  # type: ignore[attr-defined]
        wrapper.__doc__ = func.__doc__
        return wrapper

    # Called as @spellguard_tool (bare) — fn is the decorated function
    if fn is not None:
        return _wrap(fn)

    # Called as @spellguard_tool(name="...") — return the decorator
    return _wrap
