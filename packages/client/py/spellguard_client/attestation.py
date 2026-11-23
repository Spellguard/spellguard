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
import math
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from spellguard_amp.client import derive_agent_key_pair, encrypt_for_verifier
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
# The managed (discovery) config, kept so a pinned-key mismatch can re-run
# discovery (#1259), and when that last happened (0 = never).
_discovery_config: SpellguardDiscoveryConfig | None = None
_last_pin_refresh_at: float = 0.0
# At most one pin-driven re-discovery per minute.
_PIN_REFRESH_INTERVAL_S = 60.0
# When the management token discovery handed out is due for renewal
# (time.monotonic()); 0 = no token from discovery, nothing to renew.
_management_token_renew_at: float = 0.0
# Renew a discovered management token this long before it expires, so a
# registration never presents one that lapses in flight.
_MANAGEMENT_TOKEN_RENEW_MARGIN_S = 300.0


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
    global _current_config, _cached_channel, _management_token_renew_at
    _current_config = config
    # Reset channel if config changes
    with _channel_lock:
        _cached_channel = None
    # A token configured directly has no known lifetime; discovery sets one.
    _management_token_renew_at = 0.0


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
    global _discovery_config, _management_token_renew_at
    # Kept for a pinned-key re-discovery (#1259).
    _discovery_config = config

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

    # #1259: management returns the session key its own challenge attested. An
    # agent has nothing to pin without it, so it fails closed rather than trust
    # whatever key the Verifier endpoint presents.
    if not discovery.get("verifierPublicKey"):
        raise RuntimeError(
            "Discovery response carries no verifierPublicKey "
            "[verifier_key_unconfigured]: the management server did not return "
            "an attested Verifier key. Connection refused."
        )

    # Configure the client with the resolved Verifier URL.
    #
    # The Verifier image hash is taken from discovery verbatim. It is left None
    # when the management server hasn't recorded one -- never substituted with a
    # placeholder. A placeholder used to double as the mock-mode trigger, so
    # missing server config silently disabled attestation for every agent in
    # that environment; absent config must fail closed instead.
    configure(
        SpellguardConfig(
            agent_id=config.agent_id,
            verifier_url=discovery["verifierUrl"],
            self_url=config.self_url,
            code_hash=config.code_hash,
            expected_verifier_image_hash=discovery.get("verifierImageHash"),
            expected_verifier_public_key=discovery["verifierPublicKey"],
            agent_secret=config.agent_secret,
            signing_private_key=config.signing_private_key,
            management_token=discovery["managementToken"],
            # Normalized base (no /v1) so the Tier-3 usage emit can reach
            # Management directly; the emit helper appends
            # /v1/agents/:id/usage.
            management_url=base_url,
            agent_card=config.agent_card,
            fail_open=config.fail_open,
        )
    )
    # Management states the token's lifetime as issuedAt..expiresAt, in seconds.
    _management_token_renew_at = _token_renewal_time(
        discovery.get("expiresAt"), discovery.get("issuedAt")
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


_client_key_pairs: dict[str, dict[str, str]] = {}


def get_client_key_pair() -> dict[str, str] | None:
    """This agent's X25519 key pair, derived from its stable secret (agent
    secret, else signing key) so every process registers the key it later
    decrypts with. None when the agent has no secret material; it then stays
    on the plaintext path."""
    config = _current_config
    seed = (config.agent_secret or config.signing_private_key) if config else None
    if not seed:
        return None
    pair = _client_key_pairs.get(seed)
    if pair is None:
        pair = derive_agent_key_pair(seed)
        _client_key_pairs[seed] = pair
    return pair


async def get_delivery_trust() -> dict[str, str | None]:
    """The current channel's delivery trust (#1244), establishing (attesting
    and registering) the channel first if needed."""
    channel = await get_or_create_channel()
    assert isinstance(channel, ChannelImpl)
    return channel.delivery_trust()


def reset() -> None:
    """Reset client state (for testing)."""
    global _cached_channel, _current_config, _discovery_config
    global _last_pin_refresh_at, _management_token_renew_at
    with _channel_lock:
        _cached_channel = None
    _current_config = None
    _discovery_config = None
    _last_pin_refresh_at = 0.0
    _management_token_renew_at = 0.0


def _token_renewal_time(expires_at: Any, issued_at: Any) -> float:
    """When a token discovery issued for ``expires_at - issued_at`` seconds
    is due for renewal (time.monotonic()), or 0 when the lifetime is unknown.
    Measured on this clock, so a skewed clock does not move it."""
    if not isinstance(expires_at, (int, float)) or not isinstance(
        issued_at, (int, float)
    ):
        return 0.0
    lifetime = float(expires_at) - float(issued_at)
    if not math.isfinite(lifetime) or lifetime <= 0:
        return 0.0
    return time.monotonic() + max(
        lifetime - _MANAGEMENT_TOKEN_RENEW_MARGIN_S, lifetime / 2
    )


def _management_token_due() -> bool:
    """True when this agent's discovered management token is due for
    renewal."""
    return (
        _discovery_config is not None
        and _management_token_renew_at != 0.0
        and time.monotonic() >= _management_token_renew_at
    )


def _claim_pin_refresh() -> bool:
    """Claim the pin refresh, if this agent was discovered and has not
    refreshed within the interval (#1259). Taken before re-discovery runs, so
    the channel creation re-discovery triggers cannot recurse."""
    global _last_pin_refresh_at
    if _discovery_config is None:
        return False
    now = time.monotonic()
    if _last_pin_refresh_at and now - _last_pin_refresh_at < _PIN_REFRESH_INTERVAL_S:
        return False
    _last_pin_refresh_at = now
    return True


# ===================================================================
# Mock-attestation gate
# ===================================================================

# Environment variable that opts a process into MOCK attestation -- the Verifier
# is trusted without checking its image hash, timestamp, or signature.
#
# It must be set to exactly "true", and it is refused outright against a
# production configuration (see resolve_mock_attestation_mode). Mock mode is
# never inferred from the configured image hash: doing so is what let absent
# server-side config silently disable attestation everywhere.
MOCK_ATTESTATION_ENV_VAR = "SPELLGUARD_ALLOW_MOCK_ATTESTATION"

# Reason code carried by the refusal raised when the flag is set in production.
MOCK_ATTESTATION_FORBIDDEN_REASON = "mock_attestation_forbidden_in_production"

# Shared or real Spellguard environments: the spellguard.ai apex (production)
# and every subdomain beneath it, which covers each shared pre-production
# environment as well as prod. Deliberately matches the whole tree rather than
# enumerating environments -- a new shared env is covered the day it is created,
# and no internal hostname is written down here. Mirrors the deny-first host
# classification Spellguard's own conformance tooling uses.
_PRODUCTION_HOST_PATTERNS = (re.compile(r"(^|\.)spellguard\.ai$", re.IGNORECASE),)

# Hosts where mock attestation MAY be enabled: a local stack, or a throwaway
# dev-stack (per-developer, ephemeral, torn down with `dev:cloud:down`).
#
# Deliberately an allow-list: an unrecognized host -- a customer's self-hosted
# Verifier, an unknown staging origin -- is treated as production, so the bypass
# cannot reach an environment nobody classified.
#
# *.workers.dev is NOT blanket-allowed. A deployed environment is a Cloudflare
# Worker that can also answer on its account's workers.dev subdomain, the same
# subdomain the throwaway stacks use, so a blanket allow would reach real
# environments too. The allow is matched on the throwaway's NAME SHAPE
# instead: spellguard-<service>-dev-<developer> -- the
# trailing developer segment is what distinguishes an ephemeral stack
# (...-management-dev-cli-e2e) from the shared, real dev environment
# (...-management-dev, refused).
#
# Matching the shape rather than denying a list of known deployed names is
# deliberate: a new worker or environment added later is refused by default
# instead of silently inheriting the bypass.
_NON_PRODUCTION_HOST_PATTERNS = (
    re.compile(r"^localhost$", re.IGNORECASE),
    re.compile(r"^127(\.\d+){3}$"),
    re.compile(r"^\[?::1\]?$"),
    re.compile(r"^0\.0\.0\.0$"),
    re.compile(
        r"^spellguard-[a-z0-9-]+-dev-[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.workers\.dev$",
        re.IGNORECASE,
    ),
)


def _is_production_url(url: str) -> bool:
    """True when ``url`` is NOT a recognized local/throwaway target.

    Deny-first, and an unparseable or unrecognized URL counts as production
    (fail closed).
    """
    try:
        host = urlparse(url).hostname
    except ValueError:
        return True
    if not host:
        return True
    if any(deny.search(host) for deny in _PRODUCTION_HOST_PATTERNS):
        return True
    return not any(ok.search(host) for ok in _NON_PRODUCTION_HOST_PATTERNS)


def resolve_mock_attestation_mode(config: SpellguardConfig) -> bool:
    """Decide whether this channel may skip Verifier attestation (decision D1).

    Mock mode requires BOTH:

    1. ``SPELLGUARD_ALLOW_MOCK_ATTESTATION=true`` -- an explicit operator opt-in.
    2. A non-production configuration -- every URL this agent talks to
       (Verifier, and management when present) resolves to a local stack or a
       throwaway ``*.workers.dev`` dev-stack.

    Setting the flag against a production configuration RAISES rather than being
    quietly ignored: an attempt to disable attestation in production is a
    misconfiguration worth surfacing, not one to paper over.
    """
    if os.environ.get(MOCK_ATTESTATION_ENV_VAR) != "true":
        return False

    production_urls = [
        url
        for url in (config.verifier_url, config.management_url)
        if url and _is_production_url(url)
    ]

    if production_urls:
        raise RuntimeError(
            f"{MOCK_ATTESTATION_ENV_VAR}=true refused "
            f"[{MOCK_ATTESTATION_FORBIDDEN_REASON}]: mock attestation may only "
            "be enabled against a local stack or a throwaway *.workers.dev "
            "dev-stack, but this agent is configured against "
            f"{', '.join(production_urls)}. Unset {MOCK_ATTESTATION_ENV_VAR} or "
            "point the agent at a development environment."
        )

    return True


# ===================================================================
# Internal: channel creation
# ===================================================================


async def _create_channel(config: SpellguardConfig) -> ChannelImpl:
    """Create a new channel to the Verifier with bidirectional attestation."""
    # Registration presents the management token, which expires an hour after
    # discovery; the Verifier refuses an expired one even with a valid agent
    # secret. Renew it through discovery first, so an agent that re-registers
    # after its first hour (a restarted Verifier, a stale channel token) is
    # not refused. Re-discovery reconfigures and registers with the new token.
    if _management_token_due():
        logger.info(
            "[Spellguard] Management token due for renewal, re-running discovery..."
        )
        assert _discovery_config is not None
        await discover_and_configure(_discovery_config)
        renewed = await get_or_create_channel()
        assert isinstance(renewed, ChannelImpl)
        return renewed

    logger.info("[Spellguard] Creating channel for %s...", config.agent_id)

    # Step 1: Verify Verifier before sending any secrets.
    #
    # Mock mode is decided by an explicit operator opt-in ONLY -- never inferred
    # from `expected_verifier_image_hash`. When the management server has
    # recorded no Verifier image hash the field stays None and verification
    # fails closed with `verifier_image_hash_unconfigured`, instead of the
    # absent config silently switching attestation off.
    is_mock_mode = resolve_mock_attestation_mode(config)

    verifier_verification = await fetch_and_verify_verifier(
        config.verifier_url,
        config.expected_verifier_image_hash or "",
        {
            "mock_mode": is_mock_mode,
            "expected_public_key": config.expected_verifier_public_key,
        },
    )

    if not verifier_verification.verified:
        # #1259: a Verifier restart changes its session key (and a redeploy its
        # measurement) before the discovery pin catches up. Re-run discovery
        # once and retry against management's fresh attestation; a second
        # mismatch within the window fails closed.
        if verifier_verification.reason in (
            "verifier_key_mismatch",
            "image_hash_mismatch",
        ) and _claim_pin_refresh():
            logger.warning(
                "[Spellguard] Verifier attestation [%s] -- re-running discovery "
                "once for a fresh pin",
                verifier_verification.reason,
            )
            assert _discovery_config is not None
            await discover_and_configure(_discovery_config)
            channel = await get_or_create_channel()
            assert isinstance(channel, ChannelImpl)
            return channel
        raise RuntimeError(
            f"Verifier attestation failed "
            f"[{verifier_verification.reason or 'unknown'}]: "
            f"{verifier_verification.error}\n"
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

    # Register this agent's X25519 key so the Verifier encrypts deliveries to
    # it (gateway-opaque), as the TypeScript SDK does (#1244).
    register_body: dict[str, Any] = {"evidence": evidence}
    key_pair = get_client_key_pair()
    if key_pair is not None:
        register_body["clientPublicKey"] = key_pair["public_key_hex"]

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{config.verifier_url}/agents/register",
            headers=headers,
            json=register_body,
            # Slim profile routes this through the gateway->SLIM->verifier
            # hop, whose cold-session establishment runs ~20-30s. 10s aborted
            # registration before the session warmed. Matches the TypeScript
            # twin (``packages/client/ts/src/attestation.ts``), which raised
            # this same call for this same reason.
            #
            # Now that the tool-policy check fails CLOSED, an abort here is
            # not just a slow start: `get_or_create_channel()` raises,
            # `check_tool_policy` returns `channel_unavailable`, and the tool
            # call is BLOCKED by a failure the Verifier never issued.
            timeout=60.0,
        )

    if response.status_code != 200:
        error = response.text
        raise RuntimeError(
            f"Failed to register with Verifier: {response.status_code} {error}"
        )

    attestation = response.json()

    if not attestation.get("verified"):
        raise RuntimeError("Verifier rejected our evidence")

    # #1259: the key registration hands back is the key everything later
    # trusts. It must be the key this Verifier was just attested with, and the
    # key management attested.
    registered_key = attestation.get("sessionPublicKey")
    attested_doc = verifier_verification.attestation
    attested_key = (
        attested_doc.public_key
        if attested_doc is not None
        else config.expected_verifier_public_key
    )
    if (attested_key is not None and registered_key != attested_key) or (
        config.expected_verifier_public_key is not None
        and registered_key != config.expected_verifier_public_key
    ):
        raise RuntimeError(
            "Verifier attestation failed [verifier_key_mismatch]: registration "
            f"returned session key {registered_key}, but the attested key is "
            f"{attested_key}. Connection refused."
        )

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
        delivery_auth=attestation.get("deliveryAuth"),
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
        delivery_auth: str | None = None,
    ) -> None:
        self._config = config
        self._channel_token = channel_token
        self._session_public_key = session_public_key
        self._session_x25519_public_key = session_x25519_public_key
        self._delivery_auth = "v1" if delivery_auth == "v1" else None
        self._closed = False
        self._is_retry = False

    # --- accessors --------------------------------------------------

    def delivery_trust(self) -> dict[str, str | None]:
        """What this agent verifies a delivery against (#1244): the session
        key from its own attested registration, whether that registration
        advertised signed deliveries, and the Verifier's X25519 key for the
        encrypted reply. Never anything a delivery supplies."""
        return {
            "session_public_key": self._session_public_key,
            "delivery_auth": self._delivery_auth,
            "session_x25519_public_key": self._session_x25519_public_key,
        }

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

    async def send(
        self, recipient: str, payload: Any, timeout_ms: float | None = None
    ) -> Any:
        """Send a message to another agent through Verifier.

        ``timeout_ms`` overrides the default 120s send timeout — the peer
        fan-out passes a shorter, budget-derived value so a wedged send can't
        blow the turn past the proxy's /chat timeout (see ``_FANOUT_BUDGET_S``).
        """
        if self._closed:
            raise RuntimeError("Channel is closed")

        # Encrypt payload for Verifier using X25519 key (falls back to Ed25519 key)
        payload_json = json.dumps(payload)
        encryption_key = self._session_x25519_public_key or self._session_public_key
        encrypted_payload = encrypt_for_verifier(payload_json, encryption_key)

        timeout_s = (timeout_ms / 1000.0) if timeout_ms is not None else 120.0
        async with httpx.AsyncClient(timeout=timeout_s) as client:
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
    # Why the SDK -- not the Verifier -- decided this result. Set only when the
    # check could not complete; None on every decision the Verifier made. One
    # of the causes documented on _tool_policy_unavailable().
    reason: str | None = None


