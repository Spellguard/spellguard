# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls.crypto - Cryptographic utilities

Ed25519 signing, X25519 key agreement, and ephemeral key management.
"""

from __future__ import annotations

from .ephemeral import (
    destroy_session_keys,
    generate_session_keys,
    get_session_public_key,
    get_session_x25519_private_key,
    get_session_x25519_public_key,
    sign_with_session_key,
    verify_session_signature,
)
from .signing import generate_key_pair, sign, verify

__all__ = [
    # ephemeral
    "generate_session_keys",
    "destroy_session_keys",
    "get_session_public_key",
    "get_session_x25519_public_key",
    "get_session_x25519_private_key",
    "sign_with_session_key",
    "verify_session_signature",
    # signing
    "sign",
    "verify",
    "generate_key_pair",
]
