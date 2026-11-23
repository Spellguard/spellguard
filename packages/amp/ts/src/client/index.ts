// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Client-side utilities
 *
 * Message encryption.
 */

export {
  encryptForVerifier,
  decryptFromVerifier,
  deriveAgentKeyPair,
  generateAgentKeyPair,
  hashPayload,
} from './encrypt';

// Re-export types needed by clients
export type {
  UnilateralSendResult,
  A2AResponse,
  AttestationLevel,
} from '../types/index';
