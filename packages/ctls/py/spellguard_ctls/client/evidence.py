# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls - Evidence Building

Utilities for building and signing attestation evidence.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from ..crypto.signing import sign
from ..types import Evidence, EvidenceClaims


@dataclass
class BuildEvidenceOptions:
    """Options for building evidence."""

    # Unique identifier for the agent
    agent_id: str
    # Hash of the agent's code
    code_hash: str
    # Agent's callback endpoint URL
    endpoint: str
    # URL to the agent's A2A Agent Card
    agent_card_url: str
    # Capabilities the agent supports
    capabilities: list[str] | None = field(default=None)
    # Preferred encryption algorithm
    preferred_algorithm: str | None = field(default=None)


def build_evidence(options: BuildEvidenceOptions) -> Evidence:
    """Build evidence for Verifier attestation.

    Args:
        options: Evidence options.

    Returns:
        Unsigned evidence object.
    """
    return Evidence(
        agent_id=options.agent_id,
        claims=EvidenceClaims(
            code_hash=options.code_hash,
            endpoint=options.endpoint,
            agent_card_url=options.agent_card_url,
            capabilities=options.capabilities or ["receive", "send"],
            preferred_algorithm=options.preferred_algorithm,
        ),
        signature="",  # Will be set by sign_evidence
    )


async def sign_evidence(evidence: Evidence, private_key: str) -> Evidence:
    """Sign evidence with a private key.

    Args:
        evidence: The evidence to sign.
        private_key: Private key or seed for signing.

    Returns:
        Evidence with signature attached.
    """
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
    signature = await sign(signed_payload, private_key)

    return Evidence(
        agent_id=evidence.agent_id,
        claims=evidence.claims,
        signature=signature,
    )
