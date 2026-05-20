// SPDX-License-Identifier: Apache-2.0

/**
 * Nitro Enclave attestation via the NSM (Nitro Security Module).
 *
 * Calls a small Go helper binary (`/opt/spellguard/nsm-attestation`) that
 * opens /dev/nsm, generates an attestation document with user_data, and
 * returns JSON with the COSE_Sign1 document and PCR values.
 */

import { spawnSync } from 'node:child_process';

export interface NitroAttestationResult {
  /** Base64-encoded COSE_Sign1 attestation document */
  attestationDocument: string;
  /** PCR values from the enclave measurement */
  pcrs: Record<number, string>;
}

const NSM_BINARY_PATH =
  process.env.NSM_BINARY_PATH || '/opt/spellguard/nsm-attestation';

/**
 * Generate a Nitro attestation document with the given user data.
 *
 * @param userData - Arbitrary bytes to embed in the attestation document
 * @returns Attestation document (base64 COSE_Sign1) and PCR values
 */
export async function generateNitroAttestation(
  userData: Uint8Array,
): Promise<NitroAttestationResult> {
  const userDataB64 = Buffer.from(userData).toString('base64');

  const proc = spawnSync(NSM_BINARY_PATH, ['--user-data', userDataB64], {
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });

  // Always log stderr for diagnostics (visible in enclave console)
  if (proc.stderr) {
    console.warn(`[NSM] ${proc.stderr.trim()}`);
  }

  if (proc.error) {
    if ('code' in proc.error && proc.error.code === 'ENOENT') {
      throw new Error(
        `NSM binary not found at ${NSM_BINARY_PATH}. Ensure the Nitro enclave image includes the nsm-attestation binary.`,
      );
    }
    throw new Error(`Nitro attestation failed: ${proc.error.message}`);
  }

  if (proc.status !== 0) {
    throw new Error(
      `NSM binary exited with code ${proc.status}: ${proc.stderr || '(no stderr)'}`,
    );
  }

  const result = JSON.parse(proc.stdout) as NitroAttestationResult;

  if (!result.attestationDocument) {
    throw new Error('NSM binary returned no attestationDocument');
  }

  return result;
}
