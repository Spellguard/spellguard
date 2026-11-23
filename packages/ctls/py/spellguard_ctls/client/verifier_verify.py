# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Verifier Verification

Client-side verification of Verifier attestation documents.
This enables bidirectional attestation - clients verify Verifier, not just Verifier verifying clients.

Verification fails CLOSED. ``mock_mode`` is the one bypass, and it is never
inferred here -- the caller must decide, and the SDK only ever sets it from an
explicit ``SPELLGUARD_ALLOW_MOCK_ATTESTATION=true`` opt-in that is refused
against a production configuration (see ``spellguard_client.attestation``'s
``resolve_mock_attestation_mode``).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlparse

import httpx

from ..crypto.signing import verify
from ..types import VerifierAttestationDocument


# Machine-readable causes of a verification failure. Callers log and branch on
# these instead of pattern-matching the human-readable ``error`` string.
#   verifier_image_hash_unconfigured -- no expected image hash is configured,
#                                       so there is nothing to verify against
#   image_hash_mismatch              -- the Verifier presented a different image
#   attestation_stale                -- document older than the replay window
#   hardware_signature_invalid       -- hardware/session signature did not verify
#   nonce_mismatch                   -- different nonce echoed; possible replay
#   attestation_fetch_failed         -- the document could not be retrieved
#   verifier_key_mismatch            -- the document (or registration) carries a
#                                       session key other than the one management
#                                       attested (#1259)
VerifierVerifyFailureReason = Literal[
    "verifier_image_hash_unconfigured",
    "image_hash_mismatch",
    "attestation_stale",
    "hardware_signature_invalid",
    "nonce_mismatch",
    "attestation_fetch_failed",
    "verifier_key_mismatch",
]

# Shared message for the unconfigured case, so the SDK and the fetch helper
# report the missing server-side configuration identically.
_UNCONFIGURED_ERROR = (
    "No expected Verifier image hash is configured, so the Verifier cannot be "
    "attested. Record the Verifier image hash on the management server "
    "(returned as `verifierImageHash` from POST /v1/discover)."
)


@dataclass
class VerifierVerifyOptions:
    """Options for Verifier attestation verification."""

    # Expected SHA384 hash of the Verifier Docker image. An empty value means
    # the server never recorded one; verification then fails closed with
    # `verifier_image_hash_unconfigured` rather than passing vacuously.
    expected_image_hash: str
    # Skip strict verification entirely. Development only, and never derived
    # from `expected_image_hash` -- see the module docstring for the opt-in the
    # SDK requires before setting this.
    mock_mode: bool = False
    # Expected certificate hash for pinning
    expected_cert_hash: str | None = field(default=None)
    # The session key management attested (discovery's `verifierPublicKey`,
    # #1259). When set, the document must carry exactly this key, whatever its
    # attestation type.
    expected_public_key: str | None = field(default=None)


@dataclass
class VerifierVerifyResult:
    """Result of Verifier verification."""

    # Whether the Verifier was verified successfully
    verified: bool
    # The attestation document if verified
    attestation: VerifierAttestationDocument | None = field(default=None)
    # Error message if verification failed
    error: str | None = field(default=None)
    # Machine-readable cause, set whenever `verified` is False
    reason: VerifierVerifyFailureReason | None = field(default=None)
    # Whether certificate was verified against pinned hash
    certificate_verified: bool | None = field(default=None)


