// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Server-side attestation utilities
 *
 * Functions for generating attestation documents, verifying evidence,
 * and managing the agent registry.
 */

export {
  generateAttestationDocument,
  getExpectedImageHash,
  computeImageHash,
} from './attestation';

export {
  generateNitroAttestation,
  type NitroAttestationResult,
} from './nitro-nsm';

export {
  verifyEvidence,
  type VerifyEvidenceOptions,
} from './verifier';

export {
  registerAgent,
  getAgent,
  getAgentByToken,
  getAllAgents,
  isAgentRegistered,
  rotateChannelToken,
  verifyChannelToken,
  clearRegistry,
} from './registry';
