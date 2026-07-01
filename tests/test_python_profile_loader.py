# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the Python ``spellguard_amp.profile`` module.

Mirrors ``tests/profile-loader.test.ts`` plus the real-crypto tests in
``tests/slim-dir-identity.test.ts``. No mocks — AgntcyIdentity runs real
Ed25519 round-trips; DirDirectory and SlimTransport tests verify both the
no-network unit behaviour and the structured failure when their backing
services aren't running.
"""

from __future__ import annotations

import asyncio
import warnings

import pytest

from spellguard_amp.profile import (
    AgentAddress,
    _AgntcyIdentity,
    _DirDirectory,
    _SlimTransport,
    create_agntcy_profile,
    create_original_profile,
    load_profile,
)


# ---------- Loader tests (mirror TS) ----------


def test_default_profile_is_original():
    bundle = load_profile({})
    assert bundle.profile == "original"
    assert bundle.transport.name == "http"
    assert bundle.directory.name == "a2a-wellknown"
    assert bundle.identity.name == "ctls"


def test_agntcy_profile_via_env():
    bundle = load_profile({"SPELLGUARD_PROFILE": "agntcy"})
    assert bundle.profile == "agntcy"
    assert bundle.transport.name == "gateway"
    assert bundle.directory.name == "agntcy-dir"
    assert bundle.identity.name == "agntcy-vc"


def test_case_insensitive_profile_name():
    assert load_profile({"SPELLGUARD_PROFILE": "AGNTCY"}).profile == "agntcy"
    assert load_profile({"SPELLGUARD_PROFILE": "Original"}).profile == "original"


def test_unknown_profile_falls_back_to_original_with_warning():
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        bundle = load_profile({"SPELLGUARD_PROFILE": "pretend-profile"})
        assert bundle.profile == "original"
        assert any("pretend-profile" in str(w.message) for w in caught)


def test_original_bundle_factory_is_stable():
    bundle = create_original_profile()
    assert bundle.profile == "original"
    assert bundle.transport.name == "http"


def test_agntcy_bundle_honors_env_supplied_urls():
    bundle = create_agntcy_profile(
        {
            "SPELLGUARD_SLIM_GATEWAY_URL": "ws://sidecar.example:1234",
            "SPELLGUARD_DIR_URL": "http://dir.example:9000",
            "SPELLGUARD_IDENTITY_ISSUER_URL": "http://identity.example:9001",
        }
    )
    assert bundle.profile == "agntcy"
    assert bundle.transport.sidecar_url == "ws://sidecar.example:1234"


# ---------- AgntcyIdentity: real Ed25519 round-trips ----------


@pytest.mark.asyncio
async def test_identity_issue_and_verify_round_trip():
    identity = _AgntcyIdentity("http://issuer.test")
    issued = await identity.issue_credential(
        "agent-a", "evidence-blob", ttl_seconds=3600
    )
    assert issued["credential"].count(".") == 2  # JWT three-segment shape
    assert issued["expires_at"] > 0

    claims = await identity.verify_credential(issued["credential"])
    assert claims is not None
    assert claims["agent_id"] == "agent-a"
    assert claims["code_attested"] is True
    assert isinstance(claims["claims"]["attestation_hash"], str)
    assert claims["claims"]["iss"] == "http://issuer.test"


@pytest.mark.asyncio
async def test_identity_rejects_tampered_signature():
    identity = _AgntcyIdentity("http://issuer.test")
    a = await identity.issue_credential("agent-a", "ev")
    b = await identity.issue_credential("agent-b", "ev")
    # Swap agent-b's payload into agent-a's signed envelope — sig won't match.
    a_header, _, a_sig = a["credential"].split(".")
    _, b_payload, _ = b["credential"].split(".")
    tampered = f"{a_header}.{b_payload}.{a_sig}"
    assert await identity.verify_credential(tampered) is None


@pytest.mark.asyncio
async def test_identity_rejects_expired_credentials():
    identity = _AgntcyIdentity("http://issuer.test")
    issued = await identity.issue_credential("agent-a", "", ttl_seconds=1)
    # exp validation is at second granularity; sleep past two whole seconds
    # so the int(time.time()) >= exp comparison fires consistently.
    await asyncio.sleep(2.1)
    assert await identity.verify_credential(issued["credential"]) is None


@pytest.mark.asyncio
async def test_identity_rejects_wrong_issuer():
    a = _AgntcyIdentity("http://issuer-a.test")
    b = _AgntcyIdentity("http://issuer-b.test")
    issued = await a.issue_credential("agent-a", "")
    # b's key + b's expected iss claim both differ from a — verify fails.
    assert await b.verify_credential(issued["credential"]) is None


@pytest.mark.asyncio
async def test_identity_rejects_malformed():
    identity = _AgntcyIdentity("http://issuer.test")
    assert await identity.verify_credential("garbage") is None
    assert await identity.verify_credential("a.b.c") is None


@pytest.mark.asyncio
async def test_identity_flags_missing_attestation():
    identity = _AgntcyIdentity("http://issuer.test")
    issued = await identity.issue_credential("agent-a", "")
    claims = await identity.verify_credential(issued["credential"])
    assert claims is not None
    assert claims["code_attested"] is False


def test_identity_exposes_public_jwk():
    identity = _AgntcyIdentity("http://issuer.test")
    jwk = identity.public_jwk()
    assert jwk["kty"] == "OKP"
    assert jwk["crv"] == "Ed25519"
    assert jwk["alg"] == "EdDSA"
    assert isinstance(jwk["x"], str)


# ---------- DirDirectory: URL pass-through + unreachable failure ----------


@pytest.mark.asyncio
async def test_dir_passes_through_full_urls_without_network():
    dir_dir = _DirDirectory("http://does-not-exist.invalid")
    resolved = await dir_dir.resolve("https://agent.example.com")
    assert resolved is not None
    assert resolved.url == "https://agent.example.com"


@pytest.mark.asyncio
async def test_dir_resolve_raises_when_unreachable():
    dir_dir = _DirDirectory("http://127.0.0.1:1")  # nothing listening
    with pytest.raises(Exception):
        await dir_dir.resolve("some-agent")


# ---------- SlimTransport: bind + connection-failure surface ----------


@pytest.mark.asyncio
async def test_slim_transport_demands_bind_agent_before_send():
    transport = _SlimTransport("ws://127.0.0.1:1")
    # No bind_agent → ensure_connected raises before touching the socket.
    with pytest.raises(RuntimeError, match="bind_agent"):
        await transport.send(
            AgentAddress(agent_id="x"),
            {
                "id": "1",
                "sender": "s",
                "recipient": "r",
                "encryptedPayload": "",
                "timestamp": 0,
            },
        )


@pytest.mark.asyncio
async def test_slim_transport_surfaces_connection_failure():
    transport = _SlimTransport("ws://127.0.0.1:1")
    transport.bind_agent("smoke", "org/smoke")
    with pytest.raises(Exception):
        await transport.send(
            AgentAddress(agent_id="other", slim_name="org/other"),
            {
                "id": "1",
                "sender": "smoke",
                "recipient": "other",
                "encryptedPayload": "",
                "timestamp": 0,
            },
        )
