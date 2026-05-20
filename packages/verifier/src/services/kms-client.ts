// SPDX-License-Identifier: Apache-2.0

/**
 * KMS client for the Verifier — generates per-message Data Encryption Keys (DEKs).
 *
 * Used exclusively at archive encryption time. Decryption is performed by the
 * management worker, which has separate KMS credentials scoped to kms:Decrypt.
 *
 * Credentials are read from explicit env vars (ADMIN_AUDIT_ACCESS_KEY_ID,
 * ADMIN_AUDIT_SECRET_ACCESS_KEY, ADMIN_AUDIT_REGION) following the same
 * prefix pattern as the S3 archive backend (S3_ACCESS_KEY_ID, etc.).
 * IMDS is not reachable from inside a Nitro Enclave.
 *
 * The caller is responsible for zeroing `plaintextDEK` after use.
 */

import {
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
  KMSClient,
  KMSServiceException,
} from '@aws-sdk/client-kms';

export interface DEKResult {
  /** 32-byte AES-256 key — zero this from memory after use */
  plaintextDEK: Uint8Array;
  /** Opaque KMS-encrypted blob for storage alongside the ciphertext */
  encryptedDEK: Uint8Array;
}

let kmsClient: KMSClient | null = null;

function getClient(): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({
      region: process.env.ADMIN_AUDIT_REGION || 'us-east-1',
      credentials: process.env.ADMIN_AUDIT_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.ADMIN_AUDIT_ACCESS_KEY_ID,
            secretAccessKey: process.env.ADMIN_AUDIT_SECRET_ACCESS_KEY || '',
          }
        : undefined,
    });
  }
  return kmsClient;
}

/**
 * Generate a fresh 256-bit Data Encryption Key via KMS.
 *
 * @param keyId - The KMS CMK ARN or alias (ADMIN_AUDIT_KMS_ARN env var)
 * @returns Plaintext DEK (for in-memory encryption) and encrypted DEK (for storage)
 * @throws if KMS is unreachable or the key policy denies access
 */
export async function generateDataKey(keyId: string): Promise<DEKResult> {
  const client = getClient();

  let response: GenerateDataKeyCommandOutput;
  try {
    response = await client.send(
      new GenerateDataKeyCommand({
        KeyId: keyId,
        KeySpec: 'AES_256',
        EncryptionContext: { purpose: 'spellguard-archive-dek' },
      }),
    );
  } catch (err) {
    if (err instanceof KMSServiceException) {
      throw new Error(
        `[KmsClient] GenerateDataKey failed (${err.name}): ${err.message}`,
      );
    }
    throw err;
  }

  if (!response.Plaintext || !response.CiphertextBlob) {
    throw new Error(
      '[KmsClient] GenerateDataKey response missing Plaintext or CiphertextBlob',
    );
  }

  return {
    plaintextDEK: new Uint8Array(response.Plaintext),
    encryptedDEK: new Uint8Array(response.CiphertextBlob),
  };
}
