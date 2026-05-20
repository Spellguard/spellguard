// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Client-side utilities
 *
 * Message encryption and integrity verification.
 */

export {
  encryptForVerifier,
  decryptFromVerifier,
  hashPayload,
} from './encrypt';
export { verifyArchiveIntegrity } from './verify';

// Re-export types needed by clients
export type {
  UnilateralSendResult,
  A2AResponse,
  AttestationLevel,
} from '../types/index';
