# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client - Spellguard Instance & FastAPI Integration

``create_spellguard()`` returns a ``SpellguardInstance`` that manages
configuration, model lifecycle, and a FastAPI app for Verifier callbacks,
agent card serving, and health checks.

Usage from an agent developer's perspective::

    from spellguard_client import create_spellguard
    from spellguard_client.ai import generate_text

    spellguard = create_spellguard(
        agent_card={"name": "my-agent", "url": "", "skills": [...]},
        config=lambda: {"type": "direct", "agent_id": "my-agent", ...},
        model=lambda: AsyncOpenAI(api_key="..."),
        on_message=on_message,
    )

    app = spellguard.app()          # FastAPI app with Spellguard routes
    model = spellguard.model         # The initialised AsyncOpenAI client

    @app.post("/chat")
    async def chat(request: Request):
        result = await generate_text(
            model=spellguard.model,
            model_name="gpt-4o",
            system="You are helpful.",
            prompt=body["message"],
        )
        return {"response": result.text}
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from spellguard_ctls.types import (
    AgentCard,
    AgentCardAuthentication,
    AgentCardCapabilities,
    AgentCardSkill,
)

from .ai import set_current_correlation_id, set_current_hops
from .attestation import configure, discover_and_configure, get_config, get_or_create_channel
from .intent import set_intent_detect_fn, set_intent_detection_model
from .types import (
    DirectConfig,
    ManagedConfig,
    MessageContext,
    SpellguardConfig,
    SpellguardConfigMode,
    SpellguardDiscoveryConfig,
    SpellguardOptions,
)

logger = logging.getLogger("spellguard")


# ===================================================================
# Dict → dataclass converters
# ===================================================================


def _to_agent_card(val: AgentCard | dict[str, Any]) -> AgentCard:
    """Accept either an ``AgentCard`` dataclass or a plain dict."""
    if isinstance(val, AgentCard):
        return val
    if not isinstance(val, dict):
        raise TypeError(f"agent_card: expected AgentCard or dict, got {type(val)}")

    skills = [
        AgentCardSkill(**s) if isinstance(s, dict) else s
        for s in val.get("skills", [])
    ]
    caps = val.get("capabilities")
    if isinstance(caps, dict):
        caps = AgentCardCapabilities(
            streaming=caps.get("streaming"),
            push_notifications=caps.get("pushNotifications"),
        )
    auth = val.get("authentication")
    if isinstance(auth, dict):
        auth = AgentCardAuthentication(schemes=auth.get("schemes", []))

    return AgentCard(
        name=val.get("name", ""),
        url=val.get("url", ""),
        skills=skills,
        description=val.get("description"),
        version=val.get("version"),
        capabilities=caps,
        authentication=auth,
    )


def _to_config_mode(val: Any) -> SpellguardConfigMode:
    """Accept either a config dataclass or a plain dict."""
    if isinstance(val, (ManagedConfig, DirectConfig)):
        return val
    if isinstance(val, dict):
        if val.get("type") == "managed":
            return ManagedConfig(
                type="managed",
                agent_id=val.get("agent_id", ""),
                management_url=val.get("management_url", ""),
                self_url=val.get("self_url", ""),
                code_hash=val.get("code_hash", ""),
                agent_secret=val.get("agent_secret"),
                platform_attestation=val.get("platform_attestation"),
            )
        return DirectConfig(
            type="direct",
            agent_id=val.get("agent_id", ""),
            verifier_url=val.get("verifier_url", "http://localhost:3000"),
            self_url=val.get("self_url", ""),
            code_hash=val.get("code_hash", ""),
            expected_verifier_image_hash=val.get(
                "expected_verifier_image_hash", "sha384:dev-placeholder"
            ),
            agent_secret=val.get("agent_secret"),
        )
    raise TypeError(f"config: expected ManagedConfig, DirectConfig, or dict, got {type(val)}")


# ===================================================================
# SpellguardInstance
# ===================================================================


