# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Agent Registry

In-memory registry for registered agents and channel tokens.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field

from ..types import RegisteredAgent

# In-memory agent registry
_registry: dict[str, RegisteredAgent] = {}
_token_index: dict[str, str] = {}  # token -> agent_id


@dataclass
class RegisterResult:
    """Result of agent registration."""

    success: bool
    error: str | None = field(default=None)


def register_agent(
    agent: RegisteredAgent,
    *,
    allow_endpoint_update: bool = False,
) -> RegisterResult:
    """Register an agent in the registry.

    Args:
        agent: Agent to register.
        allow_endpoint_update: When True, accept a re-registration whose
            endpoint differs from the existing record and update the
            registry to match. Pass this only after the caller has
            independently verified that the registering party owns the
            agent identity (e.g. a successful evidence-signature check
            against the management-tracked agent public key).

            Defaults to False — preserving the strict anti-hijacking
            guard for paths that don't have signed evidence backing
            them.

    Returns:
        Registration result.
    """
    existing = _registry.get(agent.agent_id)

    # Block re-registration with a different endpoint unless the caller
    # has explicitly proven ownership upstream (e.g. via a verified
    # evidence signature). Without that proof, an actor that learns an
    # agent_id could otherwise hijack traffic by re-registering with a
    # malicious callback URL.
    if existing and existing.endpoint != agent.endpoint:
        if not allow_endpoint_update:
            return RegisterResult(
                success=False,
                error=(
                    f"Agent {agent.agent_id} already registered with "
                    "different endpoint"
                ),
            )
        print(
            f"[cTLS] Updating endpoint for agent {agent.agent_id}: "
            f"{existing.endpoint} → {agent.endpoint}"
        )

    # Remove old token from index if updating
    if existing:
        _token_index.pop(existing.channel_token, None)

    # Register the agent
    _registry[agent.agent_id] = agent
    _token_index[agent.channel_token] = agent.agent_id

    print(f"[cTLS] Registered agent: {agent.agent_id}")
    return RegisterResult(success=True)


def get_agent(agent_id: str) -> RegisteredAgent | None:
    """Get an agent by ID."""
    agent = _registry.get(agent_id)

    # Check if expired
    if agent and agent.expires_at < int(time.time() * 1000):
        # Remove expired agent
        del _registry[agent_id]
        _token_index.pop(agent.channel_token, None)
        return None

    return agent


def get_agent_by_token(token: str) -> RegisteredAgent | None:
    """Get an agent by channel token."""
    agent_id = _token_index.get(token)
    if not agent_id:
        return None
    return get_agent(agent_id)


def get_all_agents() -> list[RegisteredAgent]:
    """Get all registered agents."""
    now = int(time.time() * 1000)
    agents: list[RegisteredAgent] = []
    expired_ids: list[str] = []

    for agent_id, agent in _registry.items():
        if agent.expires_at < now:
            # Mark for cleanup
            expired_ids.append(agent_id)
        else:
            agents.append(agent)

    # Clean up expired agents
    for agent_id in expired_ids:
        agent = _registry.pop(agent_id, None)
        if agent:
            _token_index.pop(agent.channel_token, None)

    return agents


def is_agent_registered(agent_id: str) -> bool:
    """Check if an agent is registered."""
    return get_agent(agent_id) is not None


def verify_channel_token(token: str) -> bool:
    """Verify a channel token is valid."""
    return get_agent_by_token(token) is not None


def rotate_channel_token(
    agent_id: str,
) -> dict[str, str | int] | None:
    """Rotate the channel token for an agent.

    Args:
        agent_id: ID of the agent.

    Returns:
        Dict with 'token' and 'expires_at', or None if agent not found.
    """
    agent = get_agent(agent_id)
    if not agent:
        return None

    # Remove old token from index
    _token_index.pop(agent.channel_token, None)

    # Generate new token
    new_token = _generate_token()
    new_expires_at = int(time.time() * 1000) + 24 * 60 * 60 * 1000  # 24 hours

    # Update agent
    agent.channel_token = new_token
    agent.expires_at = new_expires_at
    _registry[agent_id] = agent
    _token_index[new_token] = agent_id

    print(f"[cTLS] Rotated token for agent: {agent_id}")
    return {"token": new_token, "expires_at": new_expires_at}


def clear_registry() -> None:
    """Clear the registry (for testing)."""
    _registry.clear()
    _token_index.clear()


def _generate_token() -> str:
    """Generate a secure random token."""
    return secrets.token_bytes(32).hex()
