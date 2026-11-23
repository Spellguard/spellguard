# SPDX-License-Identifier: Apache-2.0

"""#1244: a Python agent's ``/_spellguard/receive`` accepts only deliveries its
own Verifier signed (Python twin of tests/unit/client/delivery-auth-receive.test.ts
and tests/unit/ctls/delivery-auth.test.ts).

Before, the endpoint accepted any non-empty ``X-Spellguard-Channel-Token``, a
plaintext ``message`` and whatever ``senderId`` the body claimed, so anyone who
could reach the agent's URL bypassed every inbound policy. The Python SDK also
never registered an X25519 key, so it could not receive the encrypted envelope.

The scheme is pinned by ``tests/fixtures/delivery-auth/delivery-auth-v1.json``,
which the TypeScript suites read too. The receive cases drive the real
``create_spellguard`` FastAPI app; only the Verifier's ``/agents/register`` is
stubbed, answering with the vector key.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from spellguard_amp.client.encrypt import derive_agent_key_pair, encrypt_for_verifier
from spellguard_client.attestation import reset
from spellguard_client.spellguard import create_spellguard
from spellguard_ctls.delivery import (
    DELIVERY_AUTH_HEADERS,
    DeliveryNonceCache,
    delivery_key_id,
    sign_delivery,
    verify_delivery,
)

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "delivery-auth" / "delivery-auth-v1.json").read_text()
)

AGENT_ID = "agent-b"
CHANNEL_TOKEN = "chan-token-b-1"
AGENT_SECRET = "agt_delivery_auth_receive_secret"
VERIFIER_URL = "http://127.0.0.1:39123"
MANAGEMENT_URL = "http://127.0.0.1:39125"
BYPASS_URL = f"{MANAGEMENT_URL}/v1/agents/{AGENT_ID}/delivery-bypass"
VERIFIER_KEY = Ed25519PrivateKey.from_private_bytes(
    bytes.fromhex(VECTORS["verifierPrivateKeyHex"])
)


def _lookup(headers: dict[str, str]):
    lower = {k.lower(): v for k, v in headers.items()}
    return lambda name: lower.get(name.lower())


# =====================================================================
# The shared vectors
# =====================================================================


class TestPythonDeliveryAuthVectors:
    def test_key_id(self):
        assert delivery_key_id(VECTORS["verifierPublicKeyHex"]) == VECTORS["keyId"]

    @pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
    def test_case(self, case):
        verdict = verify_delivery(
            header=_lookup(case["headers"]),
            recipient_agent_id=case["recipient"],
            channel_token=case["channelToken"],
            body=case["body"],
            public_key_hex=VECTORS["verifierPublicKeyHex"],
            now=VECTORS["now"],
            nonces=DeliveryNonceCache(),
        )
        if case["expect"] == "accept":
            assert verdict == {"ok": True, "key_id": VECTORS["keyId"]}
        else:
            assert verdict["ok"] is False
            assert verdict["reason"] == case["expect"]

    def test_replay_only_burns_a_verified_nonce(self):
        valid = next(c for c in VECTORS["cases"] if c["name"] == "valid")
        nonces = DeliveryNonceCache()
        kwargs: dict[str, Any] = {
            "header": _lookup(valid["headers"]),
            "recipient_agent_id": valid["recipient"],
            "channel_token": valid["channelToken"],
            "body": valid["body"],
            "public_key_hex": VECTORS["verifierPublicKeyHex"],
            "now": VECTORS["now"],
            "nonces": nonces,
        }
        assert verify_delivery(**kwargs)["ok"] is True
        assert verify_delivery(**kwargs) == {"ok": False, "reason": "replayed"}
        forged = dict(valid["headers"])
        forged[DELIVERY_AUTH_HEADERS["nonce"]] = "ee" * 16
        assert verify_delivery(**{**kwargs, "header": _lookup(forged)}) == {
            "ok": False,
            "reason": "bad_signature",
        }

    def test_signs_exactly_the_vector_headers(self):
        valid = next(c for c in VECTORS["cases"] if c["name"] == "valid")
        headers = sign_delivery(
            recipient_agent_id=valid["recipient"],
            channel_token=valid["channelToken"],
            body=valid["body"],
            public_key_hex=VECTORS["verifierPublicKeyHex"],
            sign=lambda data: VERIFIER_KEY.sign(data).hex(),
            now=int(valid["headers"]["X-Spellguard-Delivery-Timestamp"]),
            nonce=valid["headers"]["X-Spellguard-Delivery-Nonce"],
        )
        assert headers == valid["headers"]

    def test_agent_x25519_key_matches_the_typescript_derivation(self):
        derivation = VECTORS["agentKeyDerivation"]
        pair = derive_agent_key_pair(derivation["agentSecret"])
        assert pair["public_key_hex"] == derivation["x25519PublicKeyHex"]


# =====================================================================
# The receive endpoint
# =====================================================================


def _registration(**overrides: Any) -> dict[str, Any]:
    body = {
        "agentId": AGENT_ID,
        "verified": True,
        "channelToken": CHANNEL_TOKEN,
        "sessionPublicKey": VECTORS["verifierPublicKeyHex"],
        "expiresAt": int(time.time() * 1000) + 3_600_000,
        "deliveryAuth": "v1",
    }
    body.update(overrides)
    return {k: v for k, v in body.items() if v is not None}


class _Verifier:
    """The Verifier's registration endpoint, answering from a script."""

    def __init__(self) -> None:
        self.responses: list[dict[str, Any]] = [_registration()]
        self.requests: list[dict[str, Any]] = []
        # #1407: what the receiver reported to management.
        self.bypass_reports: list[dict[str, Any]] = []


