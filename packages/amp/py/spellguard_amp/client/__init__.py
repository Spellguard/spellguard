# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.client - Client-side utilities

Message encryption and integrity verification.
"""

from __future__ import annotations

from spellguard_amp.client.encrypt import (
    base64_to_bytes,
    bytes_to_base64,
    decrypt_from_verifier,
    encrypt_for_verifier,
    hash_payload,
)
from spellguard_amp.client.verify import verify_archive_integrity
from spellguard_amp.types import A2AResponse, AttestationLevel, UnilateralSendResult

__all__ = [
    "encrypt_for_verifier",
    "decrypt_from_verifier",
    "hash_payload",
    "bytes_to_base64",
    "base64_to_bytes",
    "verify_archive_integrity",
    "UnilateralSendResult",
    "A2AResponse",
    "AttestationLevel",
]
