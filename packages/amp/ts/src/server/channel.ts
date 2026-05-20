// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Channel Management
 *
 * Manage communication channels between agents.
 */

import type { Channel } from '../types';

// In-memory channel storage
const channels = new Map<string, Channel>();

/**
 * Get or create a channel between two agents.
 *
 * @param agent1 - First agent ID
 * @param agent2 - Second agent ID
 * @returns The channel (existing or newly created)
 */
export function getOrCreateChannel(agent1: string, agent2: string): Channel {
  // Normalize channel ID (sorted to be consistent regardless of order)
  const participants = [agent1, agent2].sort() as [string, string];
  const channelId = `channel_${participants[0]}_${participants[1]}`;

  let channel = channels.get(channelId);

  if (!channel) {
    channel = {
      id: channelId,
      participants,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    channels.set(channelId, channel);
    console.log(`[AMP] Created channel: ${channelId}`);
  }

  return channel;
}

/**
 * Update the last activity timestamp for a channel.
 *
 * @param channelId - Channel ID to update
 */
export function updateChannelActivity(channelId: string): void {
  const channel = channels.get(channelId);
  if (channel) {
    channel.lastActivity = Date.now();
  }
}

/**
 * Get channel by ID.
 *
 * @param channelId - Channel ID
 * @returns Channel or undefined
 */
export function getChannel(channelId: string): Channel | undefined {
  return channels.get(channelId);
}

/**
 * Get statistics about channels.
 *
 * @returns Channel statistics
 */
export function getChannelStats(): {
  total: number;
  active: number;
  stale: number;
} {
  const now = Date.now();
  const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours

  let active = 0;
  let stale = 0;

  for (const channel of channels.values()) {
    if (now - channel.lastActivity > staleThreshold) {
      stale++;
    } else {
      active++;
    }
  }

  return {
    total: channels.size,
    active,
    stale,
  };
}

/**
 * Clear all channels (for testing).
 */
export function clearChannels(): void {
  channels.clear();
}
