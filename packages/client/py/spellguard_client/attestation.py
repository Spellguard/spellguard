# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client - Attestation & Channel Management

Module-level state for the current configuration and channel, plus
functions for configuring, discovering, and creating secure channels
to the Verifier.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx

from spellguard_amp.client import encrypt_for_verifier
from spellguard_amp.types import UnilateralSendResult

# Hop-context helpers live in `ai.py` (mirrors TS layout where they're in
# `hop-context.ts`).  ai.py imports only from `.types`, so no circular risk.
from .ai import get_current_correlation_id, get_current_hops
from spellguard_ctls.client.verifier_verify import fetch_and_verify_verifier
from spellguard_ctls.crypto.signing import sign

from .types import (
    ClientChannel,
    ResolvedAgent,
    SpellguardConfig,
    SpellguardDiscoveryConfig,
    UnilateralSendOptions,
)

logger = logging.getLogger("spellguard")

# ===================================================================
# Module-level state
# ===================================================================

_current_config: SpellguardConfig | None = None
# Store the resolved channel directly (not an asyncio.Task) so the value
# is safely accessible from any thread / event-loop — required because
# CrewAI's SpellguardRouteTool runs ``asyncio.run()`` on a worker thread.
_cached_channel: ChannelImpl | None = None
# threading.Lock is thread-safe (unlike asyncio.Lock) and can guard
# state shared between FastAPI's event-loop thread and CrewAI's worker.
_channel_lock = threading.Lock()


# ===================================================================
# Discovery response shape
# ===================================================================


@dataclass
class DiscoveryResponse:
    """Response shape from POST /v1/discover on the Management Server."""

    verifier_url: str
    verifier_public_key: str
    verifier_region: str
    verifier_id: str
    management_token: str
    refresh_interval: int
    issued_at: int
    expires_at: int
    signature: str
    verifier_image_hash: str | None = None


# ===================================================================
# Public API
# ===================================================================


def configure(config: SpellguardConfig) -> None:
    """Configure the Spellguard client.

    Must be called before ``get_or_create_channel()``.
    """
    global _current_config, _cached_channel
    _current_config = config
    # Reset channel if config changes
    with _channel_lock:
        _cached_channel = None


async def get_or_create_channel() -> ClientChannel:
    """Get or create a channel to the Verifier.

    Handles implicit channel establishment via attestation.

    Thread-safe: may be called from FastAPI's event loop **and** from
    CrewAI worker threads that spin up their own ``asyncio.run()`` loop.
    """
    global _cached_channel

    if _current_config is None:
        raise RuntimeError("Spellguard not configured. Call configure() first.")

    # Fast path — channel already exists (thread-safe read under lock).
    with _channel_lock:
        if _cached_channel is not None:
            return _cached_channel

    # Slow path — create a new channel.  The async I/O happens outside the
    # lock so we don't block other threads.  If two callers race here, the
    # second ``_create_channel`` will get a 409 "already registered" from
    # the Verifier; we catch that and return whichever channel was stored first.
    try:
        channel = await _create_channel(_current_config)
    except Exception:
        # If someone else won the race while we were creating, use theirs.
        with _channel_lock:
            if _cached_channel is not None:
                return _cached_channel
        raise

    with _channel_lock:
        if _cached_channel is None:
            _cached_channel = channel
        return _cached_channel