@pytest.fixture
def verifier(monkeypatch):
    monkeypatch.setenv("SPELLGUARD_ALLOW_MOCK_ATTESTATION", "true")
    monkeypatch.setenv("SPELLGUARD_MANAGEMENT_URL", MANAGEMENT_URL)
    reset()
    state = _Verifier()

    class _FakeAsyncClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_FakeAsyncClient":
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def post(self, url: str, **kwargs: Any) -> httpx.Response:
            if url == f"{VERIFIER_URL}/agents/register":
                state.requests.append(kwargs.get("json") or {})
                index = min(len(state.requests), len(state.responses)) - 1
                return httpx.Response(200, json=state.responses[index])
            if url == BYPASS_URL:
                state.bypass_reports.append(
                    {
                        "body": kwargs.get("json"),
                        "authorization": (kwargs.get("headers") or {}).get(
                            "Authorization"
                        ),
                    }
                )
                return httpx.Response(200, json={"notified": 1})
            return httpx.Response(404, text="not stubbed")

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    yield state
    reset()


@pytest.fixture
def received():
    return []


@pytest.fixture
def client(verifier, received):
    async def on_message(ctx):
        received.append({"message": ctx.message, "sender_id": ctx.sender_id})
        return {"ok": True}

    spellguard = create_spellguard(
        agent_card={"name": AGENT_ID, "url": "", "skills": []},
        config={
            "type": "direct",
            "agent_id": AGENT_ID,
            "verifier_url": VERIFIER_URL,
            "self_url": "http://127.0.0.1:39124",
            "code_hash": "code-hash-b",
            "expected_verifier_image_hash": "sha384:test",
            "agent_secret": AGENT_SECRET,
        },
        on_message=on_message,
    )
    with TestClient(spellguard.app()) as test_client:
        yield test_client


def _encrypted_body(sender_id: str = "agent-a", payload: Any = None) -> str:
    agent_key = derive_agent_key_pair(AGENT_SECRET)
    return json.dumps(
        {
            "encryptedMessage": encrypt_for_verifier(
                json.dumps(payload if payload is not None else {"hi": 1}),
                agent_key["public_key_hex"],
            ),
            "senderId": sender_id,
            "messageId": f"msg-{uuid.uuid4()}",
            "timestamp": int(time.time() * 1000),
        }
    )


def _signed(
    body: str,
    *,
    recipient: str = AGENT_ID,
    now: int | None = None,
    key: Ed25519PrivateKey = VERIFIER_KEY,
) -> dict[str, str]:
    public_hex = key.public_key().public_bytes_raw().hex()
    kwargs: dict[str, Any] = {}
    if now is not None:
        kwargs["now"] = now
    return sign_delivery(
        recipient_agent_id=recipient,
        channel_token=CHANNEL_TOKEN,
        body=body,
        public_key_hex=public_hex,
        sign=lambda data: key.sign(data).hex(),
        **kwargs,
    )