# Effects the Verifier is allowed to return. A body carrying anything else is
# not a decision, and is treated as an unavailable check rather than an allow.
_TOOL_CHECK_EFFECTS = frozenset({"allow", "block", "redact", "flag"})

# The effects that DENY the call: the tool does not run with its original
# content. "allow" and "flag" both let it through ("flag" just alerts too).
# Only these are honoured off a non-2xx -- see _read_tool_check_decision.
_CALL_DENYING_EFFECTS = frozenset({"block", "redact"})

# Environment-variable form of ``SpellguardConfig.fail_open``, for consumers
# whose config the SDK never sees: ``create_spellguard()`` callers, and
# processes that wrap tools without calling ``configure()`` at all.
#
# Must be exactly "true". An explicit fail_open on the config wins over it.
#
# Setting it means a tool call RUNS UNCHECKED whenever the policy check cannot
# complete -- every policy bound to that tool is skipped for the duration.
TOOL_POLICY_FAIL_OPEN_ENV_VAR = "SPELLGUARD_TOOL_POLICY_FAIL_OPEN"


def _resolve_tool_policy_fail_open() -> bool:
    """Whether this process has opted out of the fail-closed default."""
    configured = _current_config.fail_open if _current_config else None
    if isinstance(configured, bool):
        return configured
    return os.environ.get(TOOL_POLICY_FAIL_OPEN_ENV_VAR) == "true"