async def discover_and_configure(
    config: SpellguardDiscoveryConfig,
) -> dict[str, Any]:
    """Discover a Verifier via the Management Server and configure the client.

    Calls ``POST {management_url}/discover`` with the agent's credentials,
    receives the assigned Verifier URL, then calls ``configure()`` with a resolved
    config.

    Returns the full discovery response (including ``management_token`` for
    refresh).
    """
    headers: dict[str, str] = {"Content-Type": "application/json"}

    # Add agent secret header if provided (required for secret/dual auth mode)
    if config.agent_secret:
        headers["X-Spellguard-Agent-Secret"] = config.agent_secret

    # Add platform attestation header if providers are configured
    if config.platform_attestation and config.platform_attestation.providers:
        tokens = []
        for p in config.platform_attestation.providers:
            token = await p.get_token()
            tokens.append({"provider": p.provider, "token": token})
        headers["X-Spellguard-Platform-Attestation"] = base64.b64encode(
            json.dumps(tokens).encode()
        ).decode()

    body: dict[str, Any] = {"agentId": config.agent_id}
    if config.region:
        body["region"] = config.region
    if config.capabilities:
        body["capabilities"] = config.capabilities

    # Mirror the TS attestation.ts normalization: callers in this codebase
    # split between including `/v1` and omitting it (legacy CF Worker agents
    # vs the managed-provisioning bootstrap). Strip trailing `/v1` then
    # re-append so the SDK accepts either convention. Matches the existing
    # idiom used by plugin-sync.ts, verifier-state.ts, etc.
    base_url = re.sub(r"/v1/?$", "", config.management_url).rstrip("/")
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{base_url}/v1/discover",
            headers=headers,
            json=body,
            timeout=10.0,
        )

    if response.status_code != 200:
        error = response.text
        raise RuntimeError(f"Discovery failed: {response.status_code} {error}")

    discovery = response.json()

    # Configure the client with the resolved Verifier URL.
    # Use the real Verifier image hash from discovery when available so agents
    # perform genuine attestation verification on staging/production.
    # Fall back to 'sha384:dev-placeholder' only when the management
    # server hasn't recorded the Verifier's image hash yet (local dev).
    configure(
        SpellguardConfig(
            agent_id=config.agent_id,
            verifier_url=discovery["verifierUrl"],
            self_url=config.self_url,
            code_hash=config.code_hash,
            expected_verifier_image_hash=discovery.get("verifierImageHash")
            or "sha384:dev-placeholder",
            agent_secret=config.agent_secret,
            signing_private_key=config.signing_private_key,
            management_token=discovery["managementToken"],
            # Normalized base (no /v1) so the Tier-3 usage emit can reach
            # Management directly; the emit helper appends
            # /v1/agents/:id/usage.
            management_url=base_url,
            agent_card=config.agent_card,
        )
    )

    logger.info(
        "[Spellguard] Discovered Verifier at %s (region: %s)",
        discovery["verifierUrl"],
        discovery["verifierRegion"],
    )

    # Eagerly create the channel so this agent registers with the Verifier
    # and becomes discoverable by other agents via /agents/resolve/:name.
    pre_reg_timeout = 15.0
    try:
        await asyncio.wait_for(get_or_create_channel(), timeout=pre_reg_timeout)
        logger.info("[Spellguard] Pre-registered with Verifier for discovery")
    except Exception as error:
        logger.warning(
            "[Spellguard] Pre-registration failed (will retry on first send): %s",
            error,
        )

    # No agent-side SLIM awareness: the agent only knows its Verifier
    # URL (which points at the gateway in slim mode). The verifier
    # derives the agent's slimName from the CTLS registration above and
    # pushes the slimName → callback-URL mapping to the gateway via a
    # SLIM control message. Nothing for the Python client to do here.

    return discovery


def get_config() -> SpellguardConfig | None:
    """Get current configuration."""
    return _current_config


def invalidate_channel() -> None:
    """Invalidate the cached channel (forces re-registration on next use)."""
    global _cached_channel
    with _channel_lock:
        _cached_channel = None
    logger.info(
        "[Spellguard] Channel invalidated, will re-register on next request"
    )


def reset() -> None:
    """Reset client state (for testing)."""
    global _cached_channel, _current_config
    with _channel_lock:
        _cached_channel = None
    _current_config = None


# ===================================================================
# Internal: channel creation
# ===================================================================


