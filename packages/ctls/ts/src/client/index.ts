// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Client-side attestation utilities
 *
 * Functions for verifying Verifier attestation and building evidence.
 */

export {
  verifyVerifierAttestation,
  fetchAndVerifyVerifier,
} from './verifier-verify';
export {
  verifyNitroHardwareSignature,
  type NitroVerifyResult,
  type NitroVerifyOptions,
} from './nitro-verify';
export { buildEvidence, signEvidence } from './evidence';
