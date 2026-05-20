// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Evidence Building
 *
 * Utilities for building and signing attestation evidence.
 */

import { sign } from '../crypto';
import type { Evidence } from '../types';

/**
 * Options for building evidence.
 */
export interface BuildEvidenceOptions {
  /** Unique identifier for the agent */
  agentId: string;
  /** Hash of the agent's code */
  codeHash: string;
  /** Agent's callback endpoint URL */
  endpoint: string;
  /** URL to the agent's A2A Agent Card */
  agentCardUrl: string;
  /** Capabilities the agent supports */
  capabilities?: string[];
  /** Preferred encryption algorithm */
  preferredAlgorithm?: string;
}

/**
 * Build evidence for Verifier attestation.
 *
 * @param options - Evidence options
 * @returns Unsigned evidence object
 */
export function buildEvidence(options: BuildEvidenceOptions): Evidence {
  return {
    agentId: options.agentId,
    claims: {
      codeHash: options.codeHash,
      endpoint: options.endpoint,
      agentCardUrl: options.agentCardUrl,
      capabilities: options.capabilities || ['receive', 'send'],
      preferredAlgorithm: options.preferredAlgorithm,
    },
    signature: '', // Will be set by signEvidence
  };
}

/**
 * Sign evidence with a private key.
 *
 * @param evidence - The evidence to sign
 * @param privateKey - Private key or seed for signing
 * @returns Evidence with signature attached
 */
export async function signEvidence(
  evidence: Evidence,
  privateKey: string,
): Promise<Evidence> {
  // CR-001 (verifier-side): the Verifier validates the signature
  // over both agentId and claims to prevent identity substitution
  // (server/verifier.ts:188).  Sign the same shape here.
  const signedPayload = JSON.stringify({
    agentId: evidence.agentId,
    claims: evidence.claims,
  });
  const signature = await sign(signedPayload, privateKey);

  return {
    ...evidence,
    signature,
  };
}
