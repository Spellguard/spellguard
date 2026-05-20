# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the spellguard_ctls Python package.

Tests Ed25519 signing, ephemeral session keys, evidence building,
agent registry, and type constructors.
"""
import time

import pytest

from spellguard_ctls import (
    AttestationResult,
    BuildEvidenceOptions,
    Evidence,
    EvidenceClaims,
    RegisteredAgent,
    RotationPolicy,
    SessionKeys,
    VerifierAttestationDocument,
    build_evidence,
    clear_registry,
    get_agent,
    get_agent_by_token,
    is_agent_registered,
    register_agent,
    rotate_channel_token,
    sign_evidence,
    verify_channel_token,
)
from spellguard_ctls.crypto import (
    destroy_session_keys,
    generate_key_pair,
    generate_session_keys,
    get_session_public_key,
    sign,
    sign_with_session_key,
    verify,
    verify_session_signature,
)


# =====================================================================
# Key Generation
# =====================================================================


class TestPythonKeyGeneration:
    async def test_generate_key_pair_returns_hex_strings(self):
        kp = await generate_key_pair()
        assert "public_key" in kp
        assert "private_key" in kp
        # 32 bytes = 64 hex chars
        assert len(kp["public_key"]) == 64
        assert len(kp["private_key"]) == 64
        # Valid hex
        bytes.fromhex(kp["public_key"])
        bytes.fromhex(kp["private_key"])

    async def test_generate_key_pair_produces_unique_keys(self):
        kp1 = await generate_key_pair()
        kp2 = await generate_key_pair()
        assert kp1["public_key"] != kp2["public_key"]
        assert kp1["private_key"] != kp2["private_key"]


# =====================================================================
# Signing and Verification
# =====================================================================


class TestPythonSignAndVerify:
    async def test_sign_and_verify_roundtrip(self):
        kp = await generate_key_pair()
        message = "Hello, Spellguard!"
        signature = await sign(message, kp["private_key"])
        assert await verify(message, signature, kp["public_key"]) is True

    async def test_verify_with_wrong_key_fails(self):
        kp1 = await generate_key_pair()
        kp2 = await generate_key_pair()
        message = "Secret message"
        signature = await sign(message, kp1["private_key"])
        assert await verify(message, signature, kp2["public_key"]) is False

    async def test_verify_with_tampered_message_fails(self):
        kp = await generate_key_pair()
        signature = await sign("original", kp["private_key"])
        assert await verify("tampered", signature, kp["public_key"]) is False

    async def test_sign_with_seed_string(self):
        """Non-hex private key should be treated as a seed (SHA256-hashed)."""
        seed = "my-agent-code-hash"
        message = "Test message"
        sig1 = await sign(message, seed)
        sig2 = await sign(message, seed)
        # Deterministic: same seed + message -> same signature
        assert sig1 == sig2

    async def test_sign_with_seed_produces_valid_signature(self):
        """Seed-derived signatures can be verified with the derived public key."""
        import hashlib

        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )

        seed = "test-seed-value"
        key_bytes = hashlib.sha256(seed.encode("utf-8")).digest()
        priv = Ed25519PrivateKey.from_private_bytes(key_bytes)
        pub_hex = priv.public_key().public_bytes_raw().hex()

        message = "Data to sign"
        signature = await sign(message, seed)
        assert await verify(message, signature, pub_hex) is True


# =====================================================================
# Session Keys
# =====================================================================


class TestPythonSessionKeys:
    async def test_generate_and_get_session_keys(self):
        await generate_session_keys()
        pub = get_session_public_key()
        assert pub is not None
        assert len(pub) == 64
        bytes.fromhex(pub)
        # Clean up
        destroy_session_keys()

    async def test_destroy_session_keys_clears_state(self):
        await generate_session_keys()
        assert get_session_public_key() is not None
        destroy_session_keys()
        assert get_session_public_key() is None

    async def test_sign_and_verify_with_session_key(self):
        await generate_session_keys()
        data = b"session-signed data"
        signature = await sign_with_session_key(data)
        assert await verify_session_signature(data, signature) is True
        # Tampered data should fail
        assert await verify_session_signature(b"wrong data", signature) is False
        destroy_session_keys()

    async def test_sign_with_session_key_raises_without_init(self):
        destroy_session_keys()
        with pytest.raises(RuntimeError, match="Session keys not initialized"):
            await sign_with_session_key(b"data")


# =====================================================================
# Evidence
# =====================================================================


class TestPythonEvidence:
    def test_build_evidence_creates_proper_structure(self):
        opts = BuildEvidenceOptions(
            agent_id="agent-pa",
            code_hash="abc123",
            endpoint="http://localhost:8801",
            agent_card_url="http://localhost:8801/.well-known/agent.json",
            capabilities=["receive", "send"],
        )
        evidence = build_evidence(opts)

        assert evidence.agent_id == "agent-pa"
        assert evidence.claims.code_hash == "abc123"
        assert evidence.claims.endpoint == "http://localhost:8801"
        assert evidence.claims.capabilities == ["receive", "send"]
        # Unsigned
        assert evidence.signature == ""

    def test_build_evidence_default_capabilities(self):
        opts = BuildEvidenceOptions(
            agent_id="test",
            code_hash="hash",
            endpoint="http://localhost",
            agent_card_url="http://localhost/agent.json",
        )
        evidence = build_evidence(opts)
        assert evidence.claims.capabilities == ["receive", "send"]

    async def test_sign_evidence_adds_valid_signature(self):
        kp = await generate_key_pair()
        opts = BuildEvidenceOptions(
            agent_id="agent-test",
            code_hash="deadbeef",
            endpoint="http://localhost:9999",
            agent_card_url="http://localhost:9999/.well-known/agent.json",
        )
        evidence = build_evidence(opts)
        signed = await sign_evidence(evidence, kp["private_key"])

        assert signed.signature != ""
        assert len(signed.signature) == 128  # 64-byte Ed25519 sig = 128 hex chars
        assert signed.agent_id == evidence.agent_id
        assert signed.claims == evidence.claims

    async def test_sign_evidence_binds_agent_id_cr_001(self):
        """CR-001: signature must cover {agentId, claims} so that swapping
        agent_id while keeping the same signature fails verification.
        """
        from spellguard_ctls.server.verifier import _verify_evidence_signature

        kp = await generate_key_pair()
        opts = BuildEvidenceOptions(
            agent_id="alice",
            code_hash="deadbeef",
            endpoint="http://localhost:9999",
            agent_card_url="http://localhost:9999/.well-known/agent.json",
        )
        evidence = build_evidence(opts)
        signed = await sign_evidence(evidence, kp["private_key"])

        # Signature must verify under the original agent_id
        assert (
            await _verify_evidence_signature(signed, kp["public_key"]) is True
        )

        # Swapping agent_id while preserving the signature must fail —
        # this is exactly the identity-substitution attack CR-001 closes.
        spoofed = Evidence(
            agent_id="mallory",
            claims=signed.claims,
            signature=signed.signature,
        )
        assert (
            await _verify_evidence_signature(spoofed, kp["public_key"]) is False
        )


# =====================================================================
# Agent Registry
# =====================================================================


class TestPythonRegistry:
    def setup_method(self):
        clear_registry()

    def teardown_method(self):
        clear_registry()

    def test_register_and_get_agent(self):
        now = int(time.time() * 1000)
        agent = RegisteredAgent(
            agent_id="agent-pa",
            endpoint="http://localhost:8801",
            agent_card_url="http://localhost:8801/.well-known/agent.json",
            code_hash="abc",
            channel_token="tok-123",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        result = register_agent(agent)
        assert result.success is True

        retrieved = get_agent("agent-pa")
        assert retrieved is not None
        assert retrieved.agent_id == "agent-pa"
        assert retrieved.endpoint == "http://localhost:8801"

    def test_get_agent_by_token(self):
        now = int(time.time() * 1000)
        agent = RegisteredAgent(
            agent_id="agent-x",
            endpoint="http://localhost:1234",
            agent_card_url="http://localhost:1234/agent.json",
            code_hash="xyz",
            channel_token="secret-token",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        register_agent(agent)

        found = get_agent_by_token("secret-token")
        assert found is not None
        assert found.agent_id == "agent-x"

        assert get_agent_by_token("wrong-token") is None

    def test_is_agent_registered(self):
        assert is_agent_registered("nonexistent") is False

        now = int(time.time() * 1000)
        agent = RegisteredAgent(
            agent_id="reg-test",
            endpoint="http://localhost",
            agent_card_url="http://localhost/agent.json",
            code_hash="h",
            channel_token="t",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        register_agent(agent)
        assert is_agent_registered("reg-test") is True

    def test_verify_channel_token(self):
        now = int(time.time() * 1000)
        agent = RegisteredAgent(
            agent_id="token-test",
            endpoint="http://localhost",
            agent_card_url="http://localhost/agent.json",
            code_hash="h",
            channel_token="valid-token",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        register_agent(agent)

        assert verify_channel_token("valid-token") is True
        assert verify_channel_token("invalid-token") is False

    def test_rotate_channel_token(self):
        now = int(time.time() * 1000)
        old_token = "old-token"
        agent = RegisteredAgent(
            agent_id="rotate-test",
            endpoint="http://localhost",
            agent_card_url="http://localhost/agent.json",
            code_hash="h",
            channel_token=old_token,
            registered_at=now,
            expires_at=now + 3600_000,
        )
        register_agent(agent)

        result = rotate_channel_token("rotate-test")
        assert result is not None
        assert "token" in result
        assert result["token"] != old_token
        # Old token no longer valid
        assert verify_channel_token(old_token) is False
        # New token is valid
        assert verify_channel_token(result["token"]) is True

    def test_rotate_nonexistent_agent_returns_none(self):
        assert rotate_channel_token("nonexistent") is None

    def test_re_registration_with_different_endpoint_is_rejected_by_default(self):
        now = int(time.time() * 1000)
        original = RegisteredAgent(
            agent_id="markets-analyst",
            endpoint="https://fleet.test.example.com/agents/markets-analyst/_spellguard/receive",
            agent_card_url="https://fleet.test.example.com/agents/markets-analyst/.well-known/agent.json",
            code_hash="sha256:abc",
            channel_token="tok-original",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        register_agent(original)

        moved = RegisteredAgent(
            agent_id="markets-analyst",
            endpoint="https://fleet-old.example.com/agents/markets-analyst/_spellguard/receive",
            agent_card_url="https://fleet-old.example.com/agents/markets-analyst/.well-known/agent.json",
            code_hash="sha256:abc",
            channel_token="tok-2",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        result = register_agent(moved)
        assert result.success is False
        assert "different endpoint" in (result.error or "")

        # Original record is untouched.
        retrieved = get_agent("markets-analyst")
        assert retrieved is not None
        assert retrieved.endpoint == original.endpoint
        assert get_agent_by_token("tok-original") is not None
        assert get_agent_by_token("tok-2") is None

    def test_re_registration_with_different_endpoint_succeeds_with_flag(self):
        now = int(time.time() * 1000)
        original = RegisteredAgent(
            agent_id="markets-analyst",
            endpoint="https://fleet.test.example.com/agents/markets-analyst/_spellguard/receive",
            agent_card_url="https://fleet.test.example.com/agents/markets-analyst/.well-known/agent.json",
            code_hash="sha256:abc",
            channel_token="tok-original",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        register_agent(original)

        new_endpoint = (
            "https://fleet.demo.example.com/agents/markets-analyst/_spellguard/receive"
        )
        moved = RegisteredAgent(
            agent_id="markets-analyst",
            endpoint=new_endpoint,
            agent_card_url=(
                "https://fleet.demo.example.com/agents/markets-analyst/.well-known/agent.json"
            ),
            code_hash="sha256:abc",
            channel_token="tok-2",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        result = register_agent(moved, allow_endpoint_update=True)
        assert result.success is True

        retrieved = get_agent("markets-analyst")
        assert retrieved is not None
        assert retrieved.endpoint == new_endpoint
        # New token works, old one is invalidated.
        assert get_agent_by_token("tok-2") is not None
        assert get_agent_by_token("tok-original") is None

    def test_clear_registry(self):
        now = int(time.time() * 1000)
        agent = RegisteredAgent(
            agent_id="clear-test",
            endpoint="http://localhost",
            agent_card_url="http://localhost/agent.json",
            code_hash="h",
            channel_token="t",
            registered_at=now,
            expires_at=now + 3600_000,
        )
        register_agent(agent)
        assert is_agent_registered("clear-test") is True

        clear_registry()
        assert is_agent_registered("clear-test") is False

    def test_expired_agent_is_removed_on_get(self):
        past = int(time.time() * 1000) - 1000
        agent = RegisteredAgent(
            agent_id="expired-agent",
            endpoint="http://localhost",
            agent_card_url="http://localhost/agent.json",
            code_hash="h",
            channel_token="t",
            registered_at=past - 3600_000,
            expires_at=past,
        )
        register_agent(agent)
        # get_agent should return None for expired agents
        assert get_agent("expired-agent") is None


# =====================================================================
# Type Constructors
# =====================================================================


class TestPythonCtlsTypes:
    def test_verifier_attestation_document(self):
        doc = VerifierAttestationDocument(
            image_hash="sha384:abc",
            hardware_signature="sig123",
            public_key="pubkey",
            timestamp=1234567890,
            nonce="nonce-abc",
        )
        assert doc.image_hash == "sha384:abc"
        assert doc.supported_algorithms is None

    def test_evidence_and_claims(self):
        claims = EvidenceClaims(
            code_hash="hash",
            endpoint="http://localhost",
            agent_card_url="http://localhost/agent.json",
            capabilities=["receive"],
        )
        evidence = Evidence(agent_id="test", claims=claims, signature="sig")
        assert evidence.agent_id == "test"
        assert evidence.claims.code_hash == "hash"

    def test_attestation_result(self):
        result = AttestationResult(
            agent_id="agent-a",
            verified=True,
            channel_token="token",
            session_public_key="pub",
            expires_at=9999999999,
        )
        assert result.verified is True
        assert result.rotation_policy is None

    def test_rotation_policy(self):
        policy = RotationPolicy(
            max_age=3600000,
            refresh_endpoint="/refresh",
        )
        assert policy.max_age == 3600000

    def test_session_keys(self):
        sk = SessionKeys(
            public_key="pub",
            private_key="priv",
            x25519_public_key="x_pub",
            x25519_private_key="x_priv",
            created_at=1234567890,
        )
        assert sk.public_key == "pub"
        assert sk.x25519_public_key == "x_pub"
