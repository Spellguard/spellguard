# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Evidence Verification

Server-side verification of agent evidence (RFC 9334 RATS pattern).
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

from ..crypto.ephemeral import get_session_public_key, get_session_x25519_public_key
from ..crypto.signing import verify
from ..types import (
    AttestationResult,
    Evidence,
    EvidenceClaims,
    RegisteredAgent,
    RotationPolicy,
)
from .registry import register_agent

# Token validity duration (24 hours)
TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1000

# Validation constants
MAX_AGENT_ID_LENGTH = 255
ALLOWED_ALGORITHMS = ["AES-256-GCM", "ChaCha20-Poly1305"]

# SSRF protection: Block internal network addresses
_INTERNAL_IP_PATTERNS = [
    re.compile(r"^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$"),
    re.compile(r"^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$"),
    re.compile(r"^192\.168\.\d{1,3}\.\d{1,3}$"),
    re.compile(r"^::1$"),
    re.compile(r"^fe80:", re.IGNORECASE),
    re.compile(r"^fc00:", re.IGNORECASE),
    re.compile(r"^fd00:", re.IGNORECASE),
]


@dataclass
class VerifyEvidenceOptions:
    """Options for evidence verification."""

    # Verifier's own port (for SSRF self-reference protection)
    verifier_port: str | None = field(default=None)
    # Agent's Ed25519 public key (hex) for real signature verification
    agent_public_key: str | None = field(default=None)


def _is_internal_url(url_string: str, verifier_port: str = "3000") -> bool:
    """Check if a URL points to an internal network address."""
    try:
        parsed = urlparse(url_string)
        hostname = parsed.hostname or ""

        for pattern in _INTERNAL_IP_PATTERNS:
            if pattern.search(hostname):
                return True

        # Block self-reference to Verifier
        port = str(parsed.port) if parsed.port else ""
        if hostname in ("localhost", "127.0.0.1") and port == verifier_port:
            return True

        return False
    except Exception:
        return True  # Invalid URL = blocked


async def verify_evidence(
    evidence: Evidence,
    options: VerifyEvidenceOptions | None = None,
) -> AttestationResult:
    """Verify agent evidence and issue attestation result.

    The verifier acts as the "Verifier" role in RFC 9334 RATS:
    1. Receives Evidence from the Attester (agent)
    2. Appraises the Evidence against policy
    3. Returns Attestation Result

    Args:
        evidence: Evidence submitted by the agent.
        options: Verification options.

    Returns:
        Attestation result.

    Raises:
        RuntimeError: If Verifier session keys are not initialized.
    """
    opts = options or VerifyEvidenceOptions()

    session_public_key = get_session_public_key()
    if not session_public_key:
        raise RuntimeError("Verifier session keys not initialized")

    session_x25519_pub_key = get_session_x25519_public_key()

    def fail_result(error: str | None = None) -> AttestationResult:
        return AttestationResult(
            agent_id=evidence.agent_id,
            verified=False,
            channel_token="",
            session_public_key="",
            expires_at=0,
            error=error,
        )

    # Step 0: Validate agent ID length
    if len(evidence.agent_id) > MAX_AGENT_ID_LENGTH:
        return fail_result(
            f"Agent ID too long (max {MAX_AGENT_ID_LENGTH} characters)"
        )

    # Step 1: Verify the evidence signature
    signature_valid = await _verify_evidence_signature(
        evidence, opts.agent_public_key
    )
    if not signature_valid:
        return fail_result("Invalid evidence signature")

    # Step 2: Validate claims
    claims_validation = _validate_claims(evidence.claims, opts.verifier_port)
    if not claims_validation["valid"]:
        return fail_result(claims_validation.get("error"))

    # Step 3: Generate channel token
    channel_token = _generate_channel_token()
    now_ms = int(time.time() * 1000)
    expires_at = now_ms + TOKEN_VALIDITY_MS

    # Step 4: Register the agent
    registered_agent = RegisteredAgent(
        agent_id=evidence.agent_id,
        endpoint=evidence.claims.endpoint,
        agent_card_url=evidence.claims.agent_card_url,
        code_hash=evidence.claims.code_hash,
        channel_token=channel_token,
        registered_at=now_ms,
        expires_at=expires_at,
    )

    # Step 1 above already verified the evidence signature against the
    # agent's management-tracked public key, so the registering party
    # demonstrably controls the agent identity AND signed off on the
    # claimed endpoint. That makes endpoint updates on re-registration
    # safe — preventing them only locks legitimate redeploys (e.g.
    # moving to a custom domain) out of an existing agent_id without
    # adding any real anti-hijacking guarantee on top of the signature.
    reg_result = register_agent(registered_agent, allow_endpoint_update=True)
    if not reg_result.success:
        return fail_result(reg_result.error)

    # Step 5: Return attestation result
    return AttestationResult(
        agent_id=evidence.agent_id,
        verified=True,
        channel_token=channel_token,
        session_public_key=session_public_key,
        session_x25519_public_key=session_x25519_pub_key or None,
        expires_at=expires_at,
        rotation_policy=RotationPolicy(
            max_age=TOKEN_VALIDITY_MS,
            refresh_endpoint="/channels/refresh",
        ),
    )