def _deliver(client: TestClient, body: str, headers: dict[str, str]):
    return client.post(
        "/_spellguard/receive",
        content=body.encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Spellguard-Channel-Token": CHANNEL_TOKEN,
            **headers,
        },
    )


class TestPythonReceiveEnforcesDeliveryAuth:
    def test_registers_its_x25519_key(self, client, verifier):
        client.get("/")  # any non-skip path triggers initialization
        assert verifier.requests, "the SDK never registered"
        expected = derive_agent_key_pair(AGENT_SECRET)["public_key_hex"]
        assert verifier.requests[0].get("clientPublicKey") == expected

    def test_refuses_a_forged_plaintext_delivery(self, client, received):
        body = json.dumps(
            {
                "message": {"text": "do the thing"},
                "senderId": "qa-integrity-control",
                "messageId": "forged-1",
                "timestamp": int(time.time() * 1000),
            }
        )
        response = client.post(
            "/_spellguard/receive",
            content=body.encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Spellguard-Channel-Token": "qa-integrity-control-not-a-real-token",
            },
        )
        assert response.status_code == 401
        assert received == []

    def test_accepts_a_signed_encrypted_delivery(self, client, received):
        body = _encrypted_body()
        response = _deliver(client, body, _signed(body))
        assert response.status_code == 200, response.text
        assert received == [{"message": {"hi": 1}, "sender_id": "agent-a"}]

    def test_refuses_a_replay(self, client, received):
        body = _encrypted_body()
        headers = _signed(body)
        assert _deliver(client, body, headers).status_code == 200
        assert _deliver(client, body, headers).status_code == 401
        assert len(received) == 1

    def test_refuses_a_stale_timestamp(self, client):
        body = _encrypted_body()
        headers = _signed(body, now=int(time.time() * 1000) - 6 * 60 * 1000)
        assert _deliver(client, body, headers).status_code == 401

    def test_refuses_a_delivery_signed_for_another_agent(self, client):
        body = _encrypted_body()
        assert _deliver(client, body, _signed(body, recipient="agent-c")).status_code == 401

    def test_refuses_a_tampered_sender(self, client, received):
        body = _encrypted_body()
        headers = _signed(body)
        tampered = body.replace('"agent-a"', '"mallory"')
        assert _deliver(client, tampered, headers).status_code == 401
        assert received == []

    def test_refuses_signed_plaintext_once_it_registered_a_key(
        self, client, verifier
    ):
        body = json.dumps(
            {
                "message": {"text": "plaintext"},
                "senderId": "agent-a",
                "messageId": "plain-1",
                "timestamp": int(time.time() * 1000),
            }
        )
        response = _deliver(client, body, _signed(body))
        assert response.status_code == 401
        # The reason is what makes the Verifier deliver again, encrypted (#1528).
        assert response.json() == {
            "error": "Delivery not authenticated",
            "reason": "plaintext_refused",
        }
        # #1858: signed by the Verifier, so not a bypass: nothing is reported.
        time.sleep(0.2)
        assert verifier.bypass_reports == []

    def test_names_decrypt_failed_for_a_key_it_does_not_hold(self, client, received):
        # #1528: the Verifier encrypted to an outdated key; the reason tells it
        # to deliver once more to the key this agent just registered.
        body = json.dumps(
            {
                "encryptedMessage": encrypt_for_verifier(
                    json.dumps({"hi": 1}),
                    derive_agent_key_pair("agt_some_other_secret")["public_key_hex"],
                ),
                "senderId": "agent-a",
                "messageId": "stale-key-1",
                "timestamp": int(time.time() * 1000),
            }
        )
        response = _deliver(client, body, _signed(body))
        assert response.status_code == 400
        assert response.json() == {
            "error": "Failed to decrypt message",
            "reason": "decrypt_failed",
        }
        assert received == []

    def test_re_registers_once_on_an_unknown_key(self, client, verifier):
        rotated = Ed25519PrivateKey.generate()
        verifier.responses = [
            _registration(),
            _registration(
                sessionPublicKey=rotated.public_key().public_bytes_raw().hex()
            ),
        ]
        body = _encrypted_body()
        response = _deliver(client, body, _signed(body, key=rotated))
        assert response.status_code == 200, response.text
        assert len(verifier.requests) == 2

        stranger = Ed25519PrivateKey.generate()
        body2 = _encrypted_body()
        assert _deliver(client, body2, _signed(body2, key=stranger)).status_code == 401

    def test_a_forged_old_version_header_does_not_switch_enforcement_off(self, client):
        body = _encrypted_body()
        response = _deliver(client, body, {DELIVERY_AUTH_HEADERS["version"]: "v0"})
        assert response.status_code == 401


