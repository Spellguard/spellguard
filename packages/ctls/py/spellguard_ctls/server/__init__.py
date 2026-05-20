# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls.server - Server-side utilities

Verifier attestation generation, evidence verification, and agent registry.
"""

from __future__ import annotations

from .attestation import (
    compute_image_hash,
    generate_attestation_document,
    get_expected_image_hash,
)
from .registry import (
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
from .verifier import VerifyEvidenceOptions, verify_evidence

__all__ = [
    # attestation
    "generate_attestation_document",
    "get_expected_image_hash",
    "compute_image_hash",
    # verifier
    "verify_evidence",
    "VerifyEvidenceOptions",
    # registry
    "register_agent",
    "get_agent",
    "get_agent_by_token",
    "get_all_agents",
    "is_agent_registered",
    "rotate_channel_token",
    "verify_channel_token",
    "clear_registry",
    "RegisterResult",
]
