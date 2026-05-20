# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Confidential TLS

Bidirectional attestation and secure channel establishment for Verifiers.

This package provides:
- Verifier attestation document generation and verification
- RFC 9334 RATS-style evidence building and verification
- Agent registration and channel token management
- Ephemeral session key management for forward secrecy

Example - Client-side: Verify Verifier before connecting::

    from spellguard_ctls import fetch_and_verify_verifier, build_evidence, sign_evidence

    result = await fetch_and_verify_verifier(verifier_url, expected_hash)
    if not result.verified:
        raise RuntimeError("Verifier verification failed")

    evidence = build_evidence(BuildEvidenceOptions(
        agent_id=agent_id, code_hash=code_hash,
        endpoint=endpoint, agent_card_url=agent_card_url,
    ))
    signed_evidence = await sign_evidence(evidence, private_key)

Example - Server-side: Generate attestation and verify evidence::

    from spellguard_ctls import (
        generate_session_keys,
        generate_attestation_document,
        verify_evidence,
    )

    await generate_session_keys()
    attestation = await generate_attestation_document(nonce)
    result = await verify_evidence(evidence)
"""

from __future__ import annotations

# ═══════════════════════════════════════════════════════════════════
# Types
# ═══════════════════════════════════════════════════════════════════

from .types import (
    AgentCard,
    AgentCardAuthentication,
    AgentCardCapabilities,
    AgentCardSkill,
    AttestationResult,
    Evidence,
    EvidenceClaims,
    RegisteredAgent,
    RotationPolicy,
    SessionKeys,
    VerifierAttestationDocument,
)

# ═══════════════════════════════════════════════════════════════════
# Client-side (for agents connecting to Verifier)
# ═══════════════════════════════════════════════════════════════════

from .client.evidence import BuildEvidenceOptions, build_evidence, sign_evidence
from .client.verifier_verify import (
    VerifierVerifyOptions,
    VerifierVerifyResult,
    fetch_and_verify_verifier,
    verify_verifier_attestation,
)

# ═══════════════════════════════════════════════════════════════════
# Server-side (for Verifier implementation)
# ═══════════════════════════════════════════════════════════════════

from .server.attestation import (
    compute_image_hash,
    generate_attestation_document,
    get_expected_image_hash,
)
from .server.registry import (
    RegisterResult,
    clear_registry,
    get_agent,
    get_agent_by_token,
    get_all_agents,
    is_agent_registered,
    register_agent,
    rotate_channel_token,
    verify_channel_token,
)
from .server.verifier import VerifyEvidenceOptions, verify_evidence

# ═══════════════════════════════════════════════════════════════════
# Crypto utilities
# ═══════════════════════════════════════════════════════════════════

from .crypto.ephemeral import (
    destroy_session_keys,
    generate_session_keys,
    get_session_public_key,
    sign_with_session_key,
)
from .crypto.signing import generate_key_pair, sign, verify

__all__ = [
    # Types
    "VerifierAttestationDocument",
    "SessionKeys",
    "Evidence",
    "EvidenceClaims",
    "AttestationResult",
    "RotationPolicy",
    "RegisteredAgent",
    "AgentCard",
    "AgentCardCapabilities",
    "AgentCardSkill",
    "AgentCardAuthentication",
    # Client
    "verify_verifier_attestation",
    "fetch_and_verify_verifier",
    "VerifierVerifyOptions",
    "VerifierVerifyResult",
    "build_evidence",
    "sign_evidence",
    "BuildEvidenceOptions",
    # Server
    "generate_attestation_document",
    "get_expected_image_hash",
    "compute_image_hash",
    "verify_evidence",
    "VerifyEvidenceOptions",
    "register_agent",
    "get_agent",
    "get_agent_by_token",
    "get_all_agents",
    "is_agent_registered",
    "rotate_channel_token",
    "verify_channel_token",
    "clear_registry",
    "RegisterResult",
    # Crypto
    "generate_session_keys",
    "destroy_session_keys",
    "get_session_public_key",
    "sign_with_session_key",
    "sign",
    "verify",
    "generate_key_pair",
]