class SpellguardInstance:
    """Manages Spellguard configuration, model lifecycle, and a FastAPI
    app with lazy init, Verifier callbacks, agent card, and health check.
    """

    def __init__(self, options: SpellguardOptions) -> None:
        self._options = options
        self._resolved_model: Any | None = None
        self._init_promise: asyncio.Task[None] | None = None
        self._init_started_at: float = 0
        self._init_lock = asyncio.Lock()
        self._fastapi_app: FastAPI | None = None

        self._INIT_STALE_S = 30.0
        self._SKIP_INIT_PATHS = {
            "/_spellguard/health",
            "/.well-known/agent.json",
            "/health",
        }

    # --- public properties ------------------------------------------

    @property
    def model(self) -> Any:
        """The initialised model / client (e.g. ``AsyncOpenAI``).

        Available after the first non-skip request triggers lazy init.
        """
        return self._resolved_model

    # keep the old accessor for backwards compat
    def get_model(self) -> Any:
        return self._resolved_model

    def app(self) -> FastAPI:
        """Return (or create) the FastAPI app.

        The app already includes Spellguard routes
        (``/_spellguard/receive``, ``/.well-known/agent.json``,
        ``/_spellguard/health``) and a lazy-init middleware.
        Agent developers add their own routes directly to this app.
        """
        if self._fastapi_app is not None:
            return self._fastapi_app

        fastapi_app = FastAPI()
        self._fastapi_app = fastapi_app

        @fastapi_app.middleware("http")
        async def _lazy_init_middleware(
            request: Request, call_next: Any
        ) -> Response:
            if request.url.path not in self._SKIP_INIT_PATHS:
                await self._ensure_initialized()
            return await call_next(request)

        @fastapi_app.post("/_spellguard/receive")
        async def _receive(request: Request) -> Response:
            channel_token = request.headers.get("x-spellguard-channel-token")
            if not channel_token:
                return JSONResponse(
                    {"error": "Missing channel token"}, status_code=401
                )

            try:
                body = await request.json()
            except Exception:
                return JSONResponse(
                    {"error": "Invalid JSON body"}, status_code=400
                )

            message = body.get("message")
            sender_id = body.get("senderId")
            message_id = body.get("messageId")

            if not message or not sender_id:
                return JSONResponse(
                    {"error": "Missing required fields"}, status_code=400
                )

            logger.info(
                "[Spellguard] Received message %s from %s",
                message_id,
                sender_id,
            )

            try:
                # Extract hops + correlation id stamped by the
                # Verifier so any outbound _send_to_agent call
                # within this async context carries them forward.
                # Both fields ride on the inbound payload from
                # the Verifier router (see verifier/proxy/router.ts
                # forwardToRecipient).  hops drives the
                # MAX_MESSAGE_HOPS guard; correlation id keeps the
                # whole conversation under one audit_logs.correlation_id.
                hops = 0
                correlation_id: str | None = None
                if isinstance(message, dict):
                    raw_hops = message.get("_spellguardHops", 0)
                    hops = raw_hops if isinstance(raw_hops, int) else 0
                    raw_corr = message.get("_spellguardCorrelationId")
                    if isinstance(raw_corr, str) and raw_corr:
                        correlation_id = raw_corr

                hop_token = set_current_hops(hops)
                corr_token = set_current_correlation_id(correlation_id)
                try:
                    ctx = MessageContext(
                        message=message,
                        sender_id=sender_id,
                        model=self._resolved_model,
                    )
                    result = await self._options.on_message(ctx)
                finally:
                    # Reset to previous values even if on_message raises
                    from .ai import _current_correlation_id, _current_hops

                    _current_hops.reset(hop_token)
                    _current_correlation_id.reset(corr_token)
                return JSONResponse({"success": True, "response": result})
            except Exception as error:
                logger.error(
                    "[Spellguard] Error handling message: %s", error
                )
                return JSONResponse(
                    {
                        "error": "Failed to process message",
                        "details": str(error),
                    },
                    status_code=500,
                )

        @fastapi_app.get("/.well-known/agent.json")
        async def _agent_card() -> Response:
            global_config = get_config()
            base_card = (
                global_config.agent_card
                if (
                    not self._options.agent_card.url
                    and global_config
                    and global_config.agent_card
                )
                else self._options.agent_card
            )

            card_url = base_card.url
            if not card_url:
                cfg = self._resolve_config()
                card_url = cfg.self_url

            card_dict: dict[str, Any] = {
                "name": base_card.name,
                "url": card_url,
                "skills": [
                    {"id": s.id, "name": s.name, "description": s.description}
                    for s in base_card.skills
                ],
                "authentication": {"schemes": ["spellguard-verifier"]},
            }
            if base_card.description:
                card_dict["description"] = base_card.description
            if base_card.version:
                card_dict["version"] = base_card.version
            if base_card.capabilities:
                caps: dict[str, Any] = {}
                if base_card.capabilities.streaming is not None:
                    caps["streaming"] = base_card.capabilities.streaming
                if base_card.capabilities.push_notifications is not None:
                    caps["pushNotifications"] = (
                        base_card.capabilities.push_notifications
                    )
                if caps:
                    card_dict["capabilities"] = caps

            return JSONResponse(card_dict)

        @fastapi_app.get("/_spellguard/health")
        async def _health() -> Response:
            global_config = get_config()
            agent_id = (
                global_config.agent_id
                if global_config
                else self._resolve_config().agent_id
            )
            return JSONResponse({"status": "ok", "agentId": agent_id})

        return fastapi_app

    # --- internal ---------------------------------------------------

    def _resolve_config(self) -> SpellguardConfigMode:
        cfg = self._options.config
        if callable(cfg):
            raw = cfg()
        else:
            raw = cfg
        return _to_config_mode(raw) if isinstance(raw, dict) else raw

    async def _ensure_initialized(self) -> None:
        async with self._init_lock:
            if (
                self._init_promise is not None
                and time.time() - self._init_started_at > self._INIT_STALE_S
            ):
                logger.warning(
                    "[Spellguard] Clearing stale init promise, retrying"
                )
                self._init_promise = None

            if self._init_promise is None:
                self._init_started_at = time.time()
                self._init_promise = asyncio.ensure_future(self._initialize())

        try:
            await self._init_promise
        except Exception:
            async with self._init_lock:
                self._init_promise = None
            raise

    async def _initialize(self) -> None:
        cfg = self._resolve_config()

        # Auto-fill agentCard.url from config.selfUrl when empty
        agent_card = self._options.agent_card
        if not agent_card.url:
            from dataclasses import replace

            agent_card = replace(agent_card, url=cfg.self_url)

        if isinstance(cfg, ManagedConfig):
            await discover_and_configure(
                SpellguardDiscoveryConfig(
                    agent_id=cfg.agent_id,
                    agent_secret=cfg.agent_secret,
                    management_url=cfg.management_url,
                    self_url=cfg.self_url,
                    code_hash=cfg.code_hash,
                    agent_card=agent_card,
                    platform_attestation=cfg.platform_attestation,
                )
            )
        else:
            configure(
                SpellguardConfig(
                    agent_id=cfg.agent_id,
                    verifier_url=cfg.verifier_url,
                    self_url=cfg.self_url,
                    code_hash=cfg.code_hash,
                    expected_verifier_image_hash=cfg.expected_verifier_image_hash,
                    agent_secret=cfg.agent_secret,
                    agent_card=agent_card,
                )
            )
            # Eagerly register with Verifier so this agent is discoverable
            # by other agents via /agents/resolve/:name (matches the
            # managed path which does this inside discover_and_configure).
            try:
                await asyncio.wait_for(get_or_create_channel(), timeout=15.0)
                logger.info(
                    "[Spellguard] Pre-registered with Verifier for discovery"
                )
            except Exception as error:
                logger.warning(
                    "[Spellguard] Pre-registration failed "
                    "(will retry on first send): %s",
                    error,
                )

        # Resolve the main model
        if self._options.model is not None:
            m = self._options.model
            if callable(m) and not isinstance(m, dict):
                self._resolved_model = m()
            elif isinstance(m, dict) and "model" in m:
                self._resolved_model = m["model"]
            else:
                self._resolved_model = m

        # Set intent detection model if provided
        raw_intent = self._options.intent_detection_model
        if raw_intent is not None:
            if callable(raw_intent) and not isinstance(raw_intent, dict):
                resolved = raw_intent()
            elif isinstance(raw_intent, dict) and "model" in raw_intent:
                resolved = raw_intent["model"]
            else:
                resolved = raw_intent

            if callable(resolved):
                set_intent_detect_fn(resolved)
            else:
                set_intent_detection_model(resolved)

        if self._options.on_initialized:
            await self._options.on_initialized()

        logger.info("[Spellguard] Initialization complete")


