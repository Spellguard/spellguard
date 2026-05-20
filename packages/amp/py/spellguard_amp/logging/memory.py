# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.logging.memory - In-Memory Backends

Reference implementations for testing and development.
Data is lost when the process restarts.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from spellguard_amp.types import (
    ArchiveBackend,
    AuditCommitment,
    CommitmentBackend,
    SecureMessage,
)

# In-memory storage
_commitment_store: dict[str, CommitmentEntry] = {}
_archive_store: dict[str, SecureMessage] = {}


@dataclass
class CommitmentEntry:
    """An entry in the commitment store."""

    commitment: AuditCommitment
    entry_id: str
    timestamp: int


class MemoryCommitmentBackend(CommitmentBackend):
    """In-memory commitment backend."""

    @property
    def name(self) -> str:
        return "memory"

    async def init(self) -> None:
        print("[AMP/Memory] Commitment backend initialized (in-memory storage)")

    async def log_commitment(self, commitment: AuditCommitment) -> str | None:
        entry_id = f"mem_commit_{int(time.time() * 1000)}_{commitment.message_id}"
        _commitment_store[commitment.hash] = CommitmentEntry(
            commitment=commitment,
            entry_id=entry_id,
            timestamp=int(time.time() * 1000),
        )
        print(f"[AMP/Memory] Logged commitment: {commitment.hash} -> {entry_id}")
        return entry_id

    async def verify_commitment(self, commitment_hash: str) -> bool:
        return commitment_hash in _commitment_store

    def is_connected(self) -> bool:
        return True


class MemoryArchiveBackend(ArchiveBackend):
    """In-memory archive backend."""

    @property
    def name(self) -> str:
        return "memory"

    async def init(self) -> None:
        print("[AMP/Memory] Archive backend initialized (in-memory storage)")

    async def archive(
        self, message: SecureMessage, commitment: AuditCommitment
    ) -> str | None:
        archive_id = f"mem_archive_{int(time.time() * 1000)}_{message.id}"
        _archive_store[archive_id] = message
        print(f"[AMP/Memory] Archived message: {commitment.hash} -> {archive_id}")
        return archive_id

    async def retrieve(self, archive_id: str) -> SecureMessage | None:
        return _archive_store.get(archive_id)

    def is_connected(self) -> bool:
        return True


# Module-level singleton instances
memory_commitment_backend = MemoryCommitmentBackend()
memory_archive_backend = MemoryArchiveBackend()


def clear_memory_backends() -> None:
    """Clear all in-memory data (useful for testing)."""
    _commitment_store.clear()
    _archive_store.clear()


def get_commitment_count() -> int:
    """Get commitment count (useful for testing)."""
    return len(_commitment_store)


def get_archive_count() -> int:
    """Get archive count (useful for testing)."""
    return len(_archive_store)


def get_all_commitments() -> list[CommitmentEntry]:
    """
    Get all commitments (useful for testing).
    Returns commitments with their full data including attestation level.
    """
    return list(_commitment_store.values())
