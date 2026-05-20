// SPDX-License-Identifier: Apache-2.0

/**
 * Generate real v2 archive files for the two test audit log entries
 * and upload them to local MinIO.
 *
 * Run from repo root:
 *   node --experimental-vm-modules scripts/seed-test-archives.mjs
 * Or:
 *   node scripts/seed-test-archives.mjs
 */

import { createHash, randomBytes } from 'node:crypto';
import { createHmac } from 'node:crypto';

// ── Noble imports (from packages/verifier) ────────────────────────────────────────
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const verifierModules = resolve(
  __dirname,
  '..',
  'packages',
  'verifier',
  'node_modules',
);

const { gcm } = await import(`${verifierModules}/@noble/ciphers/aes.js`);
const { ed25519, x25519 } = await import(
  `${verifierModules}/@noble/curves/ed25519.js`
);
const { hkdf } = await import(`${verifierModules}/@noble/hashes/hkdf.js`);
const { sha256 } = await import(`${verifierModules}/@noble/hashes/sha256.js`);

// ── Management public key (Ed25519 SPKI PEM) ──────────────────────────────────
const MANAGEMENT_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA84eUgDiPwJcF2ED72Kw4vPOFjzQH5AHURU8jq7iV808=\n-----END PUBLIC KEY-----';

const VERSION_V2 = 0x02;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const HKDF_INFO_V2 = 'spellguard-archive-v1';
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

// ── Helpers ───────────────────────────────────────────────────────────────────

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function extractEd25519PublicKey(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = base64ToBytes(b64);
  const derHex = bytesToHex(der);
  const idx = derHex.indexOf(ED25519_SPKI_PREFIX);
  if (idx === -1) throw new Error('Not a valid Ed25519 SPKI public key');
  return hexToBytes(
    derHex.slice(
      idx + ED25519_SPKI_PREFIX.length,
      idx + ED25519_SPKI_PREFIX.length + 64,
    ),
  );
}

function encryptV2(plaintext, recipientX25519PubKey) {
  const payloadBytes = new TextEncoder().encode(plaintext);

  const ephemeralPrivateKey = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  const sharedSecret = x25519.getSharedSecret(
    ephemeralPrivateKey,
    recipientX25519PubKey,
  );

  const aesKey = hkdf(
    sha256,
    sharedSecret,
    undefined,
    HKDF_INFO_V2,
    KEY_LENGTH,
  );

  const nonce = new Uint8Array(randomBytes(NONCE_LENGTH));
  const cipher = gcm(aesKey, nonce);
  const ciphertext = cipher.encrypt(payloadBytes);

  const result = new Uint8Array(1 + 32 + NONCE_LENGTH + ciphertext.length);
  result[0] = VERSION_V2;
  result.set(ephemeralPublicKey, 1);
  result.set(nonce, 33);
  result.set(ciphertext, 33 + NONCE_LENGTH);

  return bytesToBase64(result);
}

// ── S3/MinIO upload via SigV4 ─────────────────────────────────────────────────

const S3_ENDPOINT = 'http://localhost:9100';
const S3_BUCKET = 'spellguard-messages';
const S3_REGION = 'us-east-1';
const S3_ACCESS_KEY = 'minioadmin';
const S3_SECRET_KEY = 'minioadmin';

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function getSignatureKey(key, dateStamp, region, service) {
  const kDate = hmacSha256(`AWS4${key}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

async function s3Put(key, body, contentType = 'application/json') {
  const now = new Date();
  const amzDate = `${now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '')
    .slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);

  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payloadHash = sha256Hex(bodyBuf);

  const host = new URL(S3_ENDPOINT).host;
  const url = `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;

  const headers = {
    'content-type': contentType,
    host: host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaderNames = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h]}\n`)
    .join('');

  const canonicalRequest = [
    'PUT',
    `/${S3_BUCKET}/${key}`,
    '',
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(S3_SECRET_KEY, dateStamp, S3_REGION, 's3');
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...headers,
      Authorization: authHeader,
      'content-length': String(bodyBuf.length),
    },
    body: bodyBuf,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 PUT failed: ${res.status} ${text}`);
  }
  return res.status;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const ed25519PubKey = extractEd25519PublicKey(MANAGEMENT_PUBLIC_KEY_PEM);
  const x25519PubKey = ed25519.utils.toMontgomery(ed25519PubKey);

  const archives = [
    {
      ref: 'archive-ref-v3-001',
      envelope: {
        sender: 'agent-a',
        recipient: 'agent-b',
        content: 'Hello from agent-a! Can you help me with a task?',
        timestamp: new Date('2026-04-06T12:00:00Z').toISOString(),
        direction: 'outbound',
        attestationLevel: 'verifier',
      },
    },
    {
      ref: 'archive-ref-v3-002',
      envelope: {
        sender: 'agent-b',
        recipient: 'agent-a',
        content: JSON.stringify({
          type: 'response',
          text: 'Sure! Here is the sensitive data you requested: SSN 123-45-6789.',
        }),
        timestamp: new Date('2026-04-06T12:00:01Z').toISOString(),
        direction: 'inbound',
        attestationLevel: 'verifier',
      },
    },
  ];

  for (const { ref, envelope } of archives) {
    const plaintext = JSON.stringify(envelope);
    const encryptedEnvelope = encryptV2(plaintext, x25519PubKey);
    const archiveJson = JSON.stringify({ encryptedEnvelope });
    const s3Key = `spellguard/archive/${ref}.json`;

    console.log(`Uploading ${s3Key} ...`);
    const status = await s3Put(s3Key, archiveJson);
    console.log(`  → ${status} OK`);
  }

  console.log('\nDone! Archive files created in MinIO.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
