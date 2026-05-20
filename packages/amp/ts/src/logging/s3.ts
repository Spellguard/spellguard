// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - S3 Backend
 *
 * AWS S3 archive backend for encrypted message storage.
 * Supports S3-compatible services like MinIO, Cloudflare R2, etc.
 *
 * Required environment variables:
 * - S3_BUCKET: Bucket name
 * - S3_REGION: AWS region
 * - S3_ACCESS_KEY_ID: Access key
 * - S3_SECRET_ACCESS_KEY: Secret key
 * - S3_ENDPOINT: (Optional) Custom endpoint for S3-compatible services
 */

import type {
  ArchiveBackend,
  ArchiveOptions,
  ArchivePayload,
  AuditCommitment,
  SecureMessage,
} from '../types';

/**
 * Read S3 configuration from process.env lazily.
 *
 * Reading env vars at every call (rather than at module init) is required
 * for Cloudflare Workers, where this module is imported before the Worker's
 * env bindings are populated into process.env. Runtime cost is negligible.
 */
function s3Config() {
  return {
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    endpoint: process.env.S3_ENDPOINT,
  };
}

function s3Endpoint(): string {
  const { region, endpoint } = s3Config();
  return endpoint || `https://s3.${region}.amazonaws.com`;
}

let connected = false;

/**
 * S3 archive backend with Object Lock support.
 */
export const s3Backend: ArchiveBackend = {
  name: 's3',

  async init(): Promise<void> {
    const { bucket, region, accessKeyId, secretAccessKey } = s3Config();

    if (!bucket) {
      console.warn('[AMP/S3] S3_BUCKET not configured. Archiving disabled.');
      connected = false;
      return;
    }

    if (!accessKeyId || !secretAccessKey) {
      console.warn(
        '[AMP/S3] S3 credentials not configured. Archiving disabled.',
      );
      connected = false;
      return;
    }

    const endpoint = s3Endpoint();
    console.log(
      `[AMP/S3] Connecting to ${endpoint}/${bucket} (region=${region})`,
    );

    // Retry the connection check — Nitro Enclaves may not have networking
    // ready immediately at boot (vsock bridge + outbound proxy startup).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`${endpoint}/${bucket}`, {
          method: 'HEAD',
          headers: await getS3Headers('HEAD', `/${bucket}`, ''),
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok || response.status === 200) {
          connected = true;
          console.log(`[AMP/S3] Connected to bucket: ${bucket}`);
          return;
        }

        if (response.status === 404) {
          console.warn(`[AMP/S3] Bucket not found: ${bucket}`);
          connected = false;
          return;
        }

        console.warn(
          `[AMP/S3] Connection attempt ${attempt}/3 failed: HTTP ${response.status}`,
        );
      } catch (error) {
        console.warn(
          `[AMP/S3] Connection attempt ${attempt}/3 error: ${error}`,
        );
      }

      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    console.warn(
      '[AMP/S3] All connection attempts failed. Archiving disabled.',
    );
    connected = false;
  },

  async archive(
    message: SecureMessage,
    commitment: AuditCommitment,
    options?: ArchiveOptions,
  ): Promise<string | null> {
    const { bucket } = s3Config();
    if (!connected || !bucket) {
      console.warn('[AMP/S3] Not connected, skipping archive');
      return null;
    }

    try {
      // When an encrypted envelope is provided, store it under a path that
      // doesn't leak sender/recipient in the key name.
      const archiveId = options?.encryptedEnvelope
        ? `spellguard/archive/${message.id}.json`
        : `spellguard/${commitment.sender}/${commitment.recipient}/${message.id}.json`;

      const payload = options?.encryptedEnvelope
        ? {
            messageId: message.id,
            encryptedEnvelope: options.encryptedEnvelope,
            commitment: {
              hash: commitment.hash,
              attestationLevel: commitment.attestationLevel,
            },
            archivedAt: new Date().toISOString(),
          }
        : {
            message,
            commitment,
            archivedAt: new Date().toISOString(),
          };

      const body = JSON.stringify(payload);

      const path = `/${bucket}/${archiveId}`;

      const response = await fetch(`${s3Endpoint()}${path}`, {
        method: 'PUT',
        headers: {
          ...(await getS3Headers('PUT', path, body)),
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        console.log(
          `[AMP/S3] Archived message: ${commitment.hash} -> ${archiveId}`,
        );
        return archiveId;
      }

      console.warn(`[AMP/S3] Failed to archive: ${response.status}`);
      return null;
    } catch (error) {
      console.error(`[AMP/S3] Error archiving message: ${error}`);
      return null;
    }
  },

  async retrieve(
    archiveId: string,
  ): Promise<ArchivePayload | SecureMessage | null> {
    const { bucket } = s3Config();
    if (!connected || !bucket) {
      return null;
    }

    try {
      const path = `/${bucket}/${archiveId}`;

      const response = await fetch(`${s3Endpoint()}${path}`, {
        method: 'GET',
        headers: await getS3Headers('GET', path, ''),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const data = await response.json();
        // New format has encryptedEnvelope; legacy format has message
        if (
          typeof data === 'object' &&
          data !== null &&
          'encryptedEnvelope' in data
        ) {
          return data as ArchivePayload;
        }
        return (data as { message: SecureMessage }).message;
      }

      if (response.status === 404) {
        return null;
      }

      console.warn(`[AMP/S3] Failed to retrieve: ${response.status}`);
      return null;
    } catch (error) {
      console.error(`[AMP/S3] Error retrieving message: ${error}`);
      return null;
    }
  },

  isConnected(): boolean {
    return connected;
  },
};

/**
 * Generate AWS Signature Version 4 headers.
 */
async function getS3Headers(
  method: string,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const { region, accessKeyId, secretAccessKey } = s3Config();
  const endpoint = s3Endpoint();
  const host = new URL(endpoint).host;
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = date.substring(0, 8);
  const contentHash = await hashSHA256(body);

  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${contentHash}\nx-amz-date:${date}\n`;

  const canonicalRequest = [
    method,
    path,
    '', // query string
    canonicalHeaders,
    signedHeaders,
    contentHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    credentialScope,
    await hashSHA256(canonicalRequest),
  ].join('\n');

  // Derive signing key: HMAC chain
  const kDate = await hmacSHA256(
    new TextEncoder().encode(`AWS4${secretAccessKey}`),
    dateStamp,
  );
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, 's3');
  const kSigning = await hmacSHA256(kService, 'aws4_request');

  const signatureBytes = await hmacSHA256(kSigning, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    'x-amz-date': date,
    'x-amz-content-sha256': contentHash,
    Host: host,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * HMAC-SHA256 using Web Crypto API.
 */
async function hmacSHA256(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

/**
 * Hash content with SHA256.
 */
async function hashSHA256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
