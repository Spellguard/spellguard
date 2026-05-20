# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Ed25519 Signing Utilities

Key generation, signing, and verification.
"""

from __future__ import annotations

import hashlib
import re
import secrets

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


async def generate_key_pair() -> dict[str, str]:
    """Generate an Ed25519 key pair.

    Returns:
        Dict with 'public_key' and 'private_key' as hex strings.
    """
    seed = secrets.token_bytes(32)
    private_key = Ed25519PrivateKey.from_private_bytes(seed)
    public_key_bytes = private_key.public_key().public_bytes_raw()

    return {
        "public_key": public_key_bytes.hex(),
        "private_key": seed.hex(),
    }


async def sign(data: str, private_key: str) -> str:
    """Sign data with a private key.

    If private_key is not a valid 64-char hex string (32 bytes), it's treated
    as a seed and hashed with SHA256 to derive a 32-byte private key.

    Args:
        data: Data to sign.
        private_key: Private key (hex) or seed string.

    Returns:
        Hex-encoded signature.
    """
    data_bytes = data.encode("utf-8")

    # Check if private_key is a valid 64-char hex string (32 bytes)
    is_valid_hex = bool(re.fullmatch(r"[0-9a-fA-F]{64}", private_key))
    if is_valid_hex:
        key_bytes = bytes.fromhex(private_key)
    else:
        # Derive key from seed
        key_bytes = hashlib.sha256(private_key.encode("utf-8")).digest()

    ed_private_key = Ed25519PrivateKey.from_private_bytes(key_bytes)
    signature = ed_private_key.sign(data_bytes)
    return signature.hex()


async def verify(data: str, signature: str, public_key: str) -> bool:
    """Verify an Ed25519 signature.

    Args:
        data: Original data that was signed.
        signature: Hex-encoded signature.
        public_key: Hex-encoded public key.

    Returns:
        True if signature is valid.
    """
    data_bytes = data.encode("utf-8")
    try:
        ed_public_key = Ed25519PublicKey.from_public_bytes(
            bytes.fromhex(public_key)
        )
        ed_public_key.verify(bytes.fromhex(signature), data_bytes)
        return True
    except Exception:
        return False