def _tool_policy_unavailable(reason: str, detail: str) -> ToolCheckResult:
    """Build the result for a check that produced no decision.

    Fails CLOSED by default (product-findings S2): a tool whose policies could
    not be consulted does not run. ``fail_open`` converts that to an allow, and
    says so loudly -- silently allowing is exactly the defect this replaced.

    ``reason`` is one of:

      channel_unavailable  -- no channel to the Verifier (registration failed,
                              or configure() was never called).
      verifier_unreachable -- the request never completed: connection failure,
                              DNS, or the httpx timeout.
      verifier_refused     -- the Verifier answered non-200 with no "effect"
                              (401 bad channel token, 403 agent mismatch,
                              400 bad body, 5xx).
      malformed_response   -- the body was not JSON, or carried no recognized
                              "effect".
      check_failed         -- the check itself hit an error nobody
                              anticipated (#1418).
    """
    if _resolve_tool_policy_fail_open():
        logger.warning(
            "[Spellguard] Tool policy check unavailable (%s: %s) -- failing "
            "OPEN because fail_open is set; this tool call runs UNCHECKED.",
            reason,
            detail,
        )
        return ToolCheckResult(effect="allow", reason=reason)
    logger.warning(
        "[Spellguard] Tool policy check unavailable (%s: %s) -- failing closed.",
        reason,
        detail,
    )
    return ToolCheckResult(
        effect="block",
        message=(
            "[Spellguard] Tool call blocked: the policy check could not "
            f"complete ({reason})."
        ),
        reason=reason,
    )