# ===================================================================
# Factory function
# ===================================================================


def create_spellguard(
    options: SpellguardOptions | None = None,
    *,
    agent_card: AgentCard | dict[str, Any] | None = None,
    config: Any | None = None,
    on_message: Callable[[MessageContext], Awaitable[Any]] | None = None,
    model: Any | None = None,
    intent_detection_model: Any | None = None,
    on_initialized: Callable[..., Any] | None = None,
) -> SpellguardInstance:
    """Create a Spellguard instance.

    Can be called with a ``SpellguardOptions`` dataclass **or** with
    keyword arguments (the developer-friendly form)::

        # Keyword form (preferred for agent code):
        sg = create_spellguard(
            agent_card={"name": "my-agent", "url": "", "skills": [...]},
            config=lambda: {"type": "direct", ...},
            model=lambda: AsyncOpenAI(...),
            on_message=handle,
        )

        # Dataclass form (for library / adapter code):
        sg = create_spellguard(SpellguardOptions(...))
    """
    if options is not None:
        return SpellguardInstance(options)

    if agent_card is None or config is None or on_message is None:
        raise TypeError(
            "create_spellguard() requires either a SpellguardOptions "
            "object or at minimum agent_card=, config=, and on_message= "
            "keyword arguments."
        )

    return SpellguardInstance(
        SpellguardOptions(
            agent_card=_to_agent_card(agent_card),
            config=config,
            on_message=on_message,
            model=model,
            intent_detection_model=intent_detection_model,
            on_initialized=on_initialized,
        )
    )


def verify_verifier_request(channel_token: str) -> bool:
    """Verify that a request came from the Verifier."""
    return bool(channel_token) and len(channel_token) > 0
