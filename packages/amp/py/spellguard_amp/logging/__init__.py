# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.logging - Pluggable Logging Backend System

Supports multiple backends for commitment logging and message archiving:

Commitment Backends (tamper-evident audit trail):
- 'memory': In-memory for testing

Archive Backends (encrypted message storage):
- 'memory': In-memory for testing

Configuration via environment variables:
- COMMITMENT_BACKEND: 'memory' (default: 'memory')
- ARCHIVE_BACKEND: 'memory' (default: 'memory')
"""

from __future__ import annotations

import asyncio
import os

from spellguard_amp.logging.memory import (
    clear_memory_backends,
    get_all_commitments,
    memory_archive_backend,
    memory_commitment_backend,
)
from spellguard_amp.logging.memory import get_archive_count as get_memory_archive_count
from spellguard_amp.logging.memory import (
    get_commitment_count as get_memory_commitment_count,
)
from spellguard_amp.types import (
    ArchiveBackend,
    AuditCommitment,
    BackendConfig,
    CommitmentBackend,
    LoggingResult,
    SecureMessage,
)

__all__ = [
    # Backend management
    "init_logging_backends",
    "get_backend_config",
    "is_commitment_backend_connected",
    "is_archive_backend_connected",
    "get_commitment_backend_name",
    "get_archive_backend_name",
    # Operations
    "log_commitment",
    "verify_commitment_exists",
    "archive_message",
    "retrieve_archived_message",
    "log_and_archive",
    # Backend implementations
    "memory_commitment_backend",
    "memory_archive_backend",
    # Testing utilities
    "clear_memory_backends",
    "get_all_commitments",
    "get_archive_count",
    "get_commitment_count",
    "get_memory_archive_count",
    "get_memory_commitment_count",
    # Types
    "ArchiveBackend",
    "BackendConfig",
    "CommitmentBackend",
    "LoggingResult",
]

# Backend-aware counters (increment on successful log/archive regardless of backend)
_commitment_count = 0
_archive_count = 0

# Current active backends
_commitment_backend: CommitmentBackend = memory_commitment_backend
_archive_backend: ArchiveBackend = memory_archive_backend


def get_commitment_count() -> int:
    """Get the total number of commitments logged across all backends."""
    return _commitment_count


def get_archive_count() -> int:
    """Get the total number of messages archived across all backends."""
    return _archive_count


def get_backend_config() -> BackendConfig:
    """Get backend configuration from environment."""
    return BackendConfig(
        commitment_backend=os.environ.get("COMMITMENT_BACKEND", "memory"),
        archive_backend=os.environ.get("ARCHIVE_BACKEND", "memory"),
    )


async def init_logging_backends() -> None:
    """Initialize logging backends based on environment configuration."""
    global _commitment_backend, _archive_backend

    config = get_backend_config()

    print("[AMP] Initializing backends...")
    print(f"[AMP]   Commitment backend: {config.commitment_backend}")
    print(f"[AMP]   Archive backend: {config.archive_backend}")

    _commitment_backend = await _init_commitment_backend(config.commitment_backend)
    _archive_backend = await _init_archive_backend(config.archive_backend)

    print("[AMP] Backends initialized")


async def _init_commitment_backend(name: str) -> CommitmentBackend:
    """Initialize a commitment backend by name."""
    backend: CommitmentBackend

    match name.lower():
        case _:
            backend = memory_commitment_backend

    await backend.init()
    return backend


async def _init_archive_backend(name: str) -> ArchiveBackend:
    """Initialize an archive backend by name."""
    backend: ArchiveBackend

    match name.lower():
        case _:
            backend = memory_archive_backend

    await backend.init()
    return backend


async def log_commitment(commitment: AuditCommitment) -> str | None:
    """Log a commitment using the configured backend."""
    global _commitment_count
    result = await _commitment_backend.log_commitment(commitment)
    if result is not None:
        _commitment_count += 1
    return result


async def verify_commitment_exists(commitment_hash: str) -> bool:
    """Verify a commitment exists using the configured backend."""
    return await _commitment_backend.verify_commitment(commitment_hash)


async def archive_message(
    message: SecureMessage, commitment: AuditCommitment
) -> str | None:
    """Archive a message using the configured backend."""
    global _archive_count
    result = await _archive_backend.archive(message, commitment)
    if result is not None:
        _archive_count += 1
    return result


async def retrieve_archived_message(archive_id: str) -> SecureMessage | None:
    """Retrieve an archived message using the configured backend."""
    return await _archive_backend.retrieve(archive_id)


async def log_and_archive(
    message: SecureMessage, commitment: AuditCommitment
) -> LoggingResult:
    """
    Log and archive a message in one operation.
    Returns IDs and any warnings about failures.
    """
    warnings: list[str] = []

    # Run both operations concurrently
    commitment_task = asyncio.create_task(log_commitment(commitment))
    archive_task = asyncio.create_task(archive_message(message, commitment))

    results = await asyncio.gather(commitment_task, archive_task, return_exceptions=True)

    commitment_id: str | None = None
    if isinstance(results[0], str):
        commitment_id = results[0]
    elif isinstance(results[0], Exception):
        warnings.append(
            f"{_commitment_backend.name} commitment logging unavailable or failed"
        )
    elif results[0] is None:
        warnings.append(
            f"{_commitment_backend.name} commitment logging unavailable or failed"
        )

    archive_id: str | None = None
    if isinstance(results[1], str):
        archive_id = results[1]
    elif isinstance(results[1], Exception):
        warnings.append(f"{_archive_backend.name} archival unavailable or failed")
    elif results[1] is None:
        warnings.append(f"{_archive_backend.name} archival unavailable or failed")

    return LoggingResult(
        commitment_id=commitment_id,
        archive_id=archive_id,
        warnings=warnings,
    )


def is_commitment_backend_connected() -> bool:
    """Check if commitment backend is connected."""
    return _commitment_backend.is_connected()


def is_archive_backend_connected() -> bool:
    """Check if archive backend is connected."""
    return _archive_backend.is_connected()


def get_commitment_backend_name() -> str:
    """Get the name of the active commitment backend."""
    return _commitment_backend.name


def get_archive_backend_name() -> str:
    """Get the name of the active archive backend."""
    return _archive_backend.name
