# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Verifier Verification

Client-side verification of Verifier attestation documents.
This enables bidirectional attestation - clients verify Verifier, not just Verifier verifying clients.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

from ..types import VerifierAttestationDocument


@dataclass
class VerifierVerifyOptions:
    """Options for Verifier attestation verification."""

    # Expected SHA384 hash of the Verifier Docker image
    expected_image_hash: str
    # Skip strict verification (for development only)
    mock_mode: bool = False
    # Expected certificate hash for pinning
    expected_cert_hash: str | None = field(default=None)


@dataclass
class VerifierVerifyResult:
    """Result of Verifier verification."""

    # Whether the Verifier was verified successfully
    verified: bool
    # The attestation document if verified
    attestation: VerifierAttestationDocument | None = field(default=None)
    # Error message if verification failed
    error: str | None = field(default=None)
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

    # Step 1: Verify the image hash matches expected (reproducible build)
    if attestation.image_hash != options.expected_image_hash:
        return {
            "verified": False,
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
            "error": f"Attestation too old: {age}ms (max: {max_age}ms)",
        }

    # Step 3: Verify hardware signature via Phala's verification API
    signature_valid = await _verify_hardware_signature(attestation)
    if not signature_valid:
        return {
            "verified": False,
            "error": "Hardware signature verification failed",
        }

    return {"verified": True}


async def _verify_hardware_signature(
    attestation: VerifierAttestationDocument,
) -> bool:
    """Verify the TDX hardware signature via Phala's attestation verification API.
    The quote is a hex-encoded TDX quote produced by DstackClient.getQuote().
    """
    if (
        not attestation.hardware_signature
        or len(attestation.hardware_signature) < 64
    ):
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

    try:
        nonce = str(uuid.uuid4())
        response = await _fetch_attestation_with_retry(
            f"{verifier_url}/attestation?nonce={nonce}"
        )

        if response.status_code != 200:
            return VerifierVerifyResult(
                verified=False,
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
        )

        # Verify nonce matches (prevents replay attacks)
        if attestation.nonce != nonce:
            return VerifierVerifyResult(
                verified=False,
                error="Nonce mismatch - possible replay attack",
            )

        result = await verify_verifier_attestation(
            attestation,
            VerifierVerifyOptions(expected_image_hash=expected_image_hash),
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
            attestation=attestation if result["verified"] else None,
            certificate_verified=certificate_verified,
        )
    except Exception as error:
        return VerifierVerifyResult(
            verified=False,
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