def _read_tool_check_decision(response: httpx.Response) -> ToolCheckResult | None:
    """Read the Verifier's decision out of a response, or None if it made none.

    A 2xx body is honoured whatever it says. Off a NON-2xx the rule is one-way:
    only a decision that DENIES the call is honoured. That keeps the property
    that matters -- the Verifier's own fail-closed answer when it cannot load
    policy data is ``503 {"effect": "block"}``, and discarding it because 503 is
    not 200 turned the one case it is designed to block into an allow (S2) --
    without letting the same door swing the other way. A non-2xx carrying
    "allow" (or "flag", which also lets the call through) is not a decision
    anyone intends: it is an error response that happens to contain the field,
    and honouring it would be the only remaining path by which a failed request
    grants permission.

    No live handler emits one today: every error branch of
    packages/verifier/src/app.ts's /v1/tools/check omits "effect" entirely
    except the 503, which sends "block". This closes the shape of the hole, not
    an observed instance of it.
    """
    try:
        body = response.json()
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    effect = body.get("effect")
    if not isinstance(effect, str) or effect not in _TOOL_CHECK_EFFECTS:
        return None
    if not response.is_success and effect not in _CALL_DENYING_EFFECTS:
        return None
    message = body.get("message")
    return ToolCheckResult(
        effect=effect,
        message=message if isinstance(message, str) else None,
        data=body.get("data"),
    )