async def _create_channel(config: SpellguardConfig) -> ChannelImpl:
    """Create a new channel to the Verifier with bidirectional attestation."""
    logger.info("[Spellguard] Creating channel for %s...", config.agent_id)

    # Step 1: Verify Verifier before sending any secrets
    is_mock_mode = config.expected_verifier_image_hash in (
        "sha384:dev-placeholder",
    ) or config.expected_verifier_image_hash.startswith("sha384:dev")

    verifier_verification = await fetch_and_verify_verifier(
        config.verifier_url,
        config.expected_verifier_image_hash,
        {"mock_mode": is_mock_mode},
    )

    if not verifier_verification.verified:
        raise RuntimeError(
            f"Verifier attestation failed: {verifier_verification.error}\n"
            "This could indicate a compromised or fake Verifier. Connection refused."
        )

    logger.info("[Spellguard] Verifier verified successfully")

    # Step 2: Build and sign evidence
    claims = {
        "codeHash": config.code_hash,
        "endpoint": f"{config.self_url}/_spellguard/receive",
        "agentCardUrl": f"{config.self_url}/.well-known/agent.json",
        "capabilities": ["receive", "send"],
    }

    evidence_data = json.dumps({"agentId": config.agent_id, "claims": claims})
    signing_key = config.signing_private_key or config.code_hash
    signature = await sign(evidence_data, signing_key)

    evidence = {
        "agentId": config.agent_id,
        "claims": claims,
        "signature": signature,
    }

    # Step 3: Register with Verifier
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if config.agent_secret:
        headers["X-Spellguard-Agent-Secret"] = config.agent_secret
    if config.management_token:
        headers["X-Spellguard-Management-Token"] = config.management_token

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{config.verifier_url}/agents/register",
            headers=headers,
            json={"evidence": evidence},
            timeout=10.0,
        )

    if response.status_code != 200:
        error = response.text
        raise RuntimeError(
            f"Failed to register with Verifier: {response.status_code} {error}"
        )

    attestation = response.json()

    if not attestation.get("verified"):
        raise RuntimeError("Verifier rejected our evidence")

    expires_at = attestation.get("expiresAt", 0)
    logger.info(
        "[Spellguard] Channel established. Token expires: %s",
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at / 1000)),
    )

    return ChannelImpl(
        config=config,
        channel_token=attestation["channelToken"],
        session_public_key=attestation["sessionPublicKey"],
        session_x25519_public_key=attestation.get("sessionX25519PublicKey"),
    )


# ===================================================================
# Channel implementation
# ===================================================================


