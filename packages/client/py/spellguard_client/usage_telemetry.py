# SPDX-License-Identifier: Apache-2.0
#
# Source B -- self-reported SDK token telemetry, Python mirror of the TS
# ``usage-telemetry.ts``. The instrumented LLM call paths (``generate_text``,
# ``intent``, the LangChain adapter) emit a per-call token-usage event here; this
# fires a direct, agent-authenticated ``POST /v1/agents/:id/usage`` to Management
# (Decision A -- the Verifier adds no trust for self-reported numbers).
#
# LOAD-BEARING -- fail-open + off the critical path (S6.2). This runs INSIDE the
# agent we are policing, so it must NEVER raise into, block, or slow the user's
# LLM call, and a compromised agent simply not emitting is expected. It is
# therefore fire-and-forget and swallows every error. Self-reported tokens drive
# dashboards + observe/alert limits ONLY -- never a hard key-disabling stop.

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

_EMIT_TIMEOUT_S = 5.0


@dataclass
class UsageEvent:
    """One self-reported usage event (snake_case here; serialized camelCase)."""

    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cached_input_tokens: int = 0
    reasoning_tokens: int = 0


def _clamp_int(v: Any) -> int:
    """Coerce to a non-negative int; junk -> 0 (self-reported counts untrusted)."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def _resolve_base_url(cfg: Any) -> str | None:
    """Management base URL (no trailing /v1): config, then env. None -> skip."""
    raw = (
        getattr(cfg, "management_url", None)
        or os.environ.get("SPELLGUARD_MANAGEMENT_URL")
        or os.environ.get("SPELLGUARD_BASE_URL")
    )
    if not raw:
        return None
    return re.sub(r"/v1/?$", "", raw).rstrip("/")


def _to_wire(event: UsageEvent) -> dict[str, Any] | None:
    """Normalize + clamp to the camelCase wire shape; None when all-zero."""
    prompt = _clamp_int(event.prompt_tokens)
    completion = _clamp_int(event.completion_tokens)
    total = _clamp_int(event.total_tokens)
    if prompt == 0 and completion == 0 and total == 0:
        return None
    wire: dict[str, Any] = {
        "model": event.model if isinstance(event.model, str) else "unknown",
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": total,
    }
    cached = _clamp_int(event.cached_input_tokens)
    reasoning = _clamp_int(event.reasoning_tokens)
    if cached > 0:
        wire["cachedInputTokens"] = cached
    if reasoning > 0:
        wire["reasoningTokens"] = reasoning
    return wire


async def report_usage_async(
    event: UsageEvent,
    *,
    config: Any = None,
    http_client: Any = None,
) -> None:
    """Fail-open: never raises. POSTs one usage event to Management.

    Skips silently when the agent has no secret / no known management URL, or
    when the event is all-zero. ``http_client`` (an httpx.AsyncClient-like with
    ``.post``) is for tests; production opens a short-lived client.
    """
    try:
        if config is not None:
            cfg = config
        else:
            # Lazy import avoids a circular import: attestation -> ai ->
            # usage_telemetry -> attestation at module load.
            from .attestation import get_config

            cfg = get_config()
        agent_id = getattr(cfg, "agent_id", None)
        agent_secret = getattr(cfg, "agent_secret", None)
        if not agent_id or not agent_secret:
            return  # can't authenticate -> skip
        base = _resolve_base_url(cfg)
        if not base:
            return
        wire = _to_wire(event)
        if wire is None:
            return
        url = f"{base}/v1/agents/{agent_id}/usage"
        headers = {
            "Authorization": f"Bearer {agent_secret}",
            "Content-Type": "application/json",
        }
        body = {"events": [wire]}
        if http_client is not None:
            await http_client.post(url, json=body, headers=headers)
        else:
            async with httpx.AsyncClient(timeout=_EMIT_TIMEOUT_S) as client:
                await client.post(url, json=body, headers=headers)
    except Exception:
        return  # fail-open -- telemetry must never affect the LLM call


def report_usage_event(
    event: UsageEvent | None,
    *,
    config: Any = None,
    http_client: Any = None,
) -> asyncio.Task[None] | None:
    """Fire-and-forget + fail-open emit. Schedules the POST on the running event
    loop (non-blocking) and returns the Task; returns None when there is no event
    or no running loop (best-effort -- never raises)."""
    if event is None:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        try:
            return loop.create_task(
                report_usage_async(event, config=config, http_client=http_client)
            )
        except Exception:
            return None
    # No running loop (e.g. LangChain's sync `_generate`): fire-and-forget on a
    # daemon thread so the emit stays off the caller's critical path. A passed-in
    # http_client can't safely cross loops, so the thread path opens its own.
    try:
        import threading

        def _run() -> None:
            try:
                asyncio.run(report_usage_async(event, config=config))
            except Exception:
                pass

        threading.Thread(target=_run, daemon=True).start()
    except Exception:
        return None
    return None


def usage_event_from_openai(response: Any, model_name: str) -> UsageEvent | None:
    """Build a UsageEvent from an OpenAI-SDK ChatCompletion; None if no usage."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    return UsageEvent(
        model=model_name,
        prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
        completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
        total_tokens=getattr(usage, "total_tokens", 0) or 0,
    )


def report_openai_usage(
    response: Any,
    model_name: str,
    *,
    config: Any = None,
    http_client: Any = None,
) -> asyncio.Task[None] | None:
    """Convenience: build from an OpenAI response + emit, in one fail-open call."""
    try:
        event = usage_event_from_openai(response, model_name)
    except Exception:
        return None
    return report_usage_event(event, config=config, http_client=http_client)
