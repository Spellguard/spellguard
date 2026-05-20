// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Server-side utilities
 *
 * Commitment generation, message routing, and channel management.
 */

export {
  generateCommitment,
  verifyCommitment,
  hashPayload,
  generateUnilateralCommitment,
} from './commitment';

export {
  getOrCreateChannel,
  updateChannelActivity,
  getChannelStats,
  clearChannels,
} from './channel';
