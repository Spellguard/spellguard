// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Cryptographic utilities
 *
 * Ed25519 signing, X25519 key agreement, and ephemeral key management.
 */

export {
  generateSessionKeys,
  destroySessionKeys,
  getSessionPublicKey,
  getSessionX25519PublicKey,
  getSessionX25519PrivateKey,
  signWithSessionKey,
} from './ephemeral';

export { sign, verify, generateKeyPair, derivePublicKey } from './signing';