async def check_tool_policy(
    phase: str,
    tool_name: str,
    params: Any = None,
    result: Any = None,
) -> ToolCheckResult:
    """
    Check tool call content against policies via the Verifier's /v1/tools/check.

    **Fails CLOSED.** A check that cannot complete -- unreachable Verifier,
    timeout, refusal, malformed body, or no channel at all -- returns
    ``ToolCheckResult(effect="block")`` carrying a ``reason``, so the wrapped
    tool does not run. Set ``SpellguardConfig.fail_open`` (or
    ``SPELLGUARD_TOOL_POLICY_FAIL_OPEN=true``) to trade that enforcement for
    availability; the consequence is spelled out on
    ``SpellguardConfig.fail_open``.

    A **2xx** carrying a recognized ``effect`` is the Verifier's DECISION and is
    returned verbatim, ``fail_open`` included.

    Off a **non-2xx** the rule is one-way: only a decision that DENIES the call
    ("block", "redact") is honoured -- that is what keeps the Verifier's own
    ``503 {"effect": "block"}`` working. A non-2xx carrying "allow" or "flag"
    (both of which let the call run) is NOT honoured; it becomes
    "verifier_refused", because a failed request must never grant permission.

    **Never raises** (#1418). Any other error is an unavailable check
    ("check_failed") and takes the same ``fail_open``-aware path, so a wrapper
    never needs an ``except`` of its own, and never has one that fails open.
    """
    try:
        return await _request_tool_policy_decision(phase, tool_name, params, result)
    except Exception as exc:  # noqa: BLE001 - every error is a no-decision
        return _tool_policy_unavailable("check_failed", str(exc))


