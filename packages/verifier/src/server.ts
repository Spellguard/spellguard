// SPDX-License-Identifier: Apache-2.0

/**
 * Node.js bootstrap for the Verifier.
 *
 * Loads env, runs the init sequence (session keys, logging backends,
 * management integration, admin keys), creates a nonce store (SQLite
 * or DynamoDB), builds the Hono app via `createVerifierApp()`, starts
 * an HTTP listener with `@hono/node-server`, and registers signal
 * handlers for graceful shutdown.
 *
 * All route handlers live in `./app.ts` and are shared across any other
 * runtime that imports the same factory.
 */

import * as fs from 'node:fs';
import 'dotenv/config';
import { serve } from '@hono/node-server';

import {
  destroySessionKeys,
  generateAttestationDocument,
  generateSessionKeys,
  getSessionPublicKey,
} from '@spellguard/ctls';

import { getBackendConfig, initLoggingBackends } from '@spellguard/amp';

import { initAdminKeys } from './admin-auth';
import { createVerifierApp } from './app';
import { getExpectedImageHash } from './attestation/document';
import { initManagementPublicKey } from './auth/management-jwt';
import { initManagementEncryptionKey } from './crypto/management-encrypt';
import {
  initManagementReporter,
  stopManagementReporter,
} from './management/reporter';
import { signRequest } from './management/request-signer';
import type { NonceStore } from './nonce-store';
import { createNonceStore } from './nonce-store';
import type { createDynamoDBNonceStore as CreateDDBNonceStoreFn } from './nonce-store-dynamodb';
import { resolveExternalUrl } from './platform/resolve-url';
import { startRateLimiterCleanup } from './proxy/engine-registry';

// ═══════════════════════════════════════════════════════════════════
// Nonce store (SQLite by default; DynamoDB for Nitro)
// ═══════════════════════════════════════════════════════════════════

let nonceStore: NonceStore | null = null;

function getNonceStore(): NonceStore {
  if (!nonceStore) {
    const platform = process.env.VERIFIER_PLATFORM?.toLowerCase();
    if (platform === 'nitro') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./nonce-store-dynamodb') as {
        createDynamoDBNonceStore: typeof CreateDDBNonceStoreFn;
      };
      const tableName = process.env.DYNAMODB_NONCE_TABLE;
      if (!tableName) {
        throw new Error(
          'DYNAMODB_NONCE_TABLE env var is required when VERIFIER_PLATFORM=nitro',
        );
      }
      nonceStore = mod.createDynamoDBNonceStore(tableName);
    } else {
      const dbPath = process.env.VERIFIER_NONCE_DB_PATH || './data/nonces.db';
      if (dbPath !== ':memory:') {
        const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
        if (dir && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      nonceStore = createNonceStore(dbPath);
    }
  }
  return nonceStore;
}

// ═══════════════════════════════════════════════════════════════════
// Management Registration
// ═══════════════════════════════════════════════════════════════════

/**
 * Register this Verifier instance with the management server.
 *
 * Two-phase in production (non-mock) mode:
 *   Phase 1: Register immediately with 'self-attested' so the Verifier
 *            is functional (serves requests, reports logs, signs with
 *            session key).
 *   Phase 2: Background retry loop generates a real TDX attestation
 *            report via dstack and re-registers. Management upgrades
 *            trust once hardware attestation is verified.
 *
 * In mock mode, only phase 1 runs (self-attested is the final state).
 */