class ChannelImpl:
    """Channel implementation that satisfies the ``ClientChannel`` protocol."""

    def __init__(
        self,
        config: SpellguardConfig,
        channel_token: str,
        session_public_key: str,
        session_x25519_public_key: str | None = None,
    ) -> None:
        self._config = config
        self._channel_token = channel_token
        self._session_public_key = session_public_key
        self._session_x25519_public_key = session_x25519_public_key
        self._closed = False
        self._is_retry = False

    # --- accessors --------------------------------------------------

    @property
    def verifier_url(self) -> str:
        """Get the Verifier URL for direct API calls."""
        return self._config.verifier_url

    @property
    def channel_token(self) -> str:
        """Get the channel token for authenticated Verifier requests."""
        return self._channel_token

    @property
    def agent_id(self) -> str:
        """Get the agent ID associated with this channel."""
        return self._config.agent_id

    # --- send -------------------------------------------------------

    async def send(self, recipient: str, payload: Any) -> Any:
        """Send a message to another agent through Verifier."""
        if self._closed:
            raise RuntimeError("Channel is closed")

        # Encrypt payload for Verifier using X25519 key (falls back to Ed25519 key)
        payload_json = json.dumps(payload)
        encryption_key = self._session_x25519_public_key or self._session_public_key
        encrypted_payload = encrypt_for_verifier(payload_json, encryption_key)

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{self._config.verifier_url}/messages/send",
                headers={
                    "Content-Type": "application/json",
                    "X-Spellguard-Channel-Token": self._channel_token,
                },
                json={
                    "sender": self._config.agent_id,
                    "recipient": recipient,
                    "encryptedPayload": encrypted_payload,
                },
            )

        if response.status_code != 200:
            error = response.text

            # Check if we need to re-register (Verifier might have restarted)
            if (
                "Sender not registered" in error
                or "Invalid or expired" in error
                or response.status_code == 401
            ):
                logger.info(
                    "[Spellguard] Channel token stale, re-registering..."
                )
                # Invalidate cached channel and retry with a fresh channel (once)
                if not self._is_retry:
                    invalidate_channel()
                    new_channel = await get_or_create_channel()
                    assert isinstance(new_channel, ChannelImpl)
                    new_channel._is_retry = True
                    try:
                        return await new_channel.send(recipient, payload)
                    finally:
                        new_channel._is_retry = False

            raise RuntimeError(
                f"Failed to send message: {response.status_code} {error}"
            )

        result = response.json()
        return result.get("response")

    # --- send_with_agent_context ------------------------------------

    async def send_with_agent_context(
        self,
        *,
        original_prompt: str,
        target_agents: list[ResolvedAgent],
        model: Any,
    ) -> Any:
        """Send a prompt with agent context through Verifier."""
        if not target_agents:
            raise RuntimeError("No target agents specified")

        # For now, send to the first target agent
        target_agent = target_agents[0]

        payload = {
            "type": "agent-request",
            "prompt": original_prompt,
            "from": self._config.agent_id,
            "context": {
                "targetAgents": [a.name for a in target_agents],
            },
        }

        return await self.send(target_agent.name, payload)

    # --- send_to_model ----------------------------------------------

    async def send_to_model(self, options: Any) -> Any:
        """Send directly to AI model through Verifier."""
        raise NotImplementedError(
            "Direct model calls not yet implemented through Verifier"
        )

    # --- send_to_a2a ------------------------------------------------

    async def send_to_a2a(
        self,
        a2a_agent_url: str,
        payload: Any,
        options: UnilateralSendOptions | None = None,
    ) -> UnilateralSendResult:
        """Send a message to an A2A-only agent through Verifier (unilateral attestation)."""
        if self._closed:
            raise RuntimeError("Channel is closed")

        # Stamp trace context (hops + correlation id) onto the payload before
        # encryption so the Verifier and the recipient can keep multi-hop
        # conversations linked under a single audit_logs.correlation_id.
        # Caller-set _spellguard* fields win, so explicit overrides at the
        # call site are preserved.  Mirrors the TS pattern in attestation.ts
        # (stampTraceContext) and the bilateral stamp in ai.py.
        if isinstance(payload, dict):
            stamped: dict[str, Any] = dict(payload)
            if "_spellguardHops" not in stamped:
                stamped["_spellguardHops"] = get_current_hops()
            if "_spellguardCorrelationId" not in stamped:
                correlation_id = get_current_correlation_id()
                if correlation_id is not None:
                    stamped["_spellguardCorrelationId"] = correlation_id
            payload = stamped

        # Encrypt payload for Verifier using X25519 key (falls back to Ed25519 key)
        payload_json = json.dumps(payload)
        encryption_key = self._session_x25519_public_key or self._session_public_key
        encrypted_payload = encrypt_for_verifier(payload_json, encryption_key)

        method = (options.method if options and options.method else "tasks/send")

        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{self._config.verifier_url}/messages/unilateral",
                headers={
                    "Content-Type": "application/json",
                    "X-Spellguard-Channel-Token": self._channel_token,
                },
                json={
                    "sender": self._config.agent_id,
                    "a2aAgentUrl": a2a_agent_url,
                    "payload": encrypted_payload,
                    "method": method,
                },
            )

        if response.status_code != 200:
            try:
                error_data = response.json()
            except Exception:
                error_data = {}

            # Check if we need to re-register (Verifier might have restarted)
            error_msg = error_data.get("error", "")
            if (
                "Invalid or expired" in error_msg
                or "Sender not registered" in error_msg
                or response.status_code == 401
            ):
                # Retry once with a fresh channel
                if not self._is_retry:
                    logger.info(
                        "[Spellguard] Channel token stale during A2A send, "
                        "re-registering..."
                    )
                    invalidate_channel()
                    new_channel = await get_or_create_channel()
                    assert isinstance(new_channel, ChannelImpl)
                    new_channel._is_retry = True
                    try:
                        return await new_channel.send_to_a2a(
                            a2a_agent_url, payload, options
                        )
                    finally:
                        new_channel._is_retry = False

            from spellguard_amp.types import (
                UnilateralCommitmentIds,
                UnilateralCommitments,
            )

            return UnilateralSendResult(
                success=False,
                correlation_id=error_data.get("correlationId", ""),
                error=error_data.get("error")
                or f"Request failed: {response.status_code}",
                commitments=UnilateralCommitments(
                    outbound=UnilateralCommitmentIds()
                ),
                warnings=error_data.get("warnings"),
            )

        data = response.json()
        from spellguard_amp.types import (
            UnilateralCommitmentIds,
            UnilateralCommitments,
        )

        inbound_raw = data.get("commitments", {}).get("inbound")
        return UnilateralSendResult(
            success=data.get("success", False),
            correlation_id=data.get("correlationId", ""),
            response=data.get("response"),
            error=data.get("error"),
            commitments=UnilateralCommitments(
                outbound=UnilateralCommitmentIds(
                    commitment_id=data.get("commitments", {})
                    .get("outbound", {})
                    .get("commitmentId"),
                    archive_id=data.get("commitments", {})
                    .get("outbound", {})
                    .get("archiveId"),
                ),
                inbound=UnilateralCommitmentIds(
                    commitment_id=inbound_raw.get("commitmentId"),
                    archive_id=inbound_raw.get("archiveId"),
                )
                if inbound_raw
                else None,
            ),
            warnings=data.get("warnings"),
        )

    # --- close ------------------------------------------------------

    def close(self) -> None:
        """Close the channel."""
        self._closed = True
        logger.info(
            "[Spellguard] Channel closed for %s", self._config.agent_id
        )