# The Verifier did not know the channel's token (401, no decision).
_STALE_CHANNEL = object()


async def _request_tool_policy_decision(
    phase: str,
    tool_name: str,
    params: Any,
    result: Any,
) -> ToolCheckResult:
    """
    Ask the Verifier, re-registering once when it no longer knows this
    channel's token, as a send does. A token goes stale when the Verifier
    restarts or rotates its keys, when it expires, and when another instance
    of this agent registers since: the Verifier keeps one token per agent, so
    each registration replaces the last (#1603). Without this a stale channel
    failed every tool check closed until something else re-registered.
    Matches the TypeScript twin (``packages/client/ts/src/attestation.ts``).
    """
    first = await _ask_tool_policy(phase, tool_name, params, result)
    if first is not _STALE_CHANNEL:
        return first
    logger.info(
        "[Spellguard] Channel token stale during tool check, re-registering..."
    )
    invalidate_channel()
    retried = await _ask_tool_policy(phase, tool_name, params, result)
    if retried is _STALE_CHANNEL:
        return _tool_policy_unavailable("verifier_refused", "HTTP 401")
    return retried


async def _ask_tool_policy(
    phase: str,
    tool_name: str,
    params: Any,
    result: Any,
) -> Any:
    """One tool check; ``_STALE_CHANNEL`` for a 401 that carries no decision."""
    try:
        channel = await get_or_create_channel()
    except Exception as exc:
        return _tool_policy_unavailable("channel_unavailable", str(exc))

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

    try:
        # Same SLIM hop as the other control-plane calls; keep above the
        # ~20-30s cold-session establishment so a first tool check after an
        # idle period doesn't abort prematurely. Matches the TypeScript twin
        # (``packages/client/ts/src/attestation.ts``) — the check now fails
        # CLOSED, so a premature abort is not a free retry any more: it is a
        # block the Verifier never issued.
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{impl.verifier_url}/v1/tools/check",
                headers={
                    "Content-Type": "application/json",
                    "X-Spellguard-Channel-Token": impl.channel_token,
                },
                json=body,
            )
    except Exception as exc:
        return _tool_policy_unavailable("verifier_unreachable", str(exc))

    decision = _read_tool_check_decision(response)
    if decision is not None:
        return decision
    if response.status_code == 401:
        return _STALE_CHANNEL

    if response.status_code == 200:
        return _tool_policy_unavailable(
            "malformed_response", "response carried no recognized effect"
        )
    return _tool_policy_unavailable(
        "verifier_refused", f"HTTP {response.status_code}"
    )
