# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the spellguard_amp Python package.

Tests encryption/decryption, hashing, commitments, channel management,
memory logging backends, and type constructors.
"""
import time

import pytest

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from spellguard_amp import (
    AuditCommitment,
    Channel,
    LoggingResult,
    SecureMessage,
    UnilateralSendRequest,
    UnilateralSendResult,
    clear_channels,
    clear_memory_backends,
    decrypt_from_verifier,
    encrypt_for_verifier,
    generate_commitment,
    generate_unilateral_commitment,
    get_channel,
    get_channel_stats,
    get_or_create_channel,
    hash_payload,
    update_channel_activity,
    verify_commitment,
)
from spellguard_amp.logging.memory import (
    MemoryArchiveBackend,
    MemoryCommitmentBackend,
    clear_memory_backends as clear_mem,
)


def _generate_x25519_keypair() -> dict[str, str]:
    """Generate an X25519 key pair for testing."""
    priv = X25519PrivateKey.generate()
    pub_bytes = priv.public_key().public_bytes_raw()
    priv_bytes = priv.private_bytes_raw()
    return {
        "public_key": pub_bytes.hex(),
        "private_key": priv_bytes.hex(),
    }


def _make_message(
    msg_id: str = "msg-1",
    sender: str = "agent-a",
    recipient: str = "agent-b",
    payload: str = "encrypted-payload-data",
) -> SecureMessage:
    return SecureMessage(
        id=msg_id,
        sender=sender,
        recipient=recipient,
        encrypted_payload=payload,
        timestamp=int(time.time() * 1000),
    )


# =====================================================================
# Encryption / Decryption
# =====================================================================


class TestPythonEncryption:
    def test_encrypt_decrypt_roundtrip(self):
        kp = _generate_x25519_keypair()
        plaintext = "Hello from Python Spellguard tests!"
        encrypted = encrypt_for_verifier(plaintext, kp["public_key"])
        decrypted = decrypt_from_verifier(encrypted, kp["private_key"])
        assert decrypted == plaintext

    def test_encrypt_decrypt_empty_message(self):
        kp = _generate_x25519_keypair()
        encrypted = encrypt_for_verifier("", kp["public_key"])
        decrypted = decrypt_from_verifier(encrypted, kp["private_key"])
        assert decrypted == ""

    def test_encrypt_decrypt_long_message(self):
        kp = _generate_x25519_keypair()
        long_msg = "A" * 10000
        encrypted = encrypt_for_verifier(long_msg, kp["public_key"])
        decrypted = decrypt_from_verifier(encrypted, kp["private_key"])
        assert decrypted == long_msg

    def test_encrypt_decrypt_unicode(self):
        kp = _generate_x25519_keypair()
        unicode_msg = "Special chars: e n chinese"
        encrypted = encrypt_for_verifier(unicode_msg, kp["public_key"])
        decrypted = decrypt_from_verifier(encrypted, kp["private_key"])
        assert decrypted == unicode_msg

    def test_different_ciphertext_for_same_message(self):
        kp = _generate_x25519_keypair()
        msg = "Same message"
        c1 = encrypt_for_verifier(msg, kp["public_key"])
        c2 = encrypt_for_verifier(msg, kp["public_key"])
        # Ephemeral keys + random nonce => different ciphertext
        assert c1 != c2

    def test_decrypt_with_wrong_key_fails(self):
        kp1 = _generate_x25519_keypair()
        kp2 = _generate_x25519_keypair()
        encrypted = encrypt_for_verifier("Secret", kp1["public_key"])
        with pytest.raises(Exception):
            decrypt_from_verifier(encrypted, kp2["private_key"])


# =====================================================================
# Hashing
# =====================================================================


class TestPythonHashing:
    def test_hash_payload_returns_sha256_hex(self):
        result = hash_payload("test data")
        assert len(result) == 64
        # Must be valid hex
        bytes.fromhex(result)

    def test_hash_is_deterministic(self):
        assert hash_payload("foo") == hash_payload("foo")

    def test_hash_differs_for_different_inputs(self):
        assert hash_payload("input1") != hash_payload("input2")


# =====================================================================
# Commitment Generation
# =====================================================================


class TestPythonCommitments:
    def test_generate_commitment_creates_valid_structure(self):
        msg = _make_message()
        commitment = generate_commitment(msg)

        assert commitment.message_id == msg.id
        assert commitment.sender == msg.sender
        assert commitment.recipient == msg.recipient
        assert commitment.attestation_level == "bilateral"
        assert len(commitment.hash) == 64
        bytes.fromhex(commitment.hash)

    def test_verify_commitment_succeeds_for_matching_message(self):
        msg = _make_message()
        commitment = generate_commitment(msg)
        assert verify_commitment(msg, commitment) is True

    def test_verify_commitment_fails_for_tampered_message(self):
        msg = _make_message(payload="original")
        commitment = generate_commitment(msg)

        tampered = _make_message(payload="tampered")
        tampered.id = msg.id
        tampered.timestamp = msg.timestamp
        assert verify_commitment(tampered, commitment) is False

    def test_generate_unilateral_commitment(self):
        msg = _make_message()
        commitment = generate_unilateral_commitment(
            message=msg,
            direction="outbound",
            correlation_id="corr-123",
            a2a_agent_url="http://localhost:8789",
            reachable=True,
            http_status=200,
        )

        assert commitment.attestation_level == "unilateral"
        assert commitment.direction == "outbound"
        assert commitment.correlation_id == "corr-123"
        assert commitment.a2a_agent_url == "http://localhost:8789"
        assert commitment.reachable is True
        assert commitment.http_status == 200


# =====================================================================
# Channel Management
# =====================================================================


class TestPythonChannels:
    def setup_method(self):
        clear_channels()

    def teardown_method(self):
        clear_channels()

    def test_get_or_create_channel(self):
        ch = get_or_create_channel("agent-a", "agent-b")
        assert ch.id == "channel_agent-a_agent-b"
        assert set(ch.participants) == {"agent-a", "agent-b"}

    def test_get_or_create_channel_is_order_independent(self):
        ch1 = get_or_create_channel("agent-b", "agent-a")
        ch2 = get_or_create_channel("agent-a", "agent-b")
        assert ch1.id == ch2.id

    def test_get_channel(self):
        ch = get_or_create_channel("x", "y")
        found = get_channel(ch.id)
        assert found is not None
        assert found.id == ch.id
        assert get_channel("nonexistent") is None

    def test_update_channel_activity(self):
        ch = get_or_create_channel("a", "b")
        old_activity = ch.last_activity
        # Small delay to ensure timestamp differs
        import time as t

        t.sleep(0.01)
        update_channel_activity(ch.id)
        updated = get_channel(ch.id)
        assert updated is not None
        assert updated.last_activity >= old_activity

    def test_get_channel_stats(self):
        get_or_create_channel("a", "b")
        get_or_create_channel("c", "d")
        stats = get_channel_stats()
        assert stats["total"] == 2
        assert stats["active"] == 2
        assert stats["stale"] == 0

    def test_clear_channels(self):
        get_or_create_channel("a", "b")
        assert get_channel_stats()["total"] == 1
        clear_channels()
        assert get_channel_stats()["total"] == 0


# =====================================================================
# Memory Logging Backends
# =====================================================================


class TestPythonMemoryBackends:
    def setup_method(self):
        clear_mem()

    def teardown_method(self):
        clear_mem()

    async def test_commitment_backend_log_and_verify(self):
        backend = MemoryCommitmentBackend()
        await backend.init()

        msg = _make_message()
        commitment = generate_commitment(msg)
        entry_id = await backend.log_commitment(commitment)

        assert entry_id is not None
        assert await backend.verify_commitment(commitment.hash) is True
        assert await backend.verify_commitment("nonexistent") is False

    async def test_archive_backend_archive_and_retrieve(self):
        backend = MemoryArchiveBackend()
        await backend.init()

        msg = _make_message()
        commitment = generate_commitment(msg)
        archive_id = await backend.archive(msg, commitment)

        assert archive_id is not None
        retrieved = await backend.retrieve(archive_id)
        assert retrieved is not None
        assert retrieved.id == msg.id
        assert retrieved.encrypted_payload == msg.encrypted_payload

    async def test_archive_retrieve_nonexistent_returns_none(self):
        backend = MemoryArchiveBackend()
        await backend.init()
        assert await backend.retrieve("nonexistent") is None

    def test_backends_are_connected(self):
        assert MemoryCommitmentBackend().is_connected() is True
        assert MemoryArchiveBackend().is_connected() is True

    def test_backend_names(self):
        assert MemoryCommitmentBackend().name == "memory"
        assert MemoryArchiveBackend().name == "memory"


# =====================================================================
# Type Constructors
# =====================================================================


class TestPythonAmpTypes:
    def test_secure_message(self):
        msg = SecureMessage(
            id="msg-1",
            sender="a",
            recipient="b",
            encrypted_payload="payload",
            timestamp=1234567890,
        )
        assert msg.sender == "a"

    def test_audit_commitment(self):
        c = AuditCommitment(
            message_id="m1",
            sender="a",
            recipient="b",
            hash="h",
            timestamp=123,
            attestation_level="bilateral",
        )
        assert c.attestation_level == "bilateral"
        assert c.direction is None

    def test_channel(self):
        ch = Channel(
            id="ch-1",
            participants=("a", "b"),
            created_at=100,
            last_activity=200,
        )
        assert ch.participants == ("a", "b")

    def test_logging_result(self):
        r = LoggingResult(commitment_id="c1", archive_id="a1")
        assert r.warnings == []

    def test_unilateral_send_request(self):
        req = UnilateralSendRequest(
            sender="agent-a",
            a2a_agent_url="http://localhost:8789",
            payload={"text": "hello"},
        )
        assert req.sender == "agent-a"
        assert req.method is None
