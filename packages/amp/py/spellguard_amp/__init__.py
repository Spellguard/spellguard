# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp - Auditable Messaging Protocol

Commitment generation, message routing, and pluggable logging backends.

This package provides:
- Message commitment generation for tamper-evident audit trails
- Channel management for agent-to-agent communication
- Pluggable backends for commitment logging (memory)
- Pluggable backends for message archiving (memory)
- Client-side encryption utilities

Example - Server-side::

    from spellguard_amp import generate_commitment, init_logging_backends, log_and_archive

    await init_logging_backends()
    commitment = generate_commitment(message)
    result = await log_and_archive(message, commitment)

Example - Client-side::

    from spellguard_amp import encrypt_for_verifier, verify_archive_integrity

    encrypted = encrypt_for_verifier(payload, session_public_key)
    is_valid = await verify_archive_integrity(commitment, archive)
"""

from __future__ import annotations

# ═══════════════════════════════════════════════════════════════════
# Types
# ═══════════════════════════════════════════════════════════════════

from spellguard_amp.types import (
    A2ARequest,
    A2AResponse,
    ArchiveBackend,
    AttestationLevel,
    AuditCommitment,
    BackendConfig,
    Channel,
    CommitmentBackend,
    LoggingResult,
    Obligation,
    OBLIGATION_VALUES,
    SecureMessage,
    UnilateralSendRequest,
    UnilateralSendResult,
)

# ═══════════════════════════════════════════════════════════════════
# Client-side
# ═══════════════════════════════════════════════════════════════════

from spellguard_amp.client.encrypt import (
    decrypt_from_verifier,
    encrypt_for_verifier,
    hash_payload,
)
from spellguard_amp.client.verify import verify_archive_integrity

# ═══════════════════════════════════════════════════════════════════
# Server-side
# ═══════════════════════════════════════════════════════════════════

from spellguard_amp.server.commitment import (
    generate_commitment,
    generate_unilateral_commitment,
    verify_commitment,
)
from spellguard_amp.server.channel import (
    clear_channels,
    get_channel,
    get_channel_stats,
    get_or_create_channel,
    update_channel_activity,
)

# ═══════════════════════════════════════════════════════════════════
# Logging backends
# ═══════════════════════════════════════════════════════════════════

from spellguard_amp.logging import (
    archive_message,
    clear_memory_backends,
    get_all_commitments,
    get_archive_backend_name,
    get_archive_count,
    get_backend_config,
    get_commitment_backend_name,
    get_commitment_count,
    get_memory_archive_count,
    get_memory_commitment_count,
    init_logging_backends,
    is_archive_backend_connected,
    is_commitment_backend_connected,
    log_and_archive,
    log_commitment,
    memory_archive_backend,
    memory_commitment_backend,
    retrieve_archived_message,
    verify_commitment_exists,
)

__all__ = [
    # Types
    "SecureMessage",
    "AuditCommitment",
    "AttestationLevel",
    "Channel",
    "CommitmentBackend",
    "ArchiveBackend",
    "LoggingResult",
    "BackendConfig",
    "A2ARequest",
    "A2AResponse",
    "UnilateralSendRequest",
    "UnilateralSendResult",
    "Obligation",
    "OBLIGATION_VALUES",
    # Client-side
    "encrypt_for_verifier",
    "decrypt_from_verifier",
    "hash_payload",
    "verify_archive_integrity",
    # Server-side
    "generate_commitment",
    "verify_commitment",
    "generate_unilateral_commitment",
    "get_or_create_channel",
    "get_channel",
    "update_channel_activity",
    "get_channel_stats",
    "clear_channels",
    # Logging backends
    "init_logging_backends",
    "get_backend_config",
    "is_commitment_backend_connected",
    "is_archive_backend_connected",
    "get_commitment_backend_name",
    "get_archive_backend_name",
    "log_commitment",
    "verify_commitment_exists",
    "archive_message",
    "retrieve_archived_message",
    "log_and_archive",
    "memory_commitment_backend",
    "memory_archive_backend",
    "clear_memory_backends",
    "get_all_commitments",
    "get_archive_count",
    "get_commitment_count",
    "get_memory_archive_count",
    "get_memory_commitment_count",
]