async def verify_verifier_attestation(
    attestation: VerifierAttestationDocument,
    options: VerifierVerifyOptions,
) -> dict:
    """Verify a Verifier attestation document.

    Args:
        attestation: The attestation document from the Verifier.
        options: Verification options.

    Returns:
        Dict with 'verified' (bool) and optional 'error' (str).
    """
    # In mock mode, skip strict verification
    if options.mock_mode:
        print("[cTLS] Mock mode - skipping strict verification")
        return {"verified": True}

    # Step 0: Refuse to "verify" against nothing. Without a pinned image hash
    # there is no claim to check, so passing here would report success for an
    # unverified Verifier -- the S1 bypass. Fail closed instead.
    if not options.expected_image_hash:
        return {
            "verified": False,
            "reason": "verifier_image_hash_unconfigured",
            "error": _UNCONFIGURED_ERROR,
        }

    # Step 1 (#1259): the document must carry the key management attested,
    # before any signature is checked.
    if (
        options.expected_public_key is not None
        and attestation.public_key != options.expected_public_key
    ):
        return {
            "verified": False,
            "reason": "verifier_key_mismatch",
            "error": (
                f"Verifier session key mismatch. Attested: "
                f"{options.expected_public_key}, presented: {attestation.public_key}"
            ),
        }

    # Step 2: Verify the image hash matches expected (reproducible build)
    if attestation.image_hash != options.expected_image_hash:
        return {
            "verified": False,
            "reason": "image_hash_mismatch",
            "error": (
                f"Image hash mismatch. Expected: {options.expected_image_hash}, "
                f"Got: {attestation.image_hash}"
            ),
        }

    # Step 2: Verify timestamp is recent (prevents replay attacks)
    max_age = 5 * 60 * 1000  # 5 minutes in milliseconds
    now_ms = int(time.time() * 1000)
    age = now_ms - attestation.timestamp
    if age > max_age:
        return {
            "verified": False,
            "reason": "attestation_stale",
            "error": f"Attestation too old: {age}ms (max: {max_age}ms)",
        }

    # Step 3: Verify hardware signature via Phala's verification API
    signature_valid = await _verify_hardware_signature(attestation)
    if not signature_valid:
        return {
            "verified": False,
            "reason": "hardware_signature_invalid",
            "error": "Hardware signature verification failed",
        }

    return {"verified": True}


async def _verify_hardware_signature(
    attestation: VerifierAttestationDocument,
) -> bool:
    """Verify the hardware signature, dispatching on the attestation type.

    Internal-mode and mock documents carry an Ed25519 self-signature by the
    session key over ``imageHash|publicKey|timestamp|nonce`` (the TypeScript
    twin's ``verifyInternalSessionSignature``). Nitro documents are not
    verifiable from Python yet and fail closed. Everything else is a TDX quote
    verified via Phala's attestation API.
    """
    if (
        not attestation.hardware_signature
        or len(attestation.hardware_signature) < 64
    ):
        return False

    if attestation.attestation_type in ("internal", "mock"):
        signed = "|".join(
            [
                attestation.image_hash,
                attestation.public_key,
                str(attestation.timestamp),
                attestation.nonce,
            ]
        )
        return await verify(
            signed, attestation.hardware_signature, attestation.public_key
        )

    if attestation.attestation_type == "nitro":
        print("[cTLS] Nitro attestation is not verifiable from Python; failing closed")
        return False

    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                "https://cloud-api.phala.network/api/v1/attestations/verify",
                json={"hex": attestation.hardware_signature},
                headers={"Content-Type": "application/json"},
            )

        if res.status_code != 200:
            print(
                f"[cTLS] Phala verification API returned {res.status_code}: "
                f"{res.reason_phrase}"
            )
            return False

        result = res.json()
        return result.get("quote", {}).get("verified") is True
    except Exception as error:
        print(f"[cTLS] Failed to verify hardware signature: {error}")
        return False


async def _fetch_attestation_with_retry(
    url: str,
    max_retries: int = 2,
    base_delay_ms: int = 1000,
) -> httpx.Response:
    """Fetch the attestation document with retries for transient gateway errors."""
    last_error: Exception | None = None

    for attempt in range(max_retries + 1):
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url, timeout=8.0)

            is_transient = (
                response.status_code != 200
                and (response.status_code == 403 or response.status_code >= 500)
            )
            if is_transient and attempt < max_retries:
                delay = base_delay_ms * (2**attempt) / 1000.0
                print(
                    f"[cTLS] Attestation fetch got {response.status_code}, "
                    f"retrying in {int(delay * 1000)}ms ({attempt + 1}/{max_retries})"
                )
                await asyncio.sleep(delay)
                continue
            return response
        except Exception as error:
            last_error = error  # type: ignore[assignment]
            if attempt < max_retries:
                delay = base_delay_ms * (2**attempt) / 1000.0
                print(
                    f"[cTLS] Attestation fetch failed, retrying in "
                    f"{int(delay * 1000)}ms ({attempt + 1}/{max_retries}): {error}"
                )
                await asyncio.sleep(delay)

    raise last_error  # type: ignore[misc]


