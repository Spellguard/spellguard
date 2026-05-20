// SPDX-License-Identifier: Apache-2.0

import type { Channel } from '../types';

/**
 * In-memory store for active channels between agents.
 */
const channels = new Map<string, Channel>();

/**
 * Create a channel ID from two participant IDs.
 * Channel IDs are deterministic and symmetric (A-B == B-A).
 */
export function createChannelId(
  participant1: string,
  participant2: string,
): string {
  // Sort to ensure consistent ordering
  const sorted = [participant1, participant2].sort();
  return `channel:${sorted[0]}:${sorted[1]}`;
}

/**
 * Get or create a channel between two agents.
 */
export function getOrCreateChannel(
  participant1: string,
  participant2: string,
): Channel {
  const channelId = createChannelId(participant1, participant2);

  let channel = channels.get(channelId);
  if (!channel) {
    channel = {
      id: channelId,
      participants: [participant1, participant2].sort() as [string, string],
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    channels.set(channelId, channel);
    console.log(
      `[Channel] Created channel: ${channelId} between ${participant1} and ${participant2}`,
    );
  }

  return channel;
}

/**
 * Get an existing channel by ID.
 */
export function getChannel(channelId: string): Channel | undefined {
  return channels.get(channelId);
}

/**
 * Get a channel between two specific participants.
 */
export function getChannelBetween(
  participant1: string,
  participant2: string,
): Channel | undefined {
  const channelId = createChannelId(participant1, participant2);
  return channels.get(channelId);
}

/**
 * Update last activity timestamp for a channel.
 */
export function updateChannelActivity(channelId: string): void {
  const channel = channels.get(channelId);
  if (channel) {
    channel.lastActivity = Date.now();
  }
}

/**
 * Get all channels for a participant.
 */
export function getChannelsForParticipant(participantId: string): Channel[] {
  const result: Channel[] = [];
  for (const channel of channels.values()) {
    if (channel.participants.includes(participantId)) {
      result.push(channel);
    }
  }
  return result;
}

/**
 * Remove a channel.
 */
export function removeChannel(channelId: string): boolean {
  return channels.delete(channelId);
}

/**
 * Clear all channels (for testing).
 */
export function clearChannels(): void {
  channels.clear();
}

/**
 * Get channel statistics.
 */
export function getChannelStats(): {
  total: number;
  activeInLastHour: number;
} {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  let activeInLastHour = 0;

  for (const channel of channels.values()) {
    if (channel.lastActivity > oneHourAgo) {
      activeInLastHour++;
    }
  }

  return {
    total: channels.size,
    activeInLastHour,
  };
}