# ===================================================================
# Tool policy check
# ===================================================================


@dataclass
class ToolCheckResult:
    """Result of a tool policy check."""

    effect: str  # 'allow' | 'block' | 'redact' | 'flag'
    message: str | None = None
    data: Any = None


async def check_tool_policy(
    phase: str,
    tool_name: str,
    params: Any = None,
    result: Any = None,
) -> ToolCheckResult:
    """
    Check tool call content against policies via the Verifier's /v1/tools/check.

    Fails open on network/server errors (returns ToolCheckResult with
    effect='allow').
    """
    try:
        channel = await get_or_create_channel()
        # ChannelImpl exposes verifier_url, channel_token, agent_id via properties
        impl = channel  # type: ChannelImpl  # noqa: F841

        body: dict[str, Any] = {
            "agentId": impl.agent_id,
            "phase": phase,
            "toolName": tool_name,
        }
        if params is not None:
            body["params"] = params
        if result is not None:
            body["result"] = result

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{impl.verifier_url}/v1/tools/check",
                headers={
                    "Content-Type": "application/json",
                    "X-Spellguard-Channel-Token": impl.channel_token,
                },
                json=body,
            )

        if response.status_code != 200:
            logger.warning(
                "[Spellguard] Tool policy check failed (%s), failing open",
                response.status_code,
            )
            return ToolCheckResult(effect="allow")

        data = response.json()
        return ToolCheckResult(
            effect=data.get("effect", "allow"),
            message=data.get("message"),
            data=data.get("data"),
        )
    except Exception as exc:
        logger.warning(
            "[Spellguard] Tool policy check error, failing open: %s", exc
        )
        return ToolCheckResult(effect="allow")
