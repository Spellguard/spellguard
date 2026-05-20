# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp - Type definitions

Core types for the Auditable Messaging Protocol.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

# ═══════════════════════════════════════════════════════════════════
# Shared Policy Primitives
# ═══════════════════════════════════════════════════════════════════

Obligation = Literal[
    "log_access",
    "log_for_review",
    "require_human_approval",
    "audit_trail",
    "notify_owner",
    "rate_limit_check",
]

OBLIGATION_VALUES: tuple[str, ...] = (
    "log_access",
    "log_for_review",
    "require_human_approval",
    "audit_trail",
    "notify_owner",
    "rate_limit_check",
)

# ═══════════════════════════════════════════════════════════════════
# Message Types
# ═══════════════════════════════════════════════════════════════════

AttestationLevel = Literal["bilateral", "unilateral", "none"]


@dataclass
class SecureMessage:
    """A secure message encrypted with session keys."""

    id: str
    """Unique message identifier."""
    sender: str
    """Sender agent ID."""
    recipient: str
    """Recipient agent ID."""
    encrypted_payload: str
    """Encrypted payload (base64-encoded)."""
    timestamp: int
    """Timestamp when the message was created."""


# ═══════════════════════════════════════════════════════════════════
# Commitment Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class AuditCommitment:
    """
    Unified audit commitment for all agent-to-agent communication.
    Contains NO plaintext - only cryptographic proof of message existence.
    """

    message_id: str
    """Message ID this commitment refers to."""
    sender: str
    """Sender agent ID."""
    recipient: str
    """Recipient agent ID."""
    hash: str
    """SHA256 hash proving message existence."""
    timestamp: int
    """Timestamp of commitment generation."""
    attestation_level: AttestationLevel
    """Attestation level for this communication."""

    # === Unilateral-specific fields (present only for A2A-only recipients) ===

    direction: Literal["outbound", "inbound"] | None = None
    """Direction of unilateral interaction."""
    a2a_agent_url: str | None = None
    """URL of the A2A-only agent (for unilateral communication)."""
    reachable: bool | None = None
    """Whether the A2A agent was reachable (for unilateral communication)."""
    http_status: int | None = None
    """HTTP status code if a response was received (for unilateral communication)."""
    correlation_id: str | None = None
    """Correlation ID linking outbound request to inbound response."""



# ═══════════════════════════════════════════════════════════════════
# Channel Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class Channel:
    """A communication channel between two agents."""

    id: str
    """Unique channel identifier."""
    participants: tuple[str, str]
    """The two agents participating in this channel."""
    created_at: int
    """When the channel was created."""
    last_activity: int
    """Last activity timestamp."""


# ═══════════════════════════════════════════════════════════════════
# Logging Backend Types
# ═══════════════════════════════════════════════════════════════════


class CommitmentBackend(ABC):
    """
    Backend for logging message commitments to a tamper-evident audit trail.

    Implementations:
    - memory: In-memory for testing
    - rekor: Sigstore transparency log (free, public)
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Backend name for identification."""
        ...

    @abstractmethod
    async def init(self) -> None:
        """Initialize the backend."""
        ...

    @abstractmethod
    async def log_commitment(self, commitment: AuditCommitment) -> str | None:
        """
        Log a commitment to the audit trail.

        Returns:
            Entry ID/transaction hash, or None on failure.
        """
        ...

    @abstractmethod
    async def verify_commitment(self, commitment_hash: str) -> bool:
        """Verify a commitment exists in the audit trail."""
        ...

    @abstractmethod
    def is_connected(self) -> bool:
        """Check if the backend is connected and ready."""
        ...


class ArchiveBackend(ABC):
    """
    Backend for archiving encrypted messages.

    Implementations:
    - memory: In-memory for testing
    - s3: AWS S3 with Object Lock (WORM)
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Backend name for identification."""
        ...

    @abstractmethod
    async def init(self) -> None:
        """Initialize the backend."""
        ...

    @abstractmethod
    async def archive(
        self, message: SecureMessage, commitment: AuditCommitment
    ) -> str | None:
        """
        Archive an encrypted message.

        Returns:
            Archive ID, or None on failure.
        """
        ...

    @abstractmethod
    async def retrieve(self, archive_id: str) -> SecureMessage | None:
        """Retrieve an archived message."""
        ...

    @abstractmethod
    def is_connected(self) -> bool:
        """Check if the backend is connected and ready."""
        ...


@dataclass
class LoggingResult:
    """Result of logging and archiving operations."""

    commitment_id: str | None = None
    """Commitment entry ID (from Rekor, etc.)."""
    archive_id: str | None = None
    """Archive ID (from S3, etc.)."""
    warnings: list[str] = field(default_factory=list)
    """Warnings about partial failures."""


@dataclass
class BackendConfig:
    """Backend configuration."""

    commitment_backend: str
    """Commitment backend type."""
    archive_backend: str
    """Archive backend type."""


# ═══════════════════════════════════════════════════════════════════
# A2A Protocol Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class A2AMessagePart:
    """A single part of an A2A message."""

    type: Literal["text"]
    text: str


@dataclass
class A2AMessage:
    """A2A message with role and parts."""

    role: Literal["user"]
    parts: list[A2AMessagePart]


@dataclass
class A2ARequestParams:
    """Parameters for an A2A request."""

    id: str
    message: A2AMessage


@dataclass
class A2ARequest:
    """A2A JSON-RPC request format."""

    jsonrpc: Literal["2.0"]
    id: str
    method: Literal["tasks/send", "tasks/get"]
    params: A2ARequestParams


@dataclass
class A2AResponseStatus:
    """Status in an A2A response result."""

    state: Literal["completed", "pending", "failed"]


@dataclass
class A2AArtifact:
    """An artifact in an A2A response."""

    parts: list[A2AMessagePart]


@dataclass
class A2AResponseResult:
    """Result in an A2A response."""

    id: str
    status: A2AResponseStatus
    artifacts: list[A2AArtifact] | None = None


@dataclass
class A2AResponseError:
    """Error in an A2A response."""

    code: int
    message: str


@dataclass
class A2AResponse:
    """A2A JSON-RPC response format."""

    jsonrpc: Literal["2.0"]
    id: str
    result: A2AResponseResult | None = None
    error: A2AResponseError | None = None


# ═══════════════════════════════════════════════════════════════════
# Unilateral Communication Types
# ═══════════════════════════════════════════════════════════════════


@dataclass
class UnilateralSendRequest:
    """Request to send a message via unilateral communication (to an A2A-only agent)."""

    sender: str
    """Sender agent ID (must be Spellguard-attested)."""
    a2a_agent_url: str
    """URL of the A2A-only agent."""
    payload: Any
    """Payload to send."""
    method: Literal["tasks/send", "tasks/get"] | None = None
    """A2A method to use."""


@dataclass
class UnilateralCommitmentIds:
    """Commitment IDs for a single direction."""

    commitment_id: str | None = None
    archive_id: str | None = None


@dataclass
class UnilateralCommitments:
    """Commitment IDs for audit trail."""

    outbound: UnilateralCommitmentIds
    inbound: UnilateralCommitmentIds | None = None


@dataclass
class UnilateralSendResult:
    """Result of sending a message via unilateral communication."""

    success: bool
    """Whether the send was successful."""
    correlation_id: str
    """Correlation ID linking request and response."""
    commitments: UnilateralCommitments
    """Commitment IDs for audit trail."""
    response: A2AResponse | None = None
    """Response from the A2A agent (if successful)."""
    error: str | None = None
    """Error message (if unsuccessful)."""
    warnings: list[str] | None = None
    """Warnings about partial failures."""
