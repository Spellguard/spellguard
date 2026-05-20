# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.server - Server-side utilities

Commitment generation, message routing, and channel management.
"""

from __future__ import annotations

from spellguard_amp.server.channel import (
    clear_channels,
    get_channel,
    get_channel_stats,
    get_or_create_channel,
    update_channel_activity,
)
from spellguard_amp.server.commitment import (
    generate_commitment,
    generate_unilateral_commitment,
    hash_payload,
    verify_commitment,
)

__all__ = [
    "generate_commitment",
    "verify_commitment",
    "hash_payload",
    "generate_unilateral_commitment",
    "get_or_create_channel",
    "get_channel",
    "update_channel_activity",
    "get_channel_stats",
    "clear_channels",
]
