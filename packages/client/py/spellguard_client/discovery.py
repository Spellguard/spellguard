# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client - Agent Discovery

Discover agents by name/URL, resolve A2A Agent Cards, and manage
local development port mappings and agent card caches.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from spellguard_ctls.types import AgentCard

from .types import ResolvedAgent

logger = logging.getLogger("spellguard")

# ===================================================================
# Cache & local port mapping
# ===================================================================


@dataclass
class _CachedCard:
    card: AgentCard
    fetched_at: float


_agent_cache: dict[str, _CachedCard] = {}
_CACHE_TTL_S = 5 * 60  # 5 minutes

# Runtime port overrides for testing.  Empty by default — all discovery
# goes through the Verifier (which queries management for agent URLs).
LOCAL_PORTS: dict[str, int] = {}


# ===================================================================
# Public API
# ===================================================================


async def discover_agents(agent_refs: list[str]) -> list[ResolvedAgent]:
    """Discover agents by their names/identifiers.

    Resolves agent names to full AgentCard information via A2A discovery.
    If full discovery fails but Verifier is configured, creates stub entries
    so the Verifier router can resolve agents from its own registry.
    """
    from .attestation import get_config

    results: list[ResolvedAgent] = []

    async def _resolve(ref: str) -> None:
        card = await resolve_agent_card(ref)
        if card:
            results.append(
                ResolvedAgent(name=ref, url=card.url, agent_card=card)
            )
        elif get_config() and get_config().verifier_url:  # type: ignore[union-attr]
            # Full A2A discovery failed, but we have a Verifier connection.
            # Create a stub entry -- the Verifier router will resolve the agent
            # from its own registry when we send the message.
            logger.info(
                "[Discovery] Creating Verifier-routed stub for %s (Verifier will resolve)",
                ref,
            )
            from spellguard_ctls.types import AgentCard as _AC

            results.append(
                ResolvedAgent(
                    name=ref,
                    url="verifier-routed",
                    agent_card=_AC(name=ref, url="verifier-routed", skills=[]),
                )
            )

    import asyncio

    await asyncio.gather(*[_resolve(ref) for ref in agent_refs])
    return results


async def resolve_agent_card(agent_name_or_url: str) -> AgentCard | None:
    """Resolve an agent name or URL to its Agent Card."""
    # Check cache first
    cached = _agent_cache.get(agent_name_or_url)
    if cached and (time.time() - cached.fetched_at) < _CACHE_TTL_S:
        return cached.card

    # Determine URL to fetch from
    if agent_name_or_url.startswith("http://") or agent_name_or_url.startswith(
        "https://"
    ):
        # Full URL provided
        if agent_name_or_url.endswith("/agent.json"):
            agent_card_url = agent_name_or_url
        else:
            agent_card_url = (
                f"{agent_name_or_url.rstrip('/')}/.well-known/agent.json"
            )
    else:
        # Agent name -- try local discovery, then Verifier resolution
        url = await _discover_agent_by_name(agent_name_or_url)
        if not url:
            logger.warning(
                "[Discovery] Could not discover agent: %s", agent_name_or_url
            )
            return None
        agent_card_url = url

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                agent_card_url,
                headers={"Accept": "application/json"},
            )

        if response.status_code != 200:
            logger.warning(
                "[Discovery] Failed to fetch agent card from %s: %s",
                agent_card_url,
                response.status_code,
            )
            return None

        data = response.json()

        # Validate required fields
        if not data.get("name") or not data.get("url") or "skills" not in data:
            logger.warning(
                "[Discovery] Invalid agent card from %s: missing required fields",
                agent_card_url,
            )
            return None

        # DNS hijacking protection: verify URL matches requested domain
        try:
            requested_parsed = urlparse(agent_card_url)
            returned_parsed = urlparse(data["url"])

            if requested_parsed.hostname != returned_parsed.hostname:
                logger.warning(
                    "[Discovery] DNS hijacking detected: requested %s, got %s",
                    requested_parsed.hostname,
                    returned_parsed.hostname,
                )
                return None
        except Exception:
            logger.warning(
                "[Discovery] Invalid URL in agent card: %s", data.get("url")
            )
            return None

        # Build AgentCard from response data
        from spellguard_ctls.types import (
            AgentCard as _AC,
            AgentCardAuthentication,
            AgentCardCapabilities,
            AgentCardSkill,
        )

        skills = [
            AgentCardSkill(
                id=s.get("id", ""),
                name=s.get("name", ""),
                description=s.get("description", ""),
            )
            for s in data.get("skills", [])
        ]

        caps_data = data.get("capabilities")
        capabilities = (
            AgentCardCapabilities(
                streaming=caps_data.get("streaming"),
                push_notifications=caps_data.get("pushNotifications"),
            )
            if caps_data
            else None
        )

        auth_data = data.get("authentication")
        authentication = (
            AgentCardAuthentication(schemes=auth_data.get("schemes", []))
            if auth_data
            else None
        )

        card = _AC(
            name=data["name"],
            url=data["url"],
            skills=skills,
            description=data.get("description"),
            version=data.get("version"),
            capabilities=capabilities,
            authentication=authentication,
        )

        # Cache the result
        _agent_cache[agent_name_or_url] = _CachedCard(
            card=card, fetched_at=time.time()
        )

        logger.info("[Discovery] Resolved agent: %s at %s", card.name, card.url)
        return card
    except Exception as error:
        logger.error("[Discovery] Error fetching agent card: %s", error)
        return None


def clear_agent_cache() -> None:
    """Clear the agent cache (for testing)."""
    _agent_cache.clear()


def register_local_agent(agent_name: str, port: int) -> None:
    """Register local port mapping for an agent (for testing)."""
    LOCAL_PORTS[agent_name.lower()] = port


# ===================================================================
# Internal: name-based discovery
# ===================================================================


async def _discover_agent_by_name(agent_name: str) -> str | None:
    """Discover an agent by name.

    Tries in order:
    1. Local port overrides (registered programmatically for testing)
    2. Verifier agent resolution (Verifier checks its registry + management server)
    """
    import re

    normalized = re.sub(r"[^a-z0-9-]", "-", agent_name.lower())

    # 1. Check known local ports
    port = LOCAL_PORTS.get(normalized)
    if port:
        url = f"http://localhost:{port}/.well-known/agent.json"
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url, timeout=2.0)
            if response.status_code == 200:
                return url
        except Exception:
            pass  # Port not available, continue to Verifier resolution

    # 2. Ask the Verifier to resolve the agent (Verifier checks its own registry)
    from .attestation import get_config

    config = get_config()
    if config and config.verifier_url:
        try:
            verifier_resolve_url = (
                f"{config.verifier_url}/agents/resolve/{quote(normalized)}"
            )
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    verifier_resolve_url,
                    headers={"Accept": "application/json"},
                    timeout=5.0,
                )

            if response.status_code == 200:
                card_data = response.json()
                if card_data.get("url"):
                    logger.info(
                        "[Discovery] Verifier resolved %s to %s",
                        normalized,
                        card_data["url"],
                    )
                    # Return the agent card URL (the Verifier already gave us the
                    # full card, but we return the URL so the standard flow
                    # fetches + validates it)
                    return f"{card_data['url'].rstrip('/')}/.well-known/agent.json"
        except Exception as error:
            logger.warning(
                "[Discovery] Verifier resolution failed for %s: %s",
                normalized,
                error,
            )

    return None
