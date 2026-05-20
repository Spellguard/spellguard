// SPDX-License-Identifier: Apache-2.0

/**
 * Block notice adapter interface.
 *
 * Each supported platform implements this interface to handle posting
 * block notices and reactions through its platform-specific API.
 */
export interface BlockNoticeAdapter {
  /** Platform identifier this adapter handles (e.g., "slack", "discord") */
  platform: string;

  /**
   * Post a block notice in the platform channel.
   * @param channel  Platform channel identifier (e.g., Slack channel ID)
   * @param threadRef  Platform-specific message reference for threading
   * @param reason  Human-readable block reason
   */
  postBlockNotice(
    channel: string,
    threadRef: string | undefined,
    reason: string,
    creds: Record<string, string>,
  ): Promise<void>;

  /**
   * Add a reaction to the blocked message.
   * No-op if the platform doesn't support reactions.
   */
  addReaction(
    channel: string,
    messageRef: string | undefined,
    emoji: string,
    creds: Record<string, string>,
  ): Promise<void>;

  /**
   * Resolve platform credentials from OpenClaw config and/or environment.
   * Returns a platform-agnostic credential object or null if unavailable.
   */
  resolveCredentials(
    openclawConfig: Record<string, unknown> | undefined,
    accountId: string | undefined,
  ): Record<string, string> | null;

  /**
   * Extract the raw platform channel ID from an OpenClaw conversationId.
   * OpenClaw may prefix with type (e.g., "channel:C0123ABC" for Slack).
   */
  extractChannelId(conversationId: string | undefined): string | undefined;

  /**
   * Build a platform-appropriate dedup key from channel and message ref.
   * Slack uses `${channel}:${threadTs}`, Discord uses `${channel}:${snowflakeId}`.
   */
  buildDedupKey(channel: string, messageRef: string | undefined): string;
}
