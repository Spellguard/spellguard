# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client - Type definitions

All configuration types, resolved agent info, channel protocol, and options
for the Spellguard Python client.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Protocol, runtime_checkable

from spellguard_amp.types import UnilateralSendResult
from spellguard_ctls.types import AgentCard


# ===================================================================
# Configuration Types
# ===================================================================


@dataclass
class SpellguardConfig:
    """Configuration for the Spellguard client."""

    # Unique identifier for this agent
    agent_id: str
    # URL of the Verifier server
    verifier_url: str
    # This agent's public URL (for Verifier callbacks)
    self_url: str
    # SHA256 hash of this agent's code (for attestation)
    code_hash: str
    # Expected SHA384 hash of Verifier Docker image (for bidirectional attestation)
    expected_verifier_image_hash: str
    # Agent card for A2A discovery
    agent_card: AgentCard
    # Agent secret for Verifier registration authentication (validated by management server)
    agent_secret: str | None = None
    # Ed25519 private key (hex) for signing evidence -- from management server
    signing_private_key: str | None = None
    # Management token forwarded to Verifier during registration
    management_token: str | None = None


@dataclass
class PlatformAttestationProvider:
    """A single platform attestation provider."""

    provider: Literal["aws", "azure", "gcp", "spiffe", "verifier", "aws-agentcore"]
    get_token: Callable[[], Awaitable[str]]


@dataclass
class PlatformAttestation:
    """Platform attestation providers for platform/dual auth mode."""

    providers: list[PlatformAttestationProvider]


@dataclass
class SpellguardDiscoveryConfig:
    """Configuration for discovering a Verifier via the Management Server.

    Call ``discover_and_configure()`` with this instead of ``configure()`` when
    the Verifier URL is not known ahead of time -- the management server will assign
    one.
    """

    # Unique identifier for this agent
    agent_id: str
    # Management server base URL (e.g. "https://mgmt.example.com/v1")
    management_url: str
    # This agent's public URL (for Verifier callbacks)
    self_url: str
    # SHA256 hash of this agent's code (for attestation)
    code_hash: str
    # Agent card for A2A discovery
    agent_card: AgentCard
    # Agent secret for authentication (required for secret/dual auth mode)
    agent_secret: str | None = None
    # Ed25519 private key (hex) for signing evidence -- from management server
    signing_private_key: str | None = None
    # Preferred region for Verifier selection
    region: str | None = None
    # Required Verifier capabilities
    capabilities: list[str] | None = None
    # Platform attestation providers for platform/dual auth mode
    platform_attestation: PlatformAttestation | None = None


# ===================================================================
# Resolved Agent & Channel
# ===================================================================


@dataclass
class ResolvedAgent:
    """Resolved agent information from A2A discovery."""

    name: str
    url: str
    agent_card: AgentCard


@dataclass
class UnilateralSendOptions:
    """Options for sending to an A2A-only agent via unilateral communication."""

    # A2A method to use (default: 'tasks/send')
    method: Literal["tasks/send", "tasks/get"] | None = None


@runtime_checkable
class ClientChannel(Protocol):
    """Client-side secure channel to Verifier.

    This is the client's view of a channel with methods for sending messages.
    """

    async def send(self, recipient: str, payload: Any) -> Any:
        """Send a message to another agent through Verifier."""
        ...

    async def send_with_agent_context(
        self,
        *,
        original_prompt: str,
        target_agents: list[ResolvedAgent],
        model: Any,
    ) -> Any:
        """Send a prompt with agent context through Verifier."""
        ...

    async def send_to_model(self, options: Any) -> Any:
        """Send directly to AI model through Verifier (logged but no agent routing)."""
        ...

    async def send_to_a2a(
        self,
        a2a_agent_url: str,
        payload: Any,
        options: UnilateralSendOptions | None = None,
    ) -> UnilateralSendResult:
        """Send a message to an A2A-only agent through Verifier (unilateral attestation).

        The Verifier will log commitments for both the outbound request and inbound
        response.  Attestation level is 'unilateral' since only the sender is
        Spellguard-attested.
        """
        ...

    def close(self) -> None:
        """Close the channel."""
        ...


# ===================================================================
# Spellguard configuration mode types
# ===================================================================


@dataclass
class ManagedConfig:
    """Managed mode: Verifier is discovered via the management server at runtime."""

    type: Literal["managed"]
    # Unique identifier for this agent
    agent_id: str
    # Management server base URL (e.g. "https://mgmt.example.com/v1")
    management_url: str
    # This agent's public URL (for Verifier callbacks)
    self_url: str
    # SHA256 hash of this agent's code (for attestation)
    code_hash: str
    # Agent secret for management server authentication (required for secret/dual auth mode)
    agent_secret: str | None = None
    # Platform attestation providers for platform/dual auth mode
    platform_attestation: PlatformAttestation | None = None


@dataclass
class DirectConfig:
    """Direct mode: Verifier URL is known ahead of time (e.g. local dev)."""

    type: Literal["direct"]
    # Unique identifier for this agent
    agent_id: str
    # URL of the Verifier server
    verifier_url: str
    # This agent's public URL (for Verifier callbacks)
    self_url: str
    # SHA256 hash of this agent's code (for attestation)
    code_hash: str
    # Expected SHA384 hash of Verifier Docker image
    expected_verifier_image_hash: str
    # Optional agent secret
    agent_secret: str | None = None


# Discriminated union for Spellguard configuration mode.
SpellguardConfigMode = ManagedConfig | DirectConfig


# ===================================================================
# Options for createSpellguard()
# ===================================================================


@dataclass
class MessageContext:
    """Context passed to the ``on_message`` handler."""

    # The incoming message payload from Verifier
    message: Any
    # The sender agent's ID
    sender_id: str
    # The initialized main model/client
    model: Any


@dataclass
class SpellguardOptions:
    """Options for ``create_spellguard()``.

    Attributes:
        agent_card: Agent card for A2A discovery -- single source of truth.
        config: Spellguard config: static object or env-resolver callable.
        on_message: Handler for incoming bilateral messages from Verifier.
        model: Main LLM model/client -- called once during lazy init.
        intent_detection_model: Optional intent detection model or factory.
        on_initialized: Optional hook called once after Spellguard initialises.
    """

    # Agent card for A2A discovery -- single source of truth
    agent_card: AgentCard
    # Spellguard config: static object or env-resolver callable
    config: SpellguardConfigMode | Callable[..., SpellguardConfigMode]
    # Handler for incoming bilateral messages from Verifier
    on_message: Callable[[MessageContext], Awaitable[Any]]
    # Main LLM model/client
    model: Any | None = None
    # Optional intent detection model or factory
    intent_detection_model: Any | None = None
    # Optional hook called once after Spellguard initialises
    on_initialized: Callable[..., Any] | None = None
