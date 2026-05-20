// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier-local attestation helpers.
 *
 * The main attestation generation logic has been consolidated into
 * @spellguard/ctls (generateAttestationDocument). This file retains
 * only the helpers that are used directly by the Verifier server.
 */

import { sha384 } from '@noble/hashes/sha512';

/**
 * Get the expected image hash for verification.
 *
 * Sources (in order):
 *   1. VERIFIER_IMAGE_HASH environment variable (set by CI/deployment)
 *   2. Mock placeholder (when VERIFIER_MOCK_MODE=true)
 *
 * For Nitro enclaves, the image hash comes from the NSM device (PCR0)
 * and this function is only used as a fallback.
 */
export function getExpectedImageHash(): string {
  const hash = process.env.VERIFIER_IMAGE_HASH;
  if (hash) return hash;

  if (process.env.VERIFIER_MOCK_MODE === 'true') {
    return 'sha384:mock-dev-image-hash';
  }

  throw new Error(
    'VERIFIER_IMAGE_HASH environment variable is required. ' +
      'Set it to the SHA384 hash of the Verifier Docker image.',
  );
}

/**
 * Compute image hash from Docker image contents.
 * Used during reproducible builds to generate the hash.
 */
export function computeImageHash(imageContents: Uint8Array): string {
  const hash = sha384(imageContents);
  return `sha384:${bytesToHex(hash)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
