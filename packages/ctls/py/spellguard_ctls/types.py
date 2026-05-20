# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Type definitions

Core types for confidential TLS attestation and channel establishment.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ═══════════════════════════════════════════════════════════════════
# Verifier Attestation Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class VerifierAttestationDocument:
    """Verifier self-attestation document for bidirectional verification.
    Clients verify this before sending any secrets to the Verifier.
    """

    # SHA384 hash of the Verifier Docker image (reproducible build)
    image_hash: str
    # Signature from Verifier hardware (Intel TDX quote, hex-encoded)
    hardware_signature: str
    # Verifier's ephemeral public key for this session
    public_key: str
    # Timestamp of attestation generation
    timestamp: int
    # Nonce to prevent replay attacks
    nonce: str
    # Supported encryption algorithms
    supported_algorithms: list[str] | None = field(default=None)
    # TDX event log from dstack (production only)
    event_log: str | None = field(default=None)
    # Docker compose hash for CVM verification (production only)
    compose_hash: str | None = field(default=None)


# ═══════════════════════════════════════════════════════════════════
# Session Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class SessionKeys:
    """Ephemeral session keys for forward secrecy.
    These exist ONLY in Verifier RAM and are destroyed on shutdown.
    """

    # Ed25519 public key shared with clients for signing verification
    public_key: str
    # Ed25519 private key - RAM-only, never persisted
    private_key: str
    # X25519 public key for ECDH key agreement (encryption)
    x25519_public_key: str
    # X25519 private key - RAM-only, never persisted
    x25519_private_key: str
    # When the keys were created
    created_at: int


# ═══════════════════════════════════════════════════════════════════
# RFC 9334 RATS Evidence Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class EvidenceClaims:
    """Claims about an agent."""

    # Hash of the agent's code
    code_hash: str
    # Agent's callback endpoint URL
    endpoint: str
    # URL to the agent's A2A Agent Card
    agent_card_url: str
    # Capabilities the agent supports
    capabilities: list[str]
    # Preferred encryption algorithm
    preferred_algorithm: str | None = field(default=None)


@dataclass
class Evidence:
    """Evidence submitted by an agent for attestation (RFC 9334 RATS pattern)."""

    # Unique identifier for the agent
    agent_id: str
    # Claims about the agent
    claims: EvidenceClaims
    # Signature over the claims
    signature: str


# ═══════════════════════════════════════════════════════════════════
# Attestation Result Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class RotationPolicy:
    """Token rotation policy."""

    # Maximum age before rotation (milliseconds)
    max_age: int
    # Endpoint to call for token refresh
    refresh_endpoint: str


@dataclass
class AttestationResult:
    """Result of evidence verification."""

    # Agent ID from the evidence
    agent_id: str
    # Whether the evidence was verified successfully
    verified: bool
    # Channel token for authenticated communication
    channel_token: str
    # Verifier's Ed25519 session public key for signing verification
    session_public_key: str
    # When the attestation expires
    expires_at: int
    # Verifier's X25519 session public key for ECDH encryption
    session_x25519_public_key: str | None = field(default=None)
    # Token rotation policy
    rotation_policy: RotationPolicy | None = field(default=None)
    # Error message if verification failed
    error: str | None = field(default=None)


# ═══════════════════════════════════════════════════════════════════
# Agent Registry Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class RegisteredAgent:
    """A registered agent in the Verifier registry."""

    # Unique identifier for the agent
    agent_id: str
    # Agent's callback endpoint URL
    endpoint: str
    # URL to the agent's A2A Agent Card
    agent_card_url: str
    # Hash of the agent's code
    code_hash: str
    # Channel token for authenticated communication
    channel_token: str
    # When the agent was registered
    registered_at: int
    # When the registration expires
    expires_at: int


# ═══════════════════════════════════════════════════════════════════
# A2A Agent Card Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class AgentCardCapabilities:
    """Optional agent capabilities."""

    streaming: bool | None = field(default=None)
    push_notifications: bool | None = field(default=None)


@dataclass
class AgentCardSkill:
    """A skill/ability the agent provides."""

    id: str
    name: str
    description: str


@dataclass
class AgentCardAuthentication:
    """Authentication schemes supported by the agent."""

    schemes: list[str]


@dataclass
class AgentCard:
    """A2A Protocol Agent Card for discovery."""

    # Human-readable name
    name: str
    # Base URL of the agent
    url: str
    # Skills/abilities the agent provides
    skills: list[AgentCardSkill]
    # Description of the agent
    description: str | None = field(default=None)
    # Agent version
    version: str | None = field(default=None)
    # Optional capabilities
    capabilities: AgentCardCapabilities | None = field(default=None)
    # Authentication schemes supported
    authentication: AgentCardAuthentication | None = field(default=None)
