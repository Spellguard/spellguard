# SPDX-License-Identifier: Apache-2.0

"""#1259 section 3: the Python SDK pins the session key management attested
(Python twin of tests/unit/client/verifier-key-pin.test.ts).

Discovery's ``verifierPublicKey`` (management's ``attested_session_key``) is
required; the Verifier's attestation document must carry exactly that key; and
the key the Verifier hands back at registration must be the one it was attested
with. A mismatch re-runs discovery once, then fails closed with
``verifier_key_mismatch``.
"""

from __future__ import annotations

import time
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spellguard_client.attestation import (
    configure,
    discover_and_configure,
    get_or_create_channel,
    reset,
)
from spellguard_client.types import (
    AgentCard,
    SpellguardConfig,
    SpellguardDiscoveryConfig,
)
from spellguard_ctls.client.verifier_verify import (
    VerifierVerifyOptions,
    verify_verifier_attestation,
)
from spellguard_ctls.types import VerifierAttestationDocument

IMAGE_HASH = "sha384:" + ("a1b2c3d4" * 12)
VERIFIER_URL = "http://127.0.0.1:39300"
MANAGEMENT_URL = "http://127.0.0.1:39301"
AGENT_CARD = AgentCard(name="agent-key-pin-py", url="http://127.0.0.1:39302", skills=[])


def _key() -> tuple[Ed25519PrivateKey, str]:
    private = Ed25519PrivateKey.generate()
    return private, private.public_key().public_bytes_raw().hex()


def _internal_doc(private: Ed25519PrivateKey, nonce: str) -> dict[str, Any]:
    public = private.public_key().public_bytes_raw().hex()
    timestamp = int(time.time() * 1000)
    signed = "|".join([IMAGE_HASH, public, str(timestamp), nonce]).encode()
    return {
        "imageHash": IMAGE_HASH,
        "publicKey": public,
        "timestamp": timestamp,
        "nonce": nonce,
        "attestationType": "internal",
        "hardwareSignature": private.sign(signed).hex(),
    }


def _doc_object(data: dict[str, Any]) -> VerifierAttestationDocument:
    return VerifierAttestationDocument(
        image_hash=data["imageHash"],
        hardware_signature=data["hardwareSignature"],
        public_key=data["publicKey"],
        timestamp=data["timestamp"],
        nonce=data["nonce"],
        attestation_type=data["attestationType"],
    )


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("SPELLGUARD_ALLOW_MOCK_ATTESTATION", raising=False)
    reset()
    yield
    reset()


class _Network:
    def __init__(
        self,
        discovered_keys: list[str | None],
        endpoint_key: Ed25519PrivateKey,
        registered_key: str | None = None,
    ) -> None:
        self.discovered_keys = discovered_keys
        self.endpoint_key = endpoint_key
        self.registered_key = registered_key
        self.requested: list[str] = []
        self.discoveries = 0


@pytest.fixture
def network(monkeypatch):
    holder: dict[str, _Network] = {}

    class _FakeAsyncClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_FakeAsyncClient":
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def get(self, url: str, **kwargs: Any) -> httpx.Response:
            net = holder["net"]
            parsed = httpx.URL(url)
            net.requested.append(parsed.path)
            if parsed.path == "/attestation":
                nonce = parsed.params.get("nonce", "")
                return httpx.Response(200, json=_internal_doc(net.endpoint_key, nonce))
            return httpx.Response(404, text="not stubbed")

        async def post(self, url: str, **kwargs: Any) -> httpx.Response:
            net = holder["net"]
            path = httpx.URL(url).path
            net.requested.append(path)
            if path == "/v1/discover":
                key = net.discovered_keys[
                    min(net.discoveries, len(net.discovered_keys) - 1)
                ]
                net.discoveries += 1
                body: dict[str, Any] = {
                    "verifierUrl": VERIFIER_URL,
                    "verifierRegion": "us",
                    "verifierId": "verifier-i1259",
                    "verifierImageHash": IMAGE_HASH,
                    "managementToken": "mgmt-token",
                    "refreshInterval": 300,
                    "issuedAt": int(time.time()),
                    "expiresAt": int(time.time()) + 300,
                    "signature": "sig",
                }
                if key:
                    body["verifierPublicKey"] = key
                return httpx.Response(200, json=body)
            if path == "/agents/register":
                endpoint_public = (
                    net.endpoint_key.public_key().public_bytes_raw().hex()
                )
                return httpx.Response(
                    200,
                    json={
                        "agentId": "agent-key-pin-py",
                        "verified": True,
                        "channelToken": "chan-key-pin-py",
                        "sessionPublicKey": net.registered_key or endpoint_public,
                        "expiresAt": int(time.time() * 1000) + 3_600_000,
                    },
                )
            return httpx.Response(404, text="not stubbed")

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    def install(net: _Network) -> _Network:
        holder["net"] = net
        return net

    return install


