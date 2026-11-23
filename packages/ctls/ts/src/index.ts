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
  attestationKeySigningString,
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

export {
  sign,
  verify,
  generateKeyPair,
  derivePublicKey,
} from './crypto/signing';

export {
  type EnvelopeSigner,
  envelopeKeyId,
  sha256Hex,
  signEnvelope,
  verifyEnvelope,
} from './crypto/signed-envelope';

// ═══════════════════════════════════════════════════════════════════
// Signed deliveries (#1244)
// ═══════════════════════════════════════════════════════════════════

export {
  DELIVERY_AUTH_HEADERS,
  DELIVERY_AUTH_MAX_SKEW_MS,
  DELIVERY_AUTH_SCHEME,
  DELIVERY_AUTH_VERSION,
  DeliveryNonceCache,
  type DeliveryAuthFailure,
  type DeliveryNonceStore,
  type DeliveryVerdict,
  deliveryKeyId,
  deliverySigningString,
  signDelivery,
  verifyDelivery,
} from './delivery/delivery-auth';

// ═══════════════════════════════════════════════════════════════════
// Signed verdicts (#1259)
// ═══════════════════════════════════════════════════════════════════

export {
  VERDICT_MAX_SKEW_MS,
  VERDICT_NONCE_HEADER,
  VERDICT_SIGNATURE_HEADER,
  VERDICT_SIGNATURE_VERSION,
  type VerdictFailure,
  isVerdictNonce,
  newVerdictNonce,
  signVerdict,
  verdictSigningString,
  verifyVerdict,
} from './verdict/verdict-signature';

// ═══════════════════════════════════════════════════════════════════
// Signed Verifier → management requests (#1344)
// ═══════════════════════════════════════════════════════════════════

export {
  VERIFIER_REQUEST_MAX_SKEW_MS,
  VERIFIER_REQUEST_SIGNATURE_HEADER,
  VERIFIER_REQUEST_SIGNATURE_VERSION,
  type VerifiedVerifierRequest,
  type VerifierRequestFailure,
  signVerifierRequest,
  verifierRequestSigningString,
  verifyVerifierRequest,
} from './verifier-request/request-signature';
