# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.server.commitment - Commitment Generation

Generate cryptographic commitments for message auditability.
"""

from __future__ import annotations

import hashlib

from spellguard_amp.types import AuditCommitment, SecureMessage


def generate_commitment(message: SecureMessage) -> AuditCommitment:
    """
    Generate a commitment hash for bilateral communication.

    This is what gets logged to the audit trail - NOT the plaintext payload.

    The commitment proves:
    1. A message existed between sender and recipient
    2. It was sent at a specific time
    3. The payload hasn't been tampered with (via payload_hash)

    But it does NOT reveal:
    - The actual message content
    - Any sensitive data in the payload

    Args:
        message: The secure message to generate commitment for.

    Returns:
        AuditCommitment with attestation_level 'bilateral'.
    """
    # Hash the encrypted payload
    payload_hash = hashlib.sha256(
        message.encrypted_payload.encode("utf-8")
    ).hexdigest()

    # Generate commitment hash: H(sender || recipient || timestamp || payload_hash)
    commitment_data = "|".join(
        [
            message.sender,
            message.recipient,
            str(message.timestamp),
            payload_hash,
        ]
    )

    commitment_hash = hashlib.sha256(commitment_data.encode("utf-8")).hexdigest()

    return AuditCommitment(
        message_id=message.id,
        sender=message.sender,
        recipient=message.recipient,
        hash=commitment_hash,
        timestamp=message.timestamp,
        attestation_level="bilateral",
    )


def verify_commitment(
    message: SecureMessage, commitment: AuditCommitment
) -> bool:
    """
    Verify a commitment matches a message.
    Used for audit purposes - anyone with the message can verify the commitment.

    Args:
        message: The original message.
        commitment: The commitment to verify.

    Returns:
        True if commitment matches the message.
    """
    generated = generate_commitment(message)
    return generated.hash == commitment.hash


def hash_payload(payload: str) -> str:
    """
    Hash a payload for inclusion in a commitment.

    Args:
        payload: Payload string to hash.

    Returns:
        Hex-encoded SHA256 hash.
    """
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def generate_unilateral_commitment(
    message: SecureMessage,
    direction: str,
    correlation_id: str,
    a2a_agent_url: str,
    reachable: bool,
    http_status: int | None = None,
) -> AuditCommitment:
    """
    Generate a commitment for unilateral communication (to an A2A-only agent).

    This creates a commitment that includes:
    - Direction (outbound/inbound)
    - Attestation level ('unilateral' - only sender is attested)
    - A2A agent URL
    - Reachability status
    - Correlation ID linking request/response

    Args:
        message: The secure message.
        direction: 'outbound' (to A2A agent) or 'inbound' (from A2A agent).
        correlation_id: ID linking outbound request to inbound response.
        a2a_agent_url: URL of the A2A-only agent.
        reachable: Whether the A2A agent was reachable.
        http_status: HTTP status code (if response received).

    Returns:
        AuditCommitment with attestation_level 'unilateral'.
    """
    # Generate base commitment (will have bilateral, we override)
    base = generate_commitment(message)

    return AuditCommitment(
        message_id=base.message_id,
        sender=base.sender,
        recipient=base.recipient,
        hash=base.hash,
        timestamp=base.timestamp,
        attestation_level="unilateral",
        direction=direction,  # type: ignore[arg-type]
        a2a_agent_url=a2a_agent_url,
        reachable=reachable,
        http_status=http_status,
        correlation_id=correlation_id,
    )
