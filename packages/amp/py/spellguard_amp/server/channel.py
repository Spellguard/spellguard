# SPDX-License-Identifier: Apache-2.0

"""
spellguard_amp.server.channel - Channel Management

Manage communication channels between agents.
"""

from __future__ import annotations

import time

from spellguard_amp.types import Channel

# In-memory channel storage
_channels: dict[str, Channel] = {}


def get_or_create_channel(agent1: str, agent2: str) -> Channel:
    """
    Get or create a channel between two agents.

    Args:
        agent1: First agent ID.
        agent2: Second agent ID.

    Returns:
        The channel (existing or newly created).
    """
    # Normalize channel ID (sorted to be consistent regardless of order)
    participants = tuple(sorted([agent1, agent2]))
    channel_id = f"channel_{participants[0]}_{participants[1]}"

    channel = _channels.get(channel_id)

    if channel is None:
        now = int(time.time() * 1000)
        channel = Channel(
            id=channel_id,
            participants=(participants[0], participants[1]),
            created_at=now,
            last_activity=now,
        )
        _channels[channel_id] = channel
        print(f"[AMP] Created channel: {channel_id}")

    return channel


def update_channel_activity(channel_id: str) -> None:
    """
    Update the last activity timestamp for a channel.

    Args:
        channel_id: Channel ID to update.
    """
    channel = _channels.get(channel_id)
    if channel is not None:
        channel.last_activity = int(time.time() * 1000)


def get_channel(channel_id: str) -> Channel | None:
    """
    Get channel by ID.

    Args:
        channel_id: Channel ID.

    Returns:
        Channel or None.
    """
    return _channels.get(channel_id)


def get_channel_stats() -> dict[str, int]:
    """
    Get statistics about channels.

    Returns:
        Dict with 'total', 'active', and 'stale' counts.
    """
    now = int(time.time() * 1000)
    stale_threshold = 24 * 60 * 60 * 1000  # 24 hours

    active = 0
    stale = 0

    for channel in _channels.values():
        if now - channel.last_activity > stale_threshold:
            stale += 1
        else:
            active += 1

    return {
        "total": len(_channels),
        "active": active,
        "stale": stale,
    }


def clear_channels() -> None:
    """Clear all channels (for testing)."""
    _channels.clear()
