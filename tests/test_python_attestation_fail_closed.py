# SPDX-License-Identifier: Apache-2.0

"""Attestation fails closed when server configuration is absent (Python twin of
tests/security/attestation-fail-closed.test.ts).

Regression suite for product-findings S1 (silent attestation bypass). At the pin,
three defects chained into "no attestation at all, logged as success":

  1. ``discover_and_configure()`` substituted ``sha384:dev-placeholder`` whenever
     the management discovery response carried no ``verifierImageHash``.
  2. ``_create_channel()`` derived mock mode from that value -- including a
     ``startswith("sha384:dev")`` prefix match that widened the trigger.
  3. ``verify_verifier_attestation()`` returned ``{"verified": True}`` in mock
     mode without checking the image hash, the timestamp, or the signature.

The trigger was ABSENT SERVER CONFIGURATION, not a developer opt-in.

Post-fix posture (decision D1): no placeholder is ever substituted, mock mode is
never inferred from the image hash, the ``SPELLGUARD_ALLOW_MOCK_ATTESTATION``
flag is refused against a production configuration, and an absent hash fails
closed with the ``verifier_image_hash_unconfigured`` reason code.
"""

from __future__ import annotations

import httpx
import pytest

from spellguard_client.attestation import (
    configure,
    discover_and_configure,
    get_config,
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
    fetch_and_verify_verifier,
    verify_verifier_attestation,
)
from spellguard_ctls.types import VerifierAttestationDocument

MOCK_FLAG = "SPELLGUARD_ALLOW_MOCK_ATTESTATION"

# A real (non-placeholder) image hash, as staging/production would record.
REAL_HASH = "sha384:" + ("a1b2c3d4" * 12)

AGENT_CARD = AgentCard(name="agent-fail-closed", url="http://localhost:9999", skills=[])


def _doc(**overrides) -> VerifierAttestationDocument:
    fields = {
        "image_hash": REAL_HASH,
        "hardware_signature": "f" * 128,
        "public_key": "a" * 64,
        "timestamp": 0,
        "nonce": "nonce-1",
    }
    fields.update(overrides)
    return VerifierAttestationDocument(**fields)


def _config(**overrides) -> SpellguardConfig:
    fields = {
        "agent_id": "agent-fail-closed",
        "verifier_url": "http://localhost:3000",
        "self_url": "http://localhost:9999",
        "code_hash": "sha256:test",
        "expected_verifier_image_hash": REAL_HASH,
        "agent_card": AGENT_CARD,
    }
    fields.update(overrides)
    return SpellguardConfig(**fields)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """Every test starts with the flag unset and no leftover client state."""
    monkeypatch.delenv(MOCK_FLAG, raising=False)
    reset()
    yield
    reset()


@pytest.fixture
def recorder(monkeypatch):
    """Record every URL the SDK actually reaches out to.

    ``/attestation`` returns a document whose image hash does NOT match, so a
    client performing real verification must reject. ``/agents/register``
    returns 500, so a client that SKIPS verification produces a distinctly
    different (registration) error. The two failure modes are therefore
    distinguishable, and the recorded list shows which legs actually ran.
    """
    requested: list[str] = []

    async def _fake_attestation_fetch(url: str) -> httpx.Response:
        requested.append(url)
        nonce = url.split("nonce=", 1)[1]
        return httpx.Response(
            200,
            json={
                "imageHash": "sha384:something-else",
                "hardwareSignature": "f" * 128,
                "publicKey": "a" * 64,
                "timestamp": 0,
                "nonce": nonce,
            },
        )

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> "_FakeAsyncClient":
            return self

        async def __aexit__(self, *args) -> bool:
            return False

        async def post(self, url: str, **kwargs) -> httpx.Response:
            requested.append(url)
            return httpx.Response(500, text="registration unavailable in this test")

    monkeypatch.setattr(
        "spellguard_ctls.client.verifier_verify._fetch_attestation_with_retry",
        _fake_attestation_fetch,
    )
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    return requested


def _attestation_legs(requested: list[str]) -> list[str]:
    return [u for u in requested if "/attestation" in u]