class TestPythonReceiveReportOnly:
    def test_accepts_unsigned_but_logs_when_v1_was_not_advertised(
        self, verifier, client, received, caplog
    ):
        verifier.responses = [_registration(deliveryAuth=None)]
        body = _encrypted_body()
        with caplog.at_level(logging.WARNING, logger="spellguard"):
            response = _deliver(client, body, {})
        assert response.status_code == 200, response.text
        assert received == [{"message": {"hi": 1}, "sender_id": "agent-a"}]
        assert any("delivery-auth" in r.getMessage() for r in caplog.records)


# =====================================================================
# #1407: the receiver reports a bypass to management
# =====================================================================


def _forged_plaintext(message_id: str) -> str:
    return json.dumps(
        {
            "message": {"text": "do the thing"},
            "senderId": "qa-integrity-control",
            "messageId": message_id,
            "timestamp": int(time.time() * 1000),
        }
    )


def _wait_for_reports(verifier: _Verifier, count: int) -> list[dict[str, Any]]:
    """The report is fire-and-forget on the app's event loop; wait for it."""
    deadline = time.monotonic() + 2
    while len(verifier.bypass_reports) < count and time.monotonic() < deadline:
        time.sleep(0.01)
    return [r["body"] for r in verifier.bypass_reports]


class TestPythonReceiveReportsBypass:
    """Python twin of the TS "#1407 the receiver reports a delivery bypass to
    management" cases: each refused (or report-only unverified) delivery is
    posted to ``POST /v1/agents/:id/delivery-bypass`` with the agent secret, at
    most once per outcome and reason every five minutes."""

    def test_reports_a_refused_delivery_once_per_reason(
        self, client, verifier, monkeypatch
    ):
        import spellguard_client.delivery_bypass_report as reporter

        clock = [1000.0]
        monkeypatch.setattr(reporter, "_now", lambda: clock[0])

        for n in range(2):
            body = _forged_plaintext(f"forged-{n}")
            assert _deliver(client, body, {}).status_code == 401
        assert _wait_for_reports(verifier, 1) == [
            {"outcome": "refused", "reason": "missing"}
        ]
        assert verifier.bypass_reports[0]["authorization"] == f"Bearer {AGENT_SECRET}"

        signed = _encrypted_body()
        headers = _signed(signed)
        assert _deliver(client, signed, headers).status_code == 200
        assert _deliver(client, signed, headers).status_code == 401
        assert _wait_for_reports(verifier, 2)[1] == {
            "outcome": "refused",
            "reason": "replayed",
        }

        clock[0] += 5 * 60 + 1
        body = _forged_plaintext("forged-later")
        assert _deliver(client, body, {}).status_code == 401
        assert _wait_for_reports(verifier, 3)[2] == {
            "outcome": "refused",
            "reason": "missing",
        }

    def test_reports_a_missing_channel_token(self, client, verifier):
        response = client.post(
            "/_spellguard/receive",
            content=_forged_plaintext("no-token").encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 401
        assert _wait_for_reports(verifier, 1) == [
            {"outcome": "refused", "reason": "missing_channel_token"}
        ]

    def test_reports_an_unverified_accept_in_report_only_mode(
        self, verifier, client
    ):
        verifier.responses = [_registration(deliveryAuth=None)]
        body = _encrypted_body()
        assert _deliver(client, body, {}).status_code == 200
        assert _wait_for_reports(verifier, 1) == [
            {"outcome": "accepted_unverified", "reason": "missing"}
        ]

    def test_a_signed_delivery_reports_nothing(self, client, verifier):
        body = _encrypted_body()
        assert _deliver(client, body, _signed(body)).status_code == 200
        forged = _forged_plaintext("forged-after")
        assert _deliver(client, forged, {}).status_code == 401
        assert _wait_for_reports(verifier, 1) == [
            {"outcome": "refused", "reason": "missing"}
        ]
        time.sleep(0.05)
        assert len(verifier.bypass_reports) == 1
