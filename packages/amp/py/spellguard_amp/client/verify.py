# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.client.verify - Archive Integrity Verification

Verify that archived data matches commitment hashes.
"""

from __future__ import annotations

from spellguard_amp.client.encrypt import hash_payload


async def verify_archive_integrity(
    commitment: dict[str, str],
    archive: dict[str, str],
) -> bool:
    """
    Verify that archived data matches the commitment hash.
    Used to detect tampering of archived messages.

    Args:
        commitment: The commitment from the audit trail (must have 'hash' and 'messageId' keys).
        archive: The archived message data (must have 'id' and 'encryptedPayload' keys).

    Returns:
        True if the archive matches the commitment.
    """
    # Compute the hash of the archived payload
    computed_hash = hash_payload(archive["encrypted_payload"])

    # Compare with the commitment hash
    return commitment["hash"] == computed_hash