# =====================================================================
# (a) Config absent -> verified False with an explicit reason code
# =====================================================================


class TestPythonAttestationAbsentConfig:
    async def test_verify_reports_unconfigured_reason(self):
        result = await verify_verifier_attestation(
            _doc(), VerifierVerifyOptions(expected_image_hash="")
        )
        assert result["verified"] is False
        assert result["reason"] == "verifier_image_hash_unconfigured"

    async def test_fetch_and_verify_refuses_before_fetching(self, recorder):
        result = await fetch_and_verify_verifier("http://localhost:3000", "", {})
        assert result.verified is False
        assert result.reason == "verifier_image_hash_unconfigured"
        # Fail closed BEFORE talking to an unverified Verifier.
        assert recorder == []

    async def test_discovery_without_image_hash_records_no_placeholder(
        self, monkeypatch
    ):
        class _DiscoveryClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args) -> bool:
                return False

            async def post(self, url: str, **kwargs) -> httpx.Response:
                if "/v1/discover" in url:
                    return httpx.Response(
                        200,
                        json={
                            # Deliberately no `verifierImageHash` -- the exact
                            # server-side gap that triggered the bypass.
                            "verifierUrl": "http://localhost:3000",
                            "verifierPublicKey": "a" * 64,
                            "verifierRegion": "local",
                            "verifierId": "verifier-1",
                            "managementToken": "token",
                            "refreshInterval": 300,
                            "issuedAt": 0,
                            "expiresAt": 0,
                            "signature": "sig",
                        },
                    )
                return httpx.Response(500, text="unavailable")

        monkeypatch.setattr(httpx, "AsyncClient", _DiscoveryClient)

        await discover_and_configure(
            SpellguardDiscoveryConfig(
                agent_id="agent-fail-closed",
                management_url="http://localhost:8787",
                self_url="http://localhost:9999",
                code_hash="sha256:test",
                agent_card=AGENT_CARD,
            )
        )

        # The placeholder substitution is gone: absent stays absent.
        cfg = get_config()
        assert cfg is not None
        assert cfg.expected_verifier_image_hash is None

    async def test_channel_refuses_with_reason_when_no_hash_configured(
        self, recorder
    ):
        configure(_config(expected_verifier_image_hash=None))

        with pytest.raises(RuntimeError, match="verifier_image_hash_unconfigured"):
            await get_or_create_channel()

        # Nothing was sent to the unverified Verifier -- not even registration.
        assert recorder == []


# =====================================================================
# (b) Mock mode activates ONLY when the D1 flag is set
# =====================================================================


class TestPythonMockModeRequiresFlag:
    async def test_placeholder_hash_does_not_enable_mock_mode(self, recorder):
        configure(_config(expected_verifier_image_hash="sha384:dev-placeholder"))

        with pytest.raises(RuntimeError, match="Verifier attestation failed"):
            await get_or_create_channel()

        # Real verification ran: the attestation document was actually fetched.
        assert len(_attestation_legs(recorder)) > 0

    async def test_dev_prefixed_hash_does_not_enable_mock_mode(self, recorder):
        configure(_config(expected_verifier_image_hash="sha384:dev-anything-goes"))

        with pytest.raises(RuntimeError, match="Verifier attestation failed"):
            await get_or_create_channel()

        assert len(_attestation_legs(recorder)) > 0

    async def test_flag_enables_mock_mode_against_local_config(
        self, monkeypatch, recorder
    ):
        monkeypatch.setenv(MOCK_FLAG, "true")
        # A REAL hash -- under the old code this would have verified strictly.
        configure(_config(expected_verifier_image_hash=REAL_HASH))

        # Mock mode skips attestation and proceeds to registration, which this
        # stub refuses -- so the error is a REGISTRATION error, not an
        # attestation error, and no attestation leg ran.
        with pytest.raises(RuntimeError, match="Failed to register with Verifier"):
            await get_or_create_channel()

        assert _attestation_legs(recorder) == []

    async def test_non_true_value_does_not_enable_mock_mode(
        self, monkeypatch, recorder
    ):
        monkeypatch.setenv(MOCK_FLAG, "1")
        configure(_config(expected_verifier_image_hash="sha384:dev-placeholder"))

        with pytest.raises(RuntimeError, match="Verifier attestation failed"):
            await get_or_create_channel()

        assert len(_attestation_legs(recorder)) > 0


