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
import {
  getActiveProfile,
  initProfile,
  setDirectoryOverride,
} from './profile/registry';
// Node-only: GrpcDirDirectory imports the agntcy-dir SDK (@grpc/grpc-js,
// connect-node), which can't be bundled for the Workers verifier. server.ts is
// the Node entrypoint and is never bundled for Workers, so importing it here is
// safe — and keeps it out of app.ts/router.ts/registry.ts (which are).
import { GrpcDirDirectory } from './slim/dir-directory';

import {
  decodeRequest,
  encodeResponse,
  responseToWire,
  wireToRequest,
} from '@spellguard/gateway/wire';
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
import { installSelfRecycleGuard } from './recycle-guard';
import { type SlimEndpointHandle, startSlimEndpoint } from './slim/endpoint';
import { type LivenessHandle, startLivenessResponder } from './slim/liveness';
import { type RosterSyncHandle, startRosterSync } from './slim/roster-sync';

// ═══════════════════════════════════════════════════════════════════
// Nonce store (SQLite by default; DynamoDB for Nitro)
// ═══════════════════════════════════════════════════════════════════

let nonceStore: NonceStore | null = null;
let slimEndpoint: SlimEndpointHandle | null = null;
let rosterSync: RosterSyncHandle | null = null;
let livenessResponder: LivenessHandle | null = null;

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
    // In agntcy mode the agent-facing URL is the gateway's, not this
    // Verifier's own. AgntcyVerifierStack sets SPELLGUARD_AGENT_URL to
    // the gateway hostname; we use that if present, otherwise fall
    // back to externalUrl (which IS the agent-facing URL in original
    // mode where this Verifier serves agents directly).
    const agentFacingUrl =
      process.env.SPELLGUARD_AGENT_URL?.trim() || externalUrl;
    const body: Record<string, unknown> = {
      verifierId,
      // `url` is the legacy field, kept as a write-through alias of
      // agentUrl for one release so old management readers continue
      // to work. Both point at the agent-facing URL.
      url: agentFacingUrl,
      agentUrl: agentFacingUrl,
      // internalUrl is always the Verifier's own resolved URL —
      // management uses this for direct RPC (config polling, etc.)
      // bypassing the slim gateway.
      internalUrl: externalUrl,
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
    // Surface the active profile + transport so the dashboard can
    // render an AGNTCY/Original badge per Verifier. getActiveProfile()
    // returns the bundle initProfile loaded at startup. NULL stays
    // valid on the management side — we just won't be able to render
    // the badge if this Verifier predates the column.
    const bundle = getActiveProfile();
    if (bundle) {
      body.profile = bundle.profile;
      body.transport = bundle.transport.name;
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
    const bundle = getActiveProfile();
    const body = JSON.stringify({
      currentConnections: 0,
      loadScore: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      timestamp: Date.now(),
      signature: 'heartbeat',
      // Echo profile/transport on every heartbeat so the dashboard
      // picks up post-deploy profile flips without waiting for a
      // re-registration.
      profile: bundle?.profile,
      transport: bundle?.transport.name,
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

  // In agntcy mode, inject the real AGNTCY dir gRPC client before resolving the
  // profile. SPELLGUARD_DIR_URL is http-shaped for back-compat; the gRPC SDK
  // wants a bare host:port, so strip the scheme. (Injected here, not in
  // registry.ts, so the Node-only agntcy-dir import never reaches the Workers
  // verifier bundle.)
  if ((process.env.SPELLGUARD_PROFILE ?? '').toLowerCase() === 'agntcy') {
    const dirServerAddress = (
      process.env.SPELLGUARD_DIR_URL ?? 'http://localhost:8888'
    ).replace(/^https?:\/\//, '');
    setDirectoryOverride(new GrpcDirDirectory(dirServerAddress));
  }

  // Resolve the active profile (original | agntcy). Cached in the singleton
  // so the router and discovery code can read it via getActiveProfile().
  // Under the `original` profile the existing HTTP / CTLS code paths
  // remain authoritative; the bundle is only consumed when profile=agntcy.
  const profileBundle = initProfile(process.env);
  console.log(
    `[Verifier] Profile: ${profileBundle.profile} (transport=${profileBundle.transport.name}, directory=${profileBundle.directory.name}, identity=${profileBundle.identity.name})`,
  );

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
    // /ready reflects SLIM listener liveness. slimEndpoint is assigned
    // below (slim profile only); the closure reads it by reference, so by
    // the time a probe arrives it's populated. Non-slim profiles never set
    // it, so /ready reports ready (no SLIM dependency).
    getSlimReady: () => (slimEndpoint ? slimEndpoint.isReady() : true),
  });

  // Register this Verifier with the management server (non-blocking)
  registerWithManagement(externalUrl);

  console.log(`[Verifier] Starting server on ${host}:${port}`);

  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  // SLIM endpoint — only spun up when the Verifier is running under the
  // `agntcy` profile. The gateway (on a separate EC2 host) forwards each
  // agent HTTP request as a SLIM message containing a wire-encoded
  // fetch Request envelope; we decode, hand it to the existing Hono app
  // for routing through the full /proxy/forward path, and serialise the
  // Response back as the SLIM reply.
  if (profileBundle.profile === 'agntcy') {
    slimEndpoint = await startSlimEndpoint(
      {
        controlPlaneUrl:
          process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357',
        listenName: {
          org: process.env.SPELLGUARD_SLIM_ORG ?? 'spellguard',
          namespace: process.env.SPELLGUARD_SLIM_NAMESPACE ?? 'verifier',
          agent: process.env.SPELLGUARD_SLIM_AGENT ?? 'server',
        },
        sharedSecret:
          process.env.SLIM_SHARED_SECRET ??
          'spellguard-dev-shared-secret-needs-at-least-32-bytes',
        // How long the SLIM listener waits for THIS verifier's inbound
        // handler (app.fetch → route → deliver to the destination agent,
        // which may run an LLM) to produce a reply. Defaults to 30s in
        // endpoint.ts, but LLM-bearing /messages/send routes run ~34-120s
        // (observed 34s live) — at 30s the listener abandoned the reply
        // ("parent reply timed out after 30000ms") while the gateway was
        // still waiting its 120s, so the delivery deterministically failed.
        // Match the gateway's LLM reply budget (120s) so the verifier
        // doesn't give up first; stays under the 150s ALB idle timeout.
        replyTimeoutMs:
          Number(process.env.SPELLGUARD_VERIFIER_SLIM_REPLY_TIMEOUT_MS) ||
          120_000,
      },
      async (message) => {
        const wireRequest = decodeRequest(message.payload);
        const synthOrigin = `http://${host}:${port}`;
        const request = wireToRequest(wireRequest, synthOrigin);
        let response: Response;
        try {
          response = await app.fetch(request);
        } catch (err) {
          response = new Response(
            JSON.stringify({
              error: 'verifier-fetch-failed',
              message: (err as Error).message,
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
        const wireResponse = await responseToWire(response);
        return encodeResponse(wireResponse);
      },
    );
    console.log(
      `[Verifier] SLIM endpoint started (control plane ${process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357'})`,
    );

    // Off-main-loop liveness responder. The ALB target group health-checks
    // THIS port (not the main /ready on :3000), so a busy-but-alive
    // verifier under concurrent SLIM load is no longer ECS-recycled when
    // the main loop's TCP accept stalls past the health-check timeout —
    // the root cause of the staging recycle/cascade. /ready here is 200
    // iff the main-loop heartbeat is fresh AND the SLIM listener is up.
    const livenessPort =
      Number(process.env.SPELLGUARD_VERIFIER_LIVENESS_PORT) || 3001;
    // Self-heal thresholds (env-tunable so staging can be tuned without a
    // rebuild). A persistently saturated loop — event-loop delay above
    // SATURATION_LAG_MS for SATURATION_SUSTAINED_MS — fails /ready so ECS
    // recycles the wedged task. Defaults are conservative: a healthy loop
    // sits well under 250ms mean delay, and 45s of sustained saturation is
    // far longer than any legitimate scenario burst.
    livenessResponder = startLivenessResponder({
      port: livenessPort,
      saturationLagMs:
        Number(process.env.SPELLGUARD_VERIFIER_SATURATION_LAG_MS) || 250,
      saturationSustainedMs:
        Number(process.env.SPELLGUARD_VERIFIER_SATURATION_SUSTAINED_MS) ||
        45_000,
      isSlimReady: () => (slimEndpoint ? slimEndpoint.isReady() : false),
      log: (level, msg) =>
        level === 'error'
          ? console.error(`[Verifier] liveness: ${msg}`)
          : console.log(`[Verifier] liveness: ${msg}`),
    });
    console.log(
      `[Verifier] off-loop liveness responder on :${livenessPort} (ALB health-checks this, not :${port})`,
    );

    // Roster pre-sync (managed slim only): warm the gateway's subscriptions for
    // every agent up front + on a timer, so verifier→agent SLIM delivery never
    // races a cold subscription in the message hot path (the cold-start that
    // blew the demo's per-scenario time budget). No-op without MANAGEMENT_URL —
    // no-Management agents self-register eagerly via createSpellguard.
    rosterSync = startRosterSync({
      intervalMs:
        Number(process.env.SPELLGUARD_VERIFIER_ROSTER_SYNC_MS) || 120_000,
      log: (level, msg) =>
        level === 'error' ? console.error(msg) : console.log(msg),
    });
    void rosterSync.primed
      .then(() => console.log('[Verifier] roster pre-sync primed'))
      .catch(() => undefined);
  }

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

  // Memory observability. The verifier OOM-recycles ~every 30 min under demo
  // load; forensics point to a NATIVE leak in the @agntcy/slim bindings (the
  // verifier drives them in worker threads that share the process RSS) — the
  // gateway, same bindings, leaks RSS while its JS heap stays flat. Logging
  // process.memoryUsage() periodically lets the next run tell them apart from
  // the verifier's own CloudWatch log (no ECS exec / Container Insights):
  //   heapUsed/heapTotal climb            → JS-heap leak (heap snapshot is actionable)
  //   rss/external/arrayBuffers climb,
  //     heapUsed flat                      → native bindings leak (upstream / bounded pool)
  // Gated behind an env so the interval can be tuned (0 disables).
  const memLogMs = Number(process.env.SPELLGUARD_VERIFIER_MEM_LOG_MS) || 30_000;
  const memTimer =
    memLogMs > 0
      ? setInterval(() => {
          const m = process.memoryUsage();
          const mb = (n: number) => Math.round(n / 1048576);
          console.log(
            `[Verifier] memoryUsage rss=${mb(m.rss)}MB heapTotal=${mb(m.heapTotal)}MB ` +
              `heapUsed=${mb(m.heapUsed)}MB external=${mb(m.external)}MB ` +
              `arrayBuffers=${mb(m.arrayBuffers)}MB uptime=${Math.round(process.uptime())}s`,
          );
        }, memLogMs)
      : null;
  memTimer?.unref();

  // Proactive self-recycle: the @agntcy/slim native-RSS leak (above) OOM-kills
  // the verifier mid-tick. Instead, exit(0) cleanly once RSS crosses a
  // watermark while no delivery is in flight, so ECS restarts the task in an
  // IDLE gap rather than via a hard SIGKILL. Disabled by default (0); the
  // agntcy verifier sets SPELLGUARD_VERIFIER_RSS_RECYCLE_MB=4096 (~2GB of
  // headroom below its 6144MB container cap — enough to absorb the fast
  // end-stage climb the soak showed). The listener's session teardown reclaims
  // most of the leak; this is the backstop for whatever still slips through.
  const recycleTimer = installSelfRecycleGuard({
    rssLimitMb: Number(process.env.SPELLGUARD_VERIFIER_RSS_RECYCLE_MB) || 0,
    intervalMs: memLogMs > 0 ? memLogMs : 30_000,
  });

  // Crash safety. The verifier runs ~65s LLM-bearing app.fetch on the
  // main event loop; an uncaught exception must not leave a half-dead
  // process that still answers /health (200, local) — exit so ECS
  // replaces the task. unhandledRejection is logged loudly but not fatal,
  // to avoid killing the process on a stray background rejection. (A
  // native Rust panic in the bindings aborts the process directly and
  // bypasses these — the SLIM worker supervisor + /ready cover that.)
  process.on('uncaughtException', (err) => {
    console.error('[Verifier] uncaughtException — exiting:', err);
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Verifier] unhandledRejection:', reason);
  });

  // Cleanup on shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Verifier] Shutting down...');
    if (memTimer) clearInterval(memTimer);
    if (recycleTimer) clearInterval(recycleTimer);
    if (rosterSync) rosterSync.stop();
    if (slimEndpoint) slimEndpoint.shutdown();
    if (livenessResponder) livenessResponder.stop();
    await stopManagementReporter();
    if (nonceStore) nonceStore.close();
    destroySessionKeys();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Verifier] Terminating...');
    if (memTimer) clearInterval(memTimer);
    if (recycleTimer) clearInterval(recycleTimer);
    if (rosterSync) rosterSync.stop();
    if (slimEndpoint) slimEndpoint.shutdown();
    if (livenessResponder) livenessResponder.stop();
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
