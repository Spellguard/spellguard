# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Ephemeral Session Keys

RAM-only session key management for forward secrecy.
Keys are never persisted and destroyed on shutdown.

Ed25519 keys are used for signing.
X25519 keys are used for ECDH key agreement (encryption).
"""

from __future__ import annotations

import secrets

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

# RAM-only session keys - never persisted
_session_private_key: Ed25519PrivateKey | None = None
_session_private_key_seed: bytearray | None = None
_session_public_key: str | None = None

# X25519 keys for ECDH key agreement
_session_x25519_private_key: X25519PrivateKey | None = None
_session_x25519_private_key_bytes: bytearray | None = None
_session_x25519_public_key: str | None = None


async def generate_session_keys() -> None:
    """Generate ephemeral session keys.
    These exist ONLY in RAM and provide forward secrecy.
    Generates both Ed25519 (signing) and X25519 (encryption) key pairs.
    """
    global _session_private_key, _session_private_key_seed, _session_public_key
    global _session_x25519_private_key, _session_x25519_private_key_bytes, _session_x25519_public_key

    # Ed25519 for signing
    seed = secrets.token_bytes(32)
    _session_private_key_seed = bytearray(seed)
    _session_private_key = Ed25519PrivateKey.from_private_bytes(seed)
    public_key_bytes = _session_private_key.public_key().public_bytes_raw()
    _session_public_key = public_key_bytes.hex()

    # X25519 for ECDH key agreement
    x25519_priv_bytes = secrets.token_bytes(32)
    _session_x25519_private_key_bytes = bytearray(x25519_priv_bytes)
    _session_x25519_private_key = X25519PrivateKey.from_private_bytes(
        x25519_priv_bytes
    )
    x25519_pub_bytes = _session_x25519_private_key.public_key().public_bytes_raw()
    _session_x25519_public_key = x25519_pub_bytes.hex()

    print("[cTLS] Generated ephemeral session keys (Ed25519 + X25519, RAM-only)")


def destroy_session_keys() -> None:
    """Destroy session keys.
    Called on shutdown for forward secrecy.
    """
    global _session_private_key, _session_private_key_seed, _session_public_key
    global _session_x25519_private_key, _session_x25519_private_key_bytes, _session_x25519_public_key

    if _session_private_key_seed is not None:
        for i in range(len(_session_private_key_seed)):
            _session_private_key_seed[i] = 0
        _session_private_key_seed = None
    _session_private_key = None
    _session_public_key = None

    if _session_x25519_private_key_bytes is not None:
        for i in range(len(_session_x25519_private_key_bytes)):
            _session_x25519_private_key_bytes[i] = 0
        _session_x25519_private_key_bytes = None
    _session_x25519_private_key = None
    _session_x25519_public_key = None

    print("[cTLS] Destroyed session keys")


def get_session_public_key() -> str | None:
    """Get the Ed25519 session public key."""
    return _session_public_key


def get_session_x25519_public_key() -> str | None:
    """Get the X25519 session public key for ECDH key agreement."""
    return _session_x25519_public_key


def get_session_x25519_private_key() -> str | None:
    """Get the X25519 session private key (used by Verifier for decryption)."""
    if _session_x25519_private_key_bytes is None:
        return None
    return bytes(_session_x25519_private_key_bytes).hex()


async def sign_with_session_key(data: bytes) -> str:
    """Sign data with the session private key.

    Args:
        data: Raw bytes to sign.

    Returns:
        Hex-encoded signature.

    Raises:
        RuntimeError: If session keys are not initialized.
    """
    if _session_private_key is None:
        raise RuntimeError("Session keys not initialized")

    signature = _session_private_key.sign(data)
    return signature.hex()


async def verify_session_signature(data: bytes, signature: str) -> bool:
    """Verify a signature made with the session key.

    Args:
        data: Original bytes that were signed.
        signature: Hex-encoded signature.

    Returns:
        True if signature is valid.

    Raises:
        RuntimeError: If session keys are not initialized.
    """
    if _session_public_key is None:
        raise RuntimeError("Session keys not initialized")

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        pub_key = Ed25519PublicKey.from_public_bytes(
            bytes.fromhex(_session_public_key)
        )
        pub_key.verify(bytes.fromhex(signature), data)
        return True
    except Exception:
        return False