# =====================================================================
# (c) The flag is REFUSED under a production configuration
# =====================================================================


class TestPythonMockModeRefusedInProduction:
    async def test_refuses_when_verifier_is_a_spellguard_host(
        self, monkeypatch, recorder
    ):
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(
            _config(
                verifier_url="https://verifier.spellguard.ai",
                expected_verifier_image_hash="sha384:dev-placeholder",
            )
        )

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()

        # Refused before any traffic left the process.
        assert recorder == []

    async def test_refuses_when_management_is_a_spellguard_host(
        self, monkeypatch, recorder
    ):
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(
            _config(
                verifier_url="http://localhost:3000",
                management_url="https://console.spellguard.ai",
                expected_verifier_image_hash="sha384:dev-placeholder",
            )
        )

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()

    async def test_refuses_against_an_unrecognized_host(self, monkeypatch, recorder):
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(_config(verifier_url="https://verifier.customer.example"))

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()

    async def test_permits_a_throwaway_dev_stack(self, monkeypatch, recorder):
        """spellguard-<service>-dev-<developer> is an ephemeral per-dev stack."""
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(
            _config(
                verifier_url=(
                    "https://spellguard-verifier-dev-alice.example-account.workers.dev"
                ),
                management_url=(
                    "https://spellguard-management-dev-cli-e2e"
                    ".example-account.workers.dev"
                ),
            )
        )

        with pytest.raises(RuntimeError, match="Failed to register with Verifier"):
            await get_or_create_channel()

        assert _attestation_legs(recorder) == []

    # -----------------------------------------------------------------
    # *.workers.dev is NOT a throwaway-only namespace. A deployed
    # environment can also answer on its account's workers.dev subdomain,
    # the same one the throwaway stacks use, so a blanket *.workers.dev
    # allow would hand the attestation bypass to a real environment.
    # -----------------------------------------------------------------
    async def test_refuses_deployed_production_worker(self, monkeypatch, recorder):
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(
            _config(
                verifier_url=(
                    "https://spellguard-management-live"
                    ".example-account.workers.dev"
                )
            )
        )

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()

        assert recorder == []

    @pytest.mark.parametrize(
        "worker",
        [
            "spellguard-management-preprod",
            "spellguard-management-sandbox",
            "spellguard-management-qa",
            "spellguard-management",
            "spellguard-verifier-internal-preprod",
        ],
    )
    async def test_refuses_other_deployed_workers(
        self, monkeypatch, recorder, worker
    ):
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(
            _config(verifier_url=f"https://{worker}.example-account.workers.dev")
        )

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()

    async def test_refuses_the_shared_dev_environment_worker(
        self, monkeypatch, recorder
    ):
        """The trap: the SHARED dev env is a real deployed environment.

        Its worker name (``...-management-dev``) is a strict prefix of every
        throwaway's (``...-management-dev-<developer>``), so the boundary has to
        be exact.
        """
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(
            _config(
                verifier_url=(
                    "https://spellguard-management-dev.example-account.workers.dev"
                )
            )
        )

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()

        assert recorder == []

    async def test_refuses_an_unrelated_workers_dev_host(
        self, monkeypatch, recorder
    ):
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(
            _config(verifier_url="https://someone-elses-worker.acme.workers.dev")
        )

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()

    async def test_refuses_a_dot_localhost_host(self, monkeypatch, recorder):
        """*.localhost is resolver-dependent, so it is not a trusted local stack."""
        monkeypatch.setenv(MOCK_FLAG, "true")
        configure(_config(verifier_url="https://verifier.localhost"))

        with pytest.raises(
            RuntimeError, match="mock_attestation_forbidden_in_production"
        ):
            await get_or_create_channel()
