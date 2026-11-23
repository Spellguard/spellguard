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
    # Expected SHA384 hash of the Verifier Docker image (for bidirectional
    # attestation).
    #
    # OPTIONAL because the management server may not have recorded one yet. It
    # is then left None rather than filled with a placeholder, and channel
    # creation fails closed with `verifier_image_hash_unconfigured` -- absent
    # attestation config must never read as "attestation passed".
    expected_verifier_image_hash: str | None
    # Agent card for A2A discovery
    agent_card: AgentCard
    # The Verifier session key management attested (#1259), from discovery's
    # `verifierPublicKey`. When set, the attestation document and the
    # registration response must both carry exactly this key.
    expected_verifier_public_key: str | None = None
    # Agent secret for Verifier registration authentication (validated by management server)
    agent_secret: str | None = None
    # Ed25519 private key (hex) for signing evidence -- from management server
    signing_private_key: str | None = None
    # Management token forwarded to Verifier during registration
    management_token: str | None = None
    # Management server base URL (WITHOUT the /v1 suffix). Populated on the
    # managed/discovery path so the SDK can reach Management directly -- e.g.
    # the Tier-3 self-reported usage emit (POST /v1/agents/:id/usage, PRD
    # internal design notes). Absent on direct-config agents that
    # have no management endpoint (emit skips).
    management_url: str | None = None
    # Opt OUT of the fail-closed default for tool policy checks
    # (``check_tool_policy()``, and every ``spellguard_tool`` / LangChain /
    # CrewAI wrapper built on it).
    #
    # Default (None / False) is fail CLOSED: when the check cannot complete --
    # Verifier unreachable, request timed out, request refused, no channel
    # established, or the client was never configured -- the check returns
    # ``ToolCheckResult(effect="block")`` and the wrapped tool does not run.
    #
    # Setting this to True means the tool call RUNS UNCHECKED whenever the
    # policy check cannot complete. Every policy bound to that tool is silently
    # skipped for the duration of the outage; there is no other signal to the
    # caller. Availability is being bought with enforcement.
    #
    # It does NOT overrule the Verifier. A response carrying an explicit
    # ``effect`` is a decision and is honoured either way -- including the
    # Verifier's own 503 {"effect": "block"} when it cannot load policy data.
    #
    # Consumers whose config the SDK never sees (``create_spellguard()``
    # callers, or processes that wrap tools without calling ``configure()`` at
    # all) can set SPELLGUARD_TOOL_POLICY_FAIL_OPEN=true instead. This field
    # wins when both are set.
    fail_open: bool | None = None


# Platform identity providers the Verifier can attest an agent against.
#
# Mirrors management's ``AttestationProvider``
# (closed source) and the
# ``AttestationProviderSchema`` Zod enum it is validated by, member for member.
# Every entry has a registered server-side verifier in
# workers/services/identity-verifiers/, so a member missing here is an agent
# that cannot declare an identity the control plane already knows how to check.
# Add to both sides together.
AttestationProvider = Literal[
    "aws",
    "azure",
    "azure-maa",
    "clerk",
    "gcp",
    "salesforce",
    "spiffe",
    "verifier",
    "nitro-verifier",
    "aws-agentcore",
    "better-auth",
    "jwk",
    "oidc",
    "vestauth",
    "x509",
]


@dataclass
class PlatformAttestationProvider:
    """A single platform attestation provider."""

    provider: AttestationProvider
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
    # Opt OUT of the fail-closed default for tool policy checks. Carried onto
    # the resolved SpellguardConfig -- see SpellguardConfig.fail_open for what
    # enabling it costs.
    fail_open: bool | None = None


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
    # Opt OUT of the fail-closed default for tool policy checks. Carried onto
    # the resolved SpellguardConfig -- see SpellguardConfig.fail_open for what
    # enabling it costs. This is the only opt-out an agent has when the runtime
    # does not expose SPELLGUARD_TOOL_POLICY_FAIL_OPEN via os.environ.
    fail_open: bool | None = None


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
    # Opt OUT of the fail-closed default for tool policy checks. Carried onto
    # the resolved SpellguardConfig -- see SpellguardConfig.fail_open for what
    # enabling it costs. This is the only opt-out an agent has when the runtime
    # does not expose SPELLGUARD_TOOL_POLICY_FAIL_OPEN via os.environ.
    fail_open: bool | None = None


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
    # Signed deliveries (#1244): the replay cache for /_spellguard/receive.
    # Defaults to an in-process LRU (spellguard_ctls.delivery.DeliveryNonceCache);
    # a deployment with several receivers passes a shared store.
    delivery_nonce_store: Any | None = None