def _discovery_config() -> SpellguardDiscoveryConfig:
    return SpellguardDiscoveryConfig(
        agent_id="agent-key-pin-py",
        management_url=MANAGEMENT_URL,
        self_url="http://127.0.0.1:39302",
        code_hash="sha256:test",
        agent_secret="agt_key_pin_py_secret",
        agent_card=AGENT_CARD,
    )


class TestPythonVerifierKeyPinCtls:
    async def test_refuses_a_document_for_another_key(self):
        _, attested = _key()
        rogue, _ = _key()
        result = await verify_verifier_attestation(
            _doc_object(_internal_doc(rogue, "n-1")),
            VerifierVerifyOptions(
                expected_image_hash=IMAGE_HASH, expected_public_key=attested
            ),
        )
        assert result["verified"] is False
        assert result["reason"] == "verifier_key_mismatch"

    async def test_accepts_the_document_for_the_pinned_key(self):
        private, public = _key()
        result = await verify_verifier_attestation(
            _doc_object(_internal_doc(private, "n-2")),
            VerifierVerifyOptions(
                expected_image_hash=IMAGE_HASH, expected_public_key=public
            ),
        )
        assert result["verified"] is True


class TestPythonVerifierKeyPinSdk:
    async def test_discovery_without_a_key_fails_closed(self, network):
        rogue, _ = _key()
        net = network(_Network([None], rogue))
        with pytest.raises(RuntimeError, match="verifierPublicKey"):
            await discover_and_configure(_discovery_config())
        assert "/attestation" not in net.requested
        assert "/agents/register" not in net.requested

    async def test_refuses_an_endpoint_whose_key_is_not_the_attested_one(
        self, network
    ):
        _, attested = _key()
        rogue, _ = _key()
        net = network(_Network([attested], rogue))
        await discover_and_configure(_discovery_config())
        with pytest.raises(RuntimeError, match="verifier_key_mismatch"):
            await get_or_create_channel()
        assert "/agents/register" not in net.requested
        assert net.discoveries <= 2

    async def test_follows_a_rotation_that_discovery_confirms(self, network):
        _, before = _key()
        after_private, after = _key()
        net = network(_Network([before, after], after_private))
        await discover_and_configure(_discovery_config())
        channel = await get_or_create_channel()
        assert channel is not None
        assert net.discoveries == 2
        assert "/agents/register" in net.requested

    async def test_refuses_a_registration_that_returns_another_key(self, network):
        private, attested = _key()
        _, other = _key()
        network(_Network([attested], private, registered_key=other))
        configure(
            SpellguardConfig(
                agent_id="agent-key-pin-py",
                verifier_url=VERIFIER_URL,
                self_url="http://127.0.0.1:39302",
                code_hash="sha256:test",
                expected_verifier_image_hash=IMAGE_HASH,
                expected_verifier_public_key=attested,
                agent_card=AGENT_CARD,
            )
        )
        with pytest.raises(RuntimeError, match="verifier_key_mismatch"):
            await get_or_create_channel()
