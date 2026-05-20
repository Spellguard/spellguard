// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Confidential TLS
 *
 * Bidirectional attestation and secure channel establishment for Verifiers.
 *
 * This package provides:
 * - Verifier attestation document generation and verification
 * - RFC 9334 RATS-style evidence building and verification
 * - Agent registration and channel token management
 * - Ephemeral session key management for forward secrecy
 *
 * @example
 * ```typescript
 * // Client-side: Verify Verifier before connecting
 * import { fetchAndVerifyVerifier, buildEvidence, signEvidence } from '@spellguard/ctls';
 *
 * const result = await fetchAndVerifyVerifier(verifierUrl, expectedHash);
 * if (!result.verified) throw new Error('Verifier verification failed');
 *
 * const evidence = buildEvidence({ agentId, codeHash, endpoint, agentCardUrl });
 * const signedEvidence = await signEvidence(evidence, privateKey);
 * ```
 *
 * @example
 * ```typescript
 * // Server-side: Generate attestation and verify evidence
 * import {
 *   generateSessionKeys,
 *   generateAttestationDocument,
 *   verifyEvidence
 * } from '@spellguard/ctls';
 *
 * await generateSessionKeys();
 * const attestation = await generateAttestationDocument(nonce);
 * const result = await verifyEvidence(evidence);
 * ```
 */

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type {
  VerifierAttestationDocument,
  SessionKeys,
  Evidence,
  AttestationResult,
  RegisteredAgent,
  AgentCard,
} from './types/index';

// ═══════════════════════════════════════════════════════════════════
// Client-side (for agents connecting to Verifier)
// ═══════════════════════════════════════════════════════════════════

export {
  verifyVerifierAttestation,
  fetchAndVerifyVerifier,
  type VerifierVerifyOptions,
  type VerifierVerifyResult,
} from './client/verifier-verify';

export {
  verifyNitroHardwareSignature,
  type NitroVerifyResult,
  type NitroVerifyOptions,
} from './client/nitro-verify';

export {
  buildEvidence,
  signEvidence,
  type BuildEvidenceOptions,
} from './client/evidence';

// ═══════════════════════════════════════════════════════════════════
// Server-side (for Verifier implementation)
// ═══════════════════════════════════════════════════════════════════

export {
  generateAttestationDocument,
  getExpectedImageHash,
  computeImageHash,
} from './server/attestation';

export {
  verifyEvidence,
  type VerifyEvidenceOptions,
} from './server/verifier';

export {
  registerAgent,
  getAgent,
  getAgentByToken,
  getAllAgents,
  isAgentRegistered,
  rotateChannelToken,
  verifyChannelToken,
  clearRegistry,
  type RegisterResult,
} from './server/registry';

// ═══════════════════════════════════════════════════════════════════
// Crypto utilities
// ═══════════════════════════════════════════════════════════════════

export {
  generateSessionKeys,
  destroySessionKeys,
  getSessionPublicKey,
  signWithSessionKey,
  exportSessionKeys,
  restoreSessionKeys,
  type SessionKeyData,
} from './crypto/ephemeral';

export { sign, verify, generateKeyPair } from './crypto/signing';
