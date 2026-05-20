# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.client.encrypt - Message Encryption

ECDH + AES-256-GCM encryption for Verifier communication.

Wire format (version 0x01):
  0x01 || ephemeral_public_key (32 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)
Base64-encoded for transport.
"""

from __future__ import annotations

import base64
import hashlib
import secrets

from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

VERSION_BYTE = 0x01
NONCE_LENGTH = 12
KEY_LENGTH = 32


def encrypt_for_verifier(payload: str, verifier_x25519_public_key: str) -> str:
    """
    Encrypt a payload for the Verifier using ephemeral ECDH + AES-256-GCM.

    For each encryption:
    1. Generate fresh X25519 ephemeral key pair
    2. Compute shared secret via ECDH(ephemeral_private, verifier_x25519_public)
    3. Derive AES key via HKDF-SHA256
    4. Encrypt with AES-256-GCM (random 96-bit nonce)

    Args:
        payload: Plaintext payload to encrypt.
        verifier_x25519_public_key: Verifier's X25519 public key (hex-encoded).

    Returns:
        Base64-encoded encrypted payload.
    """
    payload_bytes = payload.encode("utf-8")
    verifier_public_key_bytes = hex_to_bytes(verifier_x25519_public_key)

    # Generate ephemeral X25519 key pair for this encryption
    ephemeral_private_key = X25519PrivateKey.generate()
    ephemeral_public_key_bytes = ephemeral_private_key.public_key().public_bytes_raw()

    # ECDH: compute shared secret
    verifier_public_key = X25519PublicKey.from_public_bytes(verifier_public_key_bytes)
    shared_secret = ephemeral_private_key.exchange(verifier_public_key)

    # Derive AES key via HKDF-SHA256
    aes_key = HKDF(
        algorithm=SHA256(),
        length=KEY_LENGTH,
        salt=None,
        info=b"spellguard-amp-v1",
    ).derive(shared_secret)

    # Generate random nonce
    nonce = secrets.token_bytes(NONCE_LENGTH)

    # Encrypt with AES-256-GCM
    aesgcm = AESGCM(aes_key)
    ciphertext = aesgcm.encrypt(nonce, payload_bytes, None)

    # Build wire format: version || ephemeral_public_key || nonce || ciphertext+tag
    result = bytearray()
    result.append(VERSION_BYTE)
    result.extend(ephemeral_public_key_bytes)
    result.extend(nonce)
    result.extend(ciphertext)

    return bytes_to_base64(bytes(result))


def decrypt_from_verifier(encrypted_payload: str, x25519_private_key: str) -> str:
    """
    Decrypt a payload from the Verifier.

    Args:
        encrypted_payload: Base64-encoded encrypted payload.
        x25519_private_key: Recipient's X25519 private key (hex-encoded).

    Returns:
        Decrypted plaintext payload.
    """
    data = base64_to_bytes(encrypted_payload)
    private_key_bytes = hex_to_bytes(x25519_private_key)

    # Parse wire format
    version = data[0]
    if version != VERSION_BYTE:
        raise ValueError(f"Unsupported encryption version: {version}")

    min_overhead = 1 + 32 + 12 + 16  # version + ephemeral_pub_key + nonce + GCM tag
    if len(data) < min_overhead:
        raise ValueError(
            f"Encrypted payload too short: {len(data)} bytes (minimum {min_overhead})"
        )

    ephemeral_public_key_bytes = data[1:33]
    nonce = data[33 : 33 + NONCE_LENGTH]
    ciphertext = data[33 + NONCE_LENGTH :]

    # ECDH: compute shared secret
    private_key = X25519PrivateKey.from_private_bytes(private_key_bytes)
    ephemeral_public_key = X25519PublicKey.from_public_bytes(
        ephemeral_public_key_bytes
    )
    shared_secret = private_key.exchange(ephemeral_public_key)

    # Derive AES key via HKDF-SHA256
    aes_key = HKDF(
        algorithm=SHA256(),
        length=KEY_LENGTH,
        salt=None,
        info=b"spellguard-amp-v1",
    ).derive(shared_secret)

    # Decrypt with AES-256-GCM
    aesgcm = AESGCM(aes_key)
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)

    return plaintext.decode("utf-8")


def hash_payload(payload: str) -> str:
    """
    Hash a payload for commitment verification.

    Args:
        payload: Payload to hash.

    Returns:
        Hex-encoded SHA256 hash.
    """
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def bytes_to_hex(data: bytes) -> str:
    """Convert bytes to hex string."""
    return data.hex()


def hex_to_bytes(hex_str: str) -> bytes:
    """Convert hex string to bytes."""
    return bytes.fromhex(hex_str)


def bytes_to_base64(data: bytes) -> str:
    """Convert bytes to base64 string."""
    return base64.b64encode(data).decode("ascii")


def base64_to_bytes(b64_str: str) -> bytes:
    """Convert base64 string to bytes."""
    return base64.b64decode(b64_str)
