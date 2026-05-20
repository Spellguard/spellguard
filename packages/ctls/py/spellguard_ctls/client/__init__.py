# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls.client - Client-side utilities

Verifier verification and evidence building for agents connecting to Verifier.
"""

from __future__ import annotations

from .evidence import BuildEvidenceOptions, build_evidence, sign_evidence
from .verifier_verify import (
    VerifierVerifyOptions,
    VerifierVerifyResult,
    fetch_and_verify_verifier,
    verify_verifier_attestation,
)

__all__ = [
    # verifier_verify
    "verify_verifier_attestation",
    "fetch_and_verify_verifier",
    "VerifierVerifyOptions",
    "VerifierVerifyResult",
    # evidence
    "build_evidence",
    "sign_evidence",
    "BuildEvidenceOptions",
]