function registerWithManagement(externalUrl: string): void {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!managementUrl) return;

  const verifierId = process.env.VERIFIER_ID || 'verifier-local-dev';
  const region = process.env.VERIFIER_REGION || 'us';
  const publicKey = getSessionPublicKey() || 'pending';
  const isMockMode = process.env.VERIFIER_MOCK_MODE === 'true';

  let imageHash: string | undefined;
  try {
    imageHash = getExpectedImageHash();
  } catch {
    // VERIFIER_IMAGE_HASH not set — leave undefined
  }

  const platform = process.env.VERIFIER_PLATFORM?.toLowerCase();
  const isInternalMode = platform === 'internal';

  function buildBody(
    attestationReport: string,
    platformAttestation?: { provider: string; token: string },
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      verifierId,
      url: externalUrl,
      region,
      publicKey,
      capabilities: [
        'bilateral-attestation',
        'dsl-policies',
        'external-checkers',
      ],
      maxConnections: 100,
      attestationReport,
      imageHash,
    };
    if (platform === 'nitro') {
      body.attestationType = 'nitro';
    } else if (isInternalMode) {
      body.attestationType = 'internal';
      if (platformAttestation) {
        body.platformAttestation = platformAttestation;
      }
    }
    return body;
  }

  async function sendRegistration(
    attestationReport: string,
    platformAttestation?: { provider: string; token: string },
  ): Promise<boolean> {
    const body = buildBody(attestationReport, platformAttestation);
    const bodyStr = JSON.stringify(body);
    const headers = await signRequest(bodyStr);
    const res = await fetch(`${managementUrl}/v1/internal/verifiers/register`, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '');
      console.warn(
        `[Verifier] Registration rejected: ${res.status} ${res.statusText} — ${responseBody.slice(0, 500)}`,
      );
    }
    return res.ok;
  }

  // ── Heartbeat — keeps Verifier status 'online' and auto-heals 'degraded' ──
  const HEARTBEAT_INTERVAL_MS = 30_000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  async function sendHeartbeat(): Promise<void> {
    const body = JSON.stringify({
      currentConnections: 0,
      loadScore: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      timestamp: Date.now(),
      signature: 'heartbeat',
    });
    const headers = await signRequest(body);
    const res = await fetch(
      `${managementUrl}/v1/internal/verifiers/${encodeURIComponent(verifierId)}/heartbeat`,
      { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) },
    );

    if (res.status === 401) {
      console.warn(
        '[Verifier] Heartbeat got 401 — Verifier not registered. Re-registering...',
      );
      attemptInitialRegistration(0);
    }
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      sendHeartbeat().catch((err) => {
        console.warn(`[Verifier] Heartbeat failed: ${err}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
    console.log(
      `[Verifier] Heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`,
    );
  }

  // ── Phase 1: Register immediately (self-attested or with platform token) ──
  const maxRetries = 5;
  const baseDelay = 2000;

  function attemptInitialRegistration(retryCount: number): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    const registrationPromise = isInternalMode
      ? import('./platform/resolve-identity-token')
          .then((mod) => mod.resolveIdentityToken())
          .then((identityToken) => {
            if (identityToken) {
              return sendRegistration('self-attested', identityToken);
            }
            return sendRegistration('self-attested');
          })
      : sendRegistration('self-attested');

    registrationPromise
      .then((ok) => {
        if (ok) {
          const mode = isInternalMode ? 'internal' : 'self-attested';
          console.log(
            `[Verifier] Registered with management as ${verifierId} (${mode})`,
          );
          startHeartbeat();
          if (!isMockMode && !isInternalMode) {
            scheduleAttestationUpgrade();
          }
        } else if (retryCount < maxRetries) {
          const delay = baseDelay * 2 ** retryCount;
          console.warn(
            `[Verifier] Initial registration failed, retrying in ${delay / 1000}s...`,
          );
          setTimeout(() => attemptInitialRegistration(retryCount + 1), delay);
        } else {
          console.warn(
            `[Verifier] Initial registration failed after ${maxRetries} retries`,
          );
          startHeartbeat();
          if (!isMockMode && !isInternalMode) {
            scheduleAttestationUpgrade();
          }
        }
      })
      .catch((err) => {
        if (retryCount < maxRetries) {
          const delay = baseDelay * 2 ** retryCount;
          console.warn(
            `[Verifier] Could not reach management server, retrying in ${delay / 1000}s... (${err})`,
          );
          setTimeout(() => attemptInitialRegistration(retryCount + 1), delay);
        } else {
          console.warn(
            `[Verifier] Could not register after ${maxRetries} retries: ${err}`,
          );
          startHeartbeat();
          if (!isMockMode && !isInternalMode) {
            scheduleAttestationUpgrade();
          }
        }
      });
  }

  // ── Phase 2: Upgrade to hardware attestation (background retry) ──
  const ATTESTATION_TIMEOUT_MS = 15000;
  const ATTESTATION_RETRY_INTERVAL_MS = 30000;
  const ATTESTATION_MAX_ATTEMPTS = 20;

  function scheduleAttestationUpgrade(): void {
    let attempts = 0;

    async function tryAttestation(): Promise<void> {
      attempts++;
      try {
        const nonce = crypto.randomUUID();
        const doc = await Promise.race([
          generateAttestationDocument(nonce),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `dstack attestation timed out after ${ATTESTATION_TIMEOUT_MS}ms`,
                  ),
                ),
              ATTESTATION_TIMEOUT_MS,
            ),
          ),
        ]);

        if (doc.imageHash) {
          imageHash = doc.imageHash;
        }

        const ok = await sendRegistration(doc.hardwareSignature);
        if (ok) {
          console.log(
            `[Verifier] Attestation upgrade complete — registered with hardware attestation (attempt ${attempts})`,
          );
          return;
        }
        console.warn(
          `[Verifier] Attestation registration rejected by management (attempt ${attempts})`,
        );
      } catch (err) {
        console.warn(
          `[Verifier] Attestation upgrade attempt ${attempts}/${ATTESTATION_MAX_ATTEMPTS} failed: ${err}`,
        );
      }

      if (attempts < ATTESTATION_MAX_ATTEMPTS) {
        setTimeout(tryAttestation, ATTESTATION_RETRY_INTERVAL_MS);
      } else {
        console.error(
          `[Verifier] Attestation upgrade failed after ${ATTESTATION_MAX_ATTEMPTS} attempts — Verifier remains self-attested`,
        );
      }
    }

    setTimeout(tryAttestation, 5000);
  }

  attemptInitialRegistration(0);
}

// ═══════════════════════════════════════════════════════════════════
// Server Startup
// ═══════════════════════════════════════════════════════════════════

async function startServer() {
  console.log('[Verifier] Initializing...');

  // Nitro Enclave: configure outbound HTTP proxy.
  if (
    process.env.VERIFIER_PLATFORM?.toLowerCase() === 'nitro' &&
    process.env.HTTPS_PROXY
  ) {
    try {
      const { ProxyAgent, setGlobalDispatcher } = await import('undici');
      setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY));
      console.log(
        `[Verifier] Nitro outbound proxy configured: ${process.env.HTTPS_PROXY}`,
      );
    } catch (err) {
      console.warn(
        `[Verifier] Failed to configure Nitro outbound proxy: ${err}`,
      );
    }
  }

  // Generate ephemeral session keys (RAM-only, forward secrecy)
  await generateSessionKeys();

  // Start periodic cleanup of the shared rate limiter
  startRateLimiterCleanup();

  // Initialize logging backends
  await initLoggingBackends();

  // Initialize management encryption key for archive envelope encryption
  initManagementEncryptionKey();

  // Initialize management reporter (if MANAGEMENT_URL is configured)
  initManagementReporter();

  // Initialize management public key for JWT verification
  await initManagementPublicKey();

  // SG-02/10: Initialize admin signing key ring
  initAdminKeys();

  const trustProxy =
    process.env.VERIFIER_TRUST_PROXY === 'true' ||
    process.env.VERIFIER_TRUST_PROXY === '1';
  if (!trustProxy) {
    console.warn(
      '[Verifier] VERIFIER_TRUST_PROXY is disabled; admin-evaluate IP handling uses local fallback.',
    );
  }

  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || 'localhost';

  // Resolve external URL (auto-detect on Phala, fallback to host:port)
  let externalUrl: string;
  try {
    externalUrl = await resolveExternalUrl(host, port);
  } catch (err) {
    console.warn(`[Verifier] External URL resolution failed: ${err}`);
    externalUrl = `http://${host}:${port}`;
  }

  // Build the Hono app via the shared factory
  const app = createVerifierApp({
    nonceStore: getNonceStore(),
    getUptime: () => process.uptime(),
  });

  // Register this Verifier with the management server (non-blocking)
  registerWithManagement(externalUrl);

  console.log(`[Verifier] Starting server on ${host}:${port}`);

  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  const config = getBackendConfig();
  console.log(`[Verifier] Server running at http://${host}:${port}`);
  console.log(
    `[Verifier] Mock mode: ${process.env.VERIFIER_MOCK_MODE === 'true'}`,
  );
  console.log(
    `[Verifier] Platform: ${process.env.VERIFIER_PLATFORM || 'default (phala)'}`,
  );
  if (process.env.VERIFIER_PLATFORM?.toLowerCase() === 'internal') {
    console.log('[Verifier] Internal mode: intra-org traffic only');
    console.log(
      `[Verifier] Identity provider: ${process.env.VERIFIER_IDENTITY_PROVIDER || 'none'}`,
    );
  }
  console.log(`[Verifier] Commitment backend: ${config.commitmentBackend}`);
  console.log(`[Verifier] Archive backend: ${config.archiveBackend}`);

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Verifier] Shutting down...');
    await stopManagementReporter();
    if (nonceStore) nonceStore.close();
    destroySessionKeys();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Verifier] Terminating...');
    await stopManagementReporter();
    if (nonceStore) nonceStore.close();
    destroySessionKeys();
    process.exit(0);
  });
}

startServer().catch((error) => {
  console.error('[Verifier] Failed to start:', error);
  process.exit(1);
});