async def fetch_and_verify_verifier(
    verifier_url: str,
    expected_image_hash: str,
    options: dict | None = None,
) -> VerifierVerifyResult:
    """Fetch and verify Verifier attestation from a URL.

    Args:
        verifier_url: URL of the Verifier server.
        expected_image_hash: Expected SHA384 hash of Verifier Docker image.
        options: Additional verification options (mock_mode, expected_cert_hash).

    Returns:
        Verification result with attestation document.
    """
    opts = options or {}

    # In mock mode, skip the attestation document fetch entirely.
    if opts.get("mock_mode"):
        print("[cTLS] Mock mode -- skipping attestation document fetch")
        return VerifierVerifyResult(verified=True)

    # Without a pinned image hash there is nothing to attest the Verifier
    # against. Refuse BEFORE the fetch -- an unverified Verifier gets no traffic.
    if not expected_image_hash:
        return VerifierVerifyResult(
            verified=False,
            reason="verifier_image_hash_unconfigured",
            error=_UNCONFIGURED_ERROR,
        )

    try:
        nonce = str(uuid.uuid4())
        response = await _fetch_attestation_with_retry(
            f"{verifier_url}/attestation?nonce={nonce}"
        )

        if response.status_code != 200:
            return VerifierVerifyResult(
                verified=False,
                reason="attestation_fetch_failed",
                error=(
                    f"Failed to fetch attestation: {response.status_code} "
                    f"{response.reason_phrase}"
                ),
            )

        data = response.json()
        attestation = VerifierAttestationDocument(
            image_hash=data["imageHash"],
            hardware_signature=data["hardwareSignature"],
            public_key=data["publicKey"],
            timestamp=data["timestamp"],
            nonce=data["nonce"],
            supported_algorithms=data.get("supportedAlgorithms"),
            event_log=data.get("eventLog"),
            compose_hash=data.get("composeHash"),
            attestation_type=data.get("attestationType"),
            verifier_id=data.get("verifierId"),
            attestation_key_signature=data.get("attestationKeySignature"),
        )

        # Verify nonce matches (prevents replay attacks)
        if attestation.nonce != nonce:
            return VerifierVerifyResult(
                verified=False,
                reason="nonce_mismatch",
                error="Nonce mismatch - possible replay attack",
            )

        result = await verify_verifier_attestation(
            attestation,
            VerifierVerifyOptions(
                expected_image_hash=expected_image_hash,
                expected_public_key=opts.get("expected_public_key"),
            ),
        )

        # Certificate pinning verification
        certificate_verified: bool | None = None
        if opts.get("expected_cert_hash"):
            certificate_verified = _verify_certificate_pin(
                verifier_url, opts["expected_cert_hash"]
            )

        return VerifierVerifyResult(
            verified=result["verified"],
            error=result.get("error"),
            reason=result.get("reason"),
            attestation=attestation if result["verified"] else None,
            certificate_verified=certificate_verified,
        )
    except Exception as error:
        return VerifierVerifyResult(
            verified=False,
            reason="attestation_fetch_failed",
            error=f"Failed to verify Verifier: {error}",
        )


def _verify_certificate_pin(url: str, expected_cert_hash: str) -> bool:
    """Verify TLS certificate against pinned hash.

    Fail-closed: returns False when raw TLS access is not available.
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme != "https":
            print("[cTLS] Certificate pinning requires HTTPS")
            return False

        # Python does not provide easy access to peer TLS certificates
        # from httpx/requests. Fail closed for safety.
        print(
            f"[cTLS] Certificate pinning check requested for {parsed.hostname} "
            "-- full TLS inspection requires ssl.SSLSocket (returning False for safety)"
        )
        return False
    except Exception as err:
        print(f"[cTLS] Certificate pinning error: {err}")
        return False