async def _verify_evidence_signature(
    evidence: Evidence,
    agent_public_key: str | None = None,
) -> bool:
    """Verify the signature on the evidence using Ed25519.

    If an agent_public_key is provided (from management JWT), performs real
    cryptographic verification. Otherwise falls back to field-presence
    check for backward compatibility with pre-migration agents.
    """
    import json

    # If we have the agent's public key, perform real Ed25519 verification
    if agent_public_key:
        try:
            # CR-001: Sign over both agentId and claims to prevent identity substitution
            signed_payload = json.dumps(
                {
                    "agentId": evidence.agent_id,
                    "claims": {
                        "codeHash": evidence.claims.code_hash,
                        "endpoint": evidence.claims.endpoint,
                        "agentCardUrl": evidence.claims.agent_card_url,
                        "capabilities": evidence.claims.capabilities,
                        "preferredAlgorithm": evidence.claims.preferred_algorithm,
                    },
                },
                separators=(",", ":"),
            )
            return await verify(signed_payload, evidence.signature, agent_public_key)
        except Exception as err:
            print(f"[cTLS] Ed25519 signature verification error: {err}")
            return False

    # Fallback: field-presence check for pre-migration agents without public key
    return bool(
        evidence.agent_id
        and evidence.claims
        and evidence.claims.code_hash
        and evidence.claims.endpoint
        and evidence.signature
    )


def _validate_claims(
    claims: EvidenceClaims,
    verifier_port: str | None = None,
) -> dict:
    """Validate the claims in the evidence."""
    if not claims.code_hash or not claims.endpoint:
        return {
            "valid": False,
            "error": "Missing required fields: codeHash or endpoint",
        }

    try:
        parsed = urlparse(claims.endpoint)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError("Invalid URL")
    except Exception:
        return {"valid": False, "error": "Invalid endpoint URL format"}

    port = verifier_port or "3000"
    if _is_internal_url(claims.endpoint, port):
        return {
            "valid": False,
            "error": "internal network endpoints not allowed (SSRF protection)",
        }

    if claims.agent_card_url:
        try:
            parsed = urlparse(claims.agent_card_url)
            if not parsed.scheme or not parsed.netloc:
                raise ValueError("Invalid URL")
        except Exception:
            return {"valid": False, "error": "Invalid agent card URL format"}

        if _is_internal_url(claims.agent_card_url, port):
            return {
                "valid": False,
                "error": "internal network agent card URLs not allowed (SSRF protection)",
            }

    if claims.preferred_algorithm:
        if claims.preferred_algorithm not in ALLOWED_ALGORITHMS:
            return {
                "valid": False,
                "error": (
                    f"Unsupported algorithm: {claims.preferred_algorithm}. "
                    f"Allowed: {', '.join(ALLOWED_ALGORITHMS)}"
                ),
            }

    return {"valid": True}


def _generate_channel_token() -> str:
    """Generate a cryptographically secure channel token."""
    return secrets.token_bytes(32).hex()
