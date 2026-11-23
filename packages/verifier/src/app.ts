// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier Hono app factory.
 *
 * Exports `createVerifierApp(options)` which returns a fully-wired Hono
 * application with all Verifier routes (health, attestation, agents,
 * messages, admin/evaluate, tools/check, mcp/evaluate, mcp/tools, channels, stats,
 * internal test routes).
 *
 * The Node.js server (`server.ts`) and any alternate runtime (e.g. an
 * edge/worker deployment) import this factory — there is no drift
 * between deployments because they share this implementation.
 *
 * Runtime-specific plumbing (HTTP server, stateful container, nonce
 * store backends, signal handlers, uptime reporting) is passed in via
 * the options object.
 */

import {
  type Evidence,
  generateAttestationDocument,
  getAgent,
  getAgentByToken,
  getAllAgents,
  getSessionPublicKey,
  isAgentRegistered,
  registerAgent,
  rotateChannelToken,
  verifyEvidence,
} from '@spellguard/ctls';

import {
  type AuditCommitment,
  type SecureMessage,
  getAllCommitments,
  getArchiveCount,
  getBackendConfig,
  getChannelStats,
  getCommitmentBackendName,
  getCommitmentCount,
  isArchiveBackendConnected,
  isCommitmentBackendConnected,
  verifyCommitmentExists,
} from '@spellguard/amp';

import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { verifyAdminSignature } from './admin-auth';
import {
  type AdminEvaluateError,
  adminEvaluateCommitmentHash,
  checkReplayDefensePersistent,
  getRequesterIp,
  parseAdminEvaluateRequest,
  sanitizeEvaluationSummary,
  selectAdminEvaluateBindings,
} from './admin-evaluate';
import { verifyAndExtractAgentPublicKey } from './auth/management-jwt';
import { hashPayload } from './crypto/commitment';
import { resolveAgentCard } from './discovery/resolver';
import {
  getAgentPolicies,
  invalidateAgentPolicies,
} from './management/policy-cache';
import {
  flushReporterBuffer,
  getAuditEventBuffer,
  reportBilateralEvent,
} from './management/reporter';
import { signRequest } from './management/request-signer';
import { getUsageReporterStats } from './management/usage-reporter';
import { getIdentityStats } from './management/verify-agent-cache';
import type { NonceStore } from './nonce-store';
import { getActiveProfile } from './profile/registry';
import { handleContentEvaluate } from './proxy/content-evaluate';
import {
  handleQuarantine,
  resolveResponseLevel,
  shouldQuarantineFromChecks,
} from './proxy/effect-handlers';
import { getSharedRateLimiter } from './proxy/engine-registry';
import { handleLlmChatCompletions } from './proxy/llm-gateway';
import { handleMcpEvaluate, handleMcpTools } from './proxy/mcp-evaluate';
import {
  NODE_MAX_MESSAGE_BODY_BYTES,
  formatMegabytes,
} from './proxy/message-body-limit';
import {
  evaluatePolicies,
  evaluateToolCallPolicies,
  filterByScope,
} from './proxy/policy-evaluator';
import { buildQuarantineReason } from './proxy/policy-helpers';
import { generateMessageId, routeMessage } from './proxy/router';
import {
  DEFAULT_TOXICITY_SEMANTIC_TIMEOUT_MS,
  TOXICITY_SEMANTIC_TIMEOUT_ENV,
  getConfiguredToxicitySemanticEndpoint,
  noteToxicitySemanticEndpointHealthy,
  noteToxicitySemanticEndpointUnhealthy,
  resolveToxicitySemanticEndpoint,
  resolveToxicitySemanticHealthUrl,
} from './proxy/toxicity-semantic-endpoint';
import { routeUnilateral } from './proxy/unilateral-router';
import { signVerdictResponses } from './proxy/verdict-signing';
import { checkVisibility } from './proxy/visibility-checker';
import { judgesOutputs, toolCallOutput } from './session/agent-output';
import type { DecisionModelClient } from './session/decision-model';
import type {
  DocumentExtractor,
  DocumentReader,
} from './session/document-extractor';
import { readCorrelationId } from './session/keys';
import { deniedLabel, recordParts } from './session/recording';
import { type SessionServices, openAgentSession } from './session/runtime';
import type { SessionStore } from './session/session-store';
import {
  deriveAgentSlimName,
  ensureGatewayRegistered,
} from './slim/managed-delivery';
import { normalizeAgentUrl } from './url-normalize';

/**
 * Options passed to the factory. Lets different runtimes inject
 * runtime-specific behavior (nonce storage, uptime reporting, optional
 * registry-persistence hook).
 */
export interface VerifierAppOptions {
  /**
   * Persistent nonce store for admin-evaluate replay defense. Node uses
   * SQLite/DynamoDB; other runtimes plug in their own implementation.
   */
  nonceStore: NonceStore;

  /**
   * Returns Verifier uptime in seconds. Node uses `process.uptime()`;
   * stateless runtimes compute it from a container-start timestamp.
   */
  getUptime: () => number;

  /**
   * Optional hook called after route handlers that mutate the CTLS
   * registry (register, rotateChannelToken, etc.). Runtimes with
   * ephemeral module state use this to snapshot the registry to
   * durable storage; long-lived Node processes can omit it.
   */
  persistRegistry?: () => Promise<void> | void;

  /**
   * Whether dev-only routes (/admin/reset-rate-limits, /internal/reset-*,
   * /internal/policies/invalidate, /internal/reporter/flush, /logs/*) are
   * exposed and the rate limits are relaxed. OPT-IN: defaults to `true` only
   * when `VERIFIER_DEV_MODE=true` or `VERIFIER_MOCK_MODE=true` (local dev and
   * throwaway dev-stacks). It used to default on unless `NODE_ENV=production`,
   * and the Fargate image never set that, so the demo verifier shipped with
   * its reset/invalidate routes public and 10x rate limits (#1382).
   */
  isDevMode?: boolean;

  /**
   * Returns whether the SLIM listener worker is alive and subscribed.
   * Surfaced by the /ready readiness probe so a SLIM-dead verifier fails
   * its health check (and ECS replaces it), unlike /health which is local
   * and stays 200. Omitted by non-slim runtimes — they report ready.
   */
  getSlimReady?: () => boolean;

  /**
   * The session ledger (internal design notes). The
   * Cloudflare runtime passes its Durable Object store; local development
   * passes the in-memory store. Omitted: the session policies report
   * `session_unavailable` and act on their `failBehavior`.
   */
  sessionStore?: SessionStore;

  /**
   * Reads message attachments at the ingest gate: structure, text layer and
   * OCR, with the organization's document limits (the Cloudflare Verifier's
   * DocumentReader Durable Object). Omitted: attachments take the legacy
   * path with `documentExtractor`.
   */
  documentReader?: DocumentReader;

  /**
   * Document-to-text for message attachments on the legacy path (no
   * `documentReader`). Omitted: every attachment is recorded as unreadable
   * (`no_extractor`).
   */
  documentExtractor?: DocumentExtractor;

  /**
   * The decision model `semantic-consistency` asks. Omitted: that policy
   * acts on its `failBehavior`.
   */
  decisionModel?: DecisionModelClient;

  /**
   * The largest request body `/messages/send` and `/messages/unilateral`
   * read (#1578); a larger one is refused with 413 before it is read. The
   * Cloudflare Verifier derives it from the attachment ceiling
   * (`messageBodyLimitFor`); omitted, it is the Node Verifier's fixed bound,
   * NODE_MAX_MESSAGE_BODY_BYTES.
   */
  maxMessageBodyBytes?: number;
}

/**
 * Wait for any registry mutation hook the caller supplied. Safe to call
 * when `persistRegistry` is undefined.
 */
async function persist(options: VerifierAppOptions): Promise<void> {
  if (options.persistRegistry) {
    await options.persistRegistry();
  }
}

/**
 * Determine overall response level from accumulated policy checks.
 * Uses the 6-value priority system: block > quarantine > rate_limit >
 * redact > flag > allow.
 */
function deriveResponseLevel(
  checks: Array<{ decision: string; responseLevel: string }>,
): string {
  return resolveResponseLevel(checks.map((c) => c.responseLevel));
}

/**
 * SG-03: Read request body with byte limit for chunked requests.
 */
async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  return (
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') +
    decoder.decode()
  );
}

type MessageBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 413; message: string };

/**
 * Read a message route's JSON body, refusing one over `maxBytes` before it
 * is read: by its content-length when it declares one, while streaming it
 * otherwise. A body that is not JSON throws, as `c.req.json()` did.
 */
async function readMessageBody(
  request: Request,
  maxBytes: number,
): Promise<MessageBody> {
  const limit = formatMegabytes(maxBytes);
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isNaN(length) || length > maxBytes) {
      return {
        ok: false,
        status: 413,
        message: Number.isNaN(length)
          ? `The message body has no valid length; this Verifier accepts messages up to ${limit}.`
          : `The message is ${formatMegabytes(length)}; this Verifier accepts messages up to ${limit}.`,
      };
    }
    return { ok: true, body: JSON.parse(await request.text()) };
  }
  const text = await readBodyWithLimit(request, maxBytes);
  if (text === null) {
    return {
      ok: false,
      status: 413,
      message: `The message is larger than this Verifier accepts (up to ${limit}).`,
    };
  }
  return { ok: true, body: JSON.parse(text) };
}

/**
 * Build a Verifier Hono application wired up with all routes.
 *
 * @param options Runtime-specific dependencies (nonce store, uptime
 *   getter, optional registry-persistence hook).
 */
export function createVerifierApp(options: VerifierAppOptions): Hono {
  // ═══════════════════════════════════════════════════════════════════
  // Config (read from env at factory-call time, not module load time)
  // ═══════════════════════════════════════════════════════════════════

  const isDevMode =
    options.isDevMode ??
    (process.env.VERIFIER_DEV_MODE === 'true' ||
      process.env.VERIFIER_MOCK_MODE === 'true');

  // Protocol + payload constants
  const CURRENT_PROTOCOL_VERSION = '1.0';
  const MIN_PROTOCOL_VERSION = 1.0;
  const MAX_PAYLOAD_SIZE = 64 * 1024; // 64KB
  const HEALTH_SEMANTIC_TIMEOUT_CAP_MS = 1000;

  // Agent-registration rate limiting (#1623). Budgets are per agent, per
  // source address: every Worker-hosted agent reaches a Cloudflare Verifier
  // from the same egress address, and one demo fleet launch (eleven agents
  // registering at once) used up a budget of ten shared by the whole address,
  // so a fresh agent could not register to accept its first delivery.
  // - Registrations that proved they are the agent: 10 a minute per agent.
  // - Failed attempts to prove it (bad secret or token): 10 a minute per
  //   claimed agent, checked before management is asked. This bounds secret
  //   guessing at the old rate.
  // - Everything from one address: 300 a minute, the load ceiling.
  const RATE_LIMIT_REQUESTS = isDevMode ? 100 : 10;
  const RATE_LIMIT_FAILED_REQUESTS = RATE_LIMIT_REQUESTS;
  const RATE_LIMIT_ADDRESS_REQUESTS = 30 * RATE_LIMIT_REQUESTS;
  const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
  // Past this many windows, the oldest is dropped to make room.
  const RATE_LIMIT_MAX_WINDOWS = 100_000;

  // Admin-evaluate rate limiting (SG-06). Raise the per-IP and global
  // budgets in dev so integration suites that fire 20+ requests from a
  // single origin (admin-chat-verifier.integration.test.ts) don't trip
  // the limiter — matches the agent-registration dev/prod pattern above.
  const ADMIN_RATE_LIMIT_PER_IP =
    Number(process.env.VERIFIER_ADMIN_RATE_LIMIT) || (isDevMode ? 500 : 30);
  const ADMIN_AUTH_FAIL_LIMIT =
    Number(process.env.VERIFIER_ADMIN_AUTH_FAIL_LIMIT) || (isDevMode ? 100 : 5);
  const ADMIN_GLOBAL_RATE_LIMIT =
    Number(process.env.VERIFIER_ADMIN_GLOBAL_RATE_LIMIT) ||
    (isDevMode ? 2000 : 100);
  const ADMIN_RATE_WINDOW_MS = 60_000;

  // SG-09: Nonce TTL for admin-evaluate replay defense
  const NONCE_TTL_MS = 10 * 60 * 1000;

  // SG-06: Only trust proxy headers when explicitly enabled
  const TRUST_PROXY =
    process.env.VERIFIER_TRUST_PROXY === 'true' ||
    process.env.VERIFIER_TRUST_PROXY === '1';

  // ═══════════════════════════════════════════════════════════════════
  // Per-app state (rate limit buckets live inside the closure so each
  // factory call gets its own — tests can create isolated instances)
  // ═══════════════════════════════════════════════════════════════════

  // The body bound on the message routes (#1578).
  const maxMessageBodyBytes =
    options.maxMessageBodyBytes ?? NODE_MAX_MESSAGE_BODY_BYTES;

  /** Refuse an oversized message body, naming the sender in the log. */
  const refuseMessageBody = (
    c: Context,
    channelToken: string,
    route: string,
    message: string,
  ) => {
    const agentId = getAgentByToken(channelToken)?.agentId ?? 'unknown agent';
    console.warn(`[Verifier] ${route} refused for ${agentId}: ${message}`);
    return c.json({ error: message, code: 'PAYLOAD_TOO_LARGE' }, 413);
  };

  // The session ledger's runtime services, handed to the legs that use them.
  const sessionServices: SessionServices = {
    store: options.sessionStore,
    documentReader: options.documentReader,
    documentExtractor: options.documentExtractor,
    decisionModel: options.decisionModel,
  };

  const registrationCounts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  const adminIpBuckets = new Map<string, { count: number; resetAt: number }>();
  const adminAuthFailBuckets = new Map<
    string,
    { count: number; resetAt: number }
  >();
  const adminGlobalBucket = { count: 0, resetAt: 0 };

  // SG-06: Cleanup timer for rate limit buckets (every 5 min).
  // setInterval is invoked from inside the factory call, so runtimes
  // that disallow module-level timers still accept it here.
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    sweepRegistrationWindows(now);
    for (const [ip, b] of adminIpBuckets) {
      if (now > b.resetAt) adminIpBuckets.delete(ip);
    }
    for (const [ip, b] of adminAuthFailBuckets) {
      if (now > b.resetAt) adminAuthFailBuckets.delete(ip);
    }
  }, 5 * 60_000);
  if (typeof cleanupInterval === 'object' && 'unref' in cleanupInterval) {
    (cleanupInterval as { unref: () => void }).unref();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers that close over app-level state
  // ═══════════════════════════════════════════════════════════════════

  /**
   * The registration address a caller cannot choose (#1623). Cloudflare sets
   * `cf-connecting-ip` at its edge, replacing any the client sent. A proxy
   * appends the address it saw to `X-Forwarded-For`, so the last entry is the
   * proxy's and the first is whatever the client wrote. (#1629 covers the
   * Node Verifier reached with no proxy in front, where both can be forged.)
   */
  function registrationAddress(c: {
    req: { header: (name: string) => string | undefined };
  }): string {
    const edge = c.req.header('cf-connecting-ip');
    if (edge) return edge;
    const lastHop = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (lastHop) return lastHop;
    return c.req.header('x-real-ip') || 'unknown';
  }

  /** Drop every registration window that has ended. */
  function sweepRegistrationWindows(now: number): void {
    for (const [key, b] of registrationCounts) {
      if (now > b.resetAt) registrationCounts.delete(key);
    }
  }

  /**
   * `key`'s current rate-limit window, starting a fresh one when it has none
   * or its last has ended. A full table drops its oldest window rather than
   * refuse a new one, so filling it cannot lock every caller out.
   */
  function registrationBucket(
    key: string,
    now: number,
  ): { count: number; resetAt: number } {
    const record = registrationCounts.get(key);
    if (record && now <= record.resetAt) return record;
    if (record) {
      // Re-inserted below, so the table stays in window-start order.
      registrationCounts.delete(key);
    } else if (registrationCounts.size >= RATE_LIMIT_MAX_WINDOWS) {
      const oldest = registrationCounts.keys().next().value;
      if (oldest !== undefined) registrationCounts.delete(oldest);
    }
    const fresh = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    registrationCounts.set(key, fresh);
    return fresh;
  }

  /**
   * Count one registration against `key`'s window. False when the window is
   * already at `limit`; a refused attempt is not counted.
   */
  function takeRegistrationSlot(
    key: string,
    limit: number,
    now: number,
  ): boolean {
    const record = registrationBucket(key, now);
    if (record.count >= limit) return false;
    record.count++;
    return true;
  }

  /** SG-06: Get rate limit key from request headers. */
  function getAdminRateLimitKey(c: {
    req: { header: (name: string) => string | undefined };
  }): string {
    if (!TRUST_PROXY) return 'local';
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const firstIp = xff.split(',')[0].trim();
      if (firstIp) return firstIp;
    }
    const realIp = c.req.header('x-real-ip');
    if (realIp) return realIp;
    return 'local';
  }

  function checkPerIpRateLimit(
    ip: string,
    now: number,
  ): AdminEvaluateError | null {
    let bucket = adminIpBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + ADMIN_RATE_WINDOW_MS };
      adminIpBuckets.set(ip, bucket);
    }
    if (bucket.count >= ADMIN_RATE_LIMIT_PER_IP) {
      return {
        code: 'RATE_LIMITED',
        message: 'Admin evaluate rate limit exceeded',
        status: 429,
      };
    }
    bucket.count++;
    return null;
  }

  function checkAuthFailLimit(
    ip: string,
    now: number,
  ): AdminEvaluateError | null {
    const bucket = adminAuthFailBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) return null;
    if (bucket.count >= ADMIN_AUTH_FAIL_LIMIT) {
      return {
        code: 'RATE_LIMITED',
        message: 'Admin evaluate rate limit exceeded',
        status: 429,
      };
    }
    return null;
  }

  function recordAuthFailure(ip: string, now: number): void {
    let bucket = adminAuthFailBuckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + ADMIN_RATE_WINDOW_MS };
      adminAuthFailBuckets.set(ip, bucket);
    }
    bucket.count++;
  }

  function checkGlobalRateLimit(now: number): AdminEvaluateError | null {
    if (now > adminGlobalBucket.resetAt) {
      adminGlobalBucket.count = 0;
      adminGlobalBucket.resetAt = now + ADMIN_RATE_WINDOW_MS;
    }
    if (adminGlobalBucket.count >= ADMIN_GLOBAL_RATE_LIMIT) {
      return {
        code: 'RATE_LIMITED',
        message: 'Admin evaluate rate limit exceeded',
        status: 429,
      };
    }
    adminGlobalBucket.count++;
    return null;
  }

  /** Deep-health probe for the semantic toxicity endpoint. */
  async function checkSemanticToxicityHealth(): Promise<{
    configured: boolean;
    ready: boolean;
    error?: string;
  }> {
    const explicitEndpoint = getConfiguredToxicitySemanticEndpoint();
    const endpoint =
      explicitEndpoint ?? (await resolveToxicitySemanticEndpoint());
    if (!endpoint) {
      return { configured: false, ready: true };
    }

    const healthUrl = resolveToxicitySemanticHealthUrl(endpoint);
    if (!healthUrl) {
      return { configured: true, ready: false, error: 'invalid-endpoint' };
    }

    const configuredTimeout = Number.parseInt(
      process.env[TOXICITY_SEMANTIC_TIMEOUT_ENV] ??
        `${DEFAULT_TOXICITY_SEMANTIC_TIMEOUT_MS}`,
      10,
    );
    const timeout = Math.min(
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TOXICITY_SEMANTIC_TIMEOUT_MS,
      HEALTH_SEMANTIC_TIMEOUT_CAP_MS,
    );

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let response: Response;
      try {
        response = await fetch(healthUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        noteToxicitySemanticEndpointHealthy(endpoint);
      } else {
        noteToxicitySemanticEndpointUnhealthy(endpoint);
      }

      return {
        configured: true,
        ready: response.ok,
        ...(response.ok ? {} : { error: `http-${response.status}` }),
      };
    } catch (error) {
      noteToxicitySemanticEndpointUnhealthy(endpoint);
      return {
        configured: true,
        ready: false,
        error:
          error instanceof Error && error.name === 'AbortError'
            ? `timeout-${timeout}ms`
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Hono app + middleware
  // ═══════════════════════════════════════════════════════════════════

  const app = new Hono();

  app.use('*', logger());
  app.use('*', cors());

  // Protocol version middleware
  app.use('*', async (c, next) => {
    c.header('X-Spellguard-Protocol-Version', CURRENT_PROTOCOL_VERSION);

    const clientVersion = c.req.header('X-Spellguard-Protocol-Version');
    if (clientVersion) {
      const version = Number.parseFloat(clientVersion);
      if (!Number.isNaN(version) && version < MIN_PROTOCOL_VERSION) {
        return c.json(
          {
            error: 'Protocol version too old. Please upgrade your client.',
            minVersion: CURRENT_PROTOCOL_VERSION,
          },
          426,
        );
      }
    }
    await next();
  });

  // Stamp the active transport on every response. Lets curl/agents/CI
  // see whether they're talking through the slim-mode gateway (and
  // riding the AGNTCY SLIM transport) or the original direct-HTTP
  // path. Reads from the profile bundle singleton; on the original
  // profile the header is just 'http' (still informative).
  app.use('*', async (c, next) => {
    const bundle = getActiveProfile();
    if (bundle) {
      c.header('X-Spellguard-Profile', bundle.profile);
      c.header('X-Spellguard-Transport', bundle.transport.name);
    }
    await next();
  });

  // ═══════════════════════════════════════════════════════════════════
  // Health
  // ═══════════════════════════════════════════════════════════════════

  app.get('/health', async (c) => {
    const config = getBackendConfig();
    const deepCheck =
      c.req.query('checkSemantic') === '1' ||
      c.req.query('checkSemantic') === 'true';

    const semanticToxicity = deepCheck
      ? await checkSemanticToxicityHealth()
      : undefined;

    const status =
      semanticToxicity?.configured && !semanticToxicity.ready
        ? 'degraded'
        : 'ok';

    return c.json(
      {
        status,
        sessionKeyReady: !!getSessionPublicKey(),
        backends: {
          commitment: {
            type: config.commitmentBackend,
            connected: isCommitmentBackendConnected(),
          },
          archive: {
            type: config.archiveBackend,
            connected: isArchiveBackendConnected(),
          },
        },
        ...(semanticToxicity ? { semanticToxicity } : {}),
      },
      status === 'ok' ? 200 : 503,
    );
  });

  // /ready — READINESS probe. /health (above) is liveness: it's served
  // locally and stays 200 whenever the process is up, even if the SLIM
  // listener died (the false-positive oracle that let ECS keep zombie
  // tasks alive). /ready reflects whether the SLIM listener worker is
  // actually alive and subscribed, so health checks pointed here cull a
  // SLIM-dead verifier. Non-slim runtimes (no getSlimReady) report ready.
  app.get('/ready', (c) => {
    const hasSlim = !!options.getSlimReady;
    const slimReady = hasSlim
      ? (options.getSlimReady as () => boolean)()
      : true;
    return c.json(
      {
        ready: slimReady,
        sessionKeyReady: !!getSessionPublicKey(),
        slim: hasSlim ? (slimReady ? 'ok' : 'down') : 'n/a',
      },
      slimReady ? 200 : 503,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // Verifier Self-Attestation
  // ═══════════════════════════════════════════════════════════════════

  app.get('/attestation', async (c) => {
    const nonce = c.req.query('nonce') || crypto.randomUUID();
    try {
      const document = await generateAttestationDocument(nonce);
      return c.json(document);
    } catch (error) {
      console.error('[Verifier] Attestation error:', error);
      return c.json(
        { error: 'Attestation generation failed', details: String(error) },
        500,
      );
    }
  });

  app.get('/attestation/verify', async (c) => {
    const expectedHash = c.req.query('expected_hash');
    const document = await generateAttestationDocument(crypto.randomUUID());

    return c.json({
      matches: expectedHash ? document.imageHash === expectedHash : null,
      imageHash: document.imageHash,
      publicKey: document.publicKey,
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Agent Attestation (RFC 9334 RATS pattern)
  // ═══════════════════════════════════════════════════════════════════

  app.post('/agents/register', async (c) => {
    // Check payload size
    const contentLength = Number.parseInt(
      c.req.header('content-length') || '0',
    );
    if (contentLength > MAX_PAYLOAD_SIZE) {
      return c.json({ error: 'Payload too large' }, 413);
    }

    const ip = registrationAddress(c);
    const now = Date.now();
    const tooManyRequests = () =>
      c.json({ error: 'Too many requests. Please try again later.' }, 429);

    if (
      !takeRegistrationSlot(`address\n${ip}`, RATE_LIMIT_ADDRESS_REQUESTS, now)
    ) {
      return tooManyRequests();
    }

    const body = await c.req.json();
    const evidence = body.evidence as Evidence;
    const clientPublicKey = body.clientPublicKey as string | undefined;

    if (!evidence || !evidence.agentId || !evidence.claims) {
      return c.json({ error: 'Invalid evidence format' }, 400);
    }

    // The management token is checked locally, without asking management, so
    // it is checked first: a valid one for this agent exempts the caller from
    // the failed-attempt limit below. Its refusal is still answered after the
    // secret's, as before.
    const managementToken = c.req.header('X-Spellguard-Management-Token');
    let tokenClaims: Awaited<
      ReturnType<typeof verifyAndExtractAgentPublicKey>
    > = null;
    let tokenInvalid = false;
    if (managementToken) {
      try {
        tokenClaims = await verifyAndExtractAgentPublicKey(managementToken);
      } catch (err) {
        console.warn(`[Verifier] Management JWT verification failed: ${err}`);
        tokenInvalid = true;
      }
    }
    // The token proves identity only for the agent it names; one that names
    // no agent proves it for none.
    const tokenNamesAgent =
      tokenClaims !== null && tokenClaims.agentId === evidence.agentId;

    // Failed attempts to prove this agent's identity from this address. Past
    // the limit, management is not asked again until the window ends, which
    // bounds guessing an agent's secret. An attempt holds its slot from here,
    // before anything is awaited, so a burst of concurrent guesses cannot all
    // pass the check before one is counted; it gives the slot back once it
    // has proved who it is. Someone else's failures never hold up a caller
    // with a valid management token for the agent.
    const failures = tokenNamesAgent
      ? null
      : registrationBucket(`failed\n${ip}\n${evidence.agentId}`, now);
    if (failures) {
      if (failures.count >= RATE_LIMIT_FAILED_REQUESTS) {
        return tooManyRequests();
      }
      failures.count++;
    }
    // A refusal keeps the slot the attempt holds.
    const refuseIdentity = (error: string, status: 401 | 503) =>
      c.json({ error }, status);

    // Validate agent secret against management server
    const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
    const agentSecret = c.req.header('X-Spellguard-Agent-Secret');
    let identityVerified = false;
    // #1411: with a management server to ask, a registration must prove who
    // it is, by a verified agent secret or a management token naming this
    // agent. Standalone mode has no one to ask, and dev mode (local dev,
    // throwaway dev-stacks) keeps the unauthenticated path its fixtures use.
    const requireIdentity = Boolean(managementUrl) && !isDevMode;
    let secretUnverifiable = false;

    if (managementUrl && agentSecret) {
      try {
        const verifyBody = JSON.stringify({
          agentId: evidence.agentId,
          agentSecret,
        });
        const verifyUrl = `${managementUrl}/v1/internal/verify-agent`;
        const verifyHeaders = await signRequest('POST', verifyUrl, verifyBody);
        const verifyResp = await fetch(verifyUrl, {
          method: 'POST',
          headers: verifyHeaders,
          body: verifyBody,
          signal: AbortSignal.timeout(5000),
        });

        // A management error checked nothing: handled as an outage below.
        if (verifyResp.status >= 500) {
          throw new Error(`management answered ${verifyResp.status}`);
        }
        if (!verifyResp.ok) {
          return refuseIdentity('Agent secret verification failed', 401);
        }

        const verifyResult = (await verifyResp.json()) as { valid: boolean };
        if (!verifyResult.valid) {
          return refuseIdentity('Invalid agent secret', 401);
        }
        identityVerified = true;
      } catch (error) {
        console.warn(
          `[Verifier] Management server unreachable for agent verification: ${error}`,
        );
        // A secret nobody could check proves nothing. A management token,
        // which is verified without calling management, may still prove who
        // this is; without one the registration is refused below.
        secretUnverifiable = true;
      }
    }

    // Extract agentPublicKey from management JWT if present
    let agentPublicKey: string | undefined;
    if (tokenInvalid) {
      return refuseIdentity('Invalid management token', 401);
    }
    if (tokenClaims) {
      agentPublicKey = tokenClaims.agentPublicKey;
      if (!tokenNamesAgent) {
        return refuseIdentity('Management token agent ID mismatch', 401);
      }
      identityVerified = true;
    }

    if (requireIdentity && !identityVerified) {
      // An outage is the caller's cue to retry; a missing credential is not.
      if (secretUnverifiable) {
        // No secret was checked, so this is not a failed attempt: an agent
        // retrying through an outage must not be locked out after it.
        if (failures) failures.count--;
        return c.json(
          { error: 'Agent identity could not be verified; try again' },
          503,
        );
      }
      return refuseIdentity(
        'Agent identity required: present an agent secret or a management token',
        401,
      );
    }

    // Not a failed attempt after all.
    if (failures) failures.count--;

    // Counted only once the caller has proved it is this agent (where
    // identity is required), so no one else can use up an agent's budget.
    if (
      !takeRegistrationSlot(
        `agent\n${ip}\n${evidence.agentId}`,
        RATE_LIMIT_REQUESTS,
        now,
      )
    ) {
      return tooManyRequests();
    }

    const verifierAttestationType = (() => {
      if (process.env.VERIFIER_MOCK_MODE === 'true') return 'mock' as const;
      const p = process.env.VERIFIER_PLATFORM?.toLowerCase();
      if (p === 'nitro') return 'nitro' as const;
      if (p === 'internal') return 'internal' as const;
      return 'phala' as const;
    })();

    const result = await verifyEvidence(evidence, {
      agentPublicKey,
      identityVerified,
      verifierAttestationType,
    });

    if (!result.verified) {
      if (result.error?.includes('already registered')) {
        return c.json({ error: result.error }, 409);
      }
      return c.json(
        { error: result.error || 'Evidence verification failed', result },
        400,
      );
    }

    // Stamp the client's X25519 public key onto the local registry so the
    // router can encrypt delivered payloads + responses TO this agent
    // (gateway-opaque, app-layer end-to-end). Absent ⇒ the agent stays in
    // legacy plaintext mode. All profiles (encryption is above transport).
    if (clientPublicKey) {
      const reg = getAgent(evidence.agentId);
      if (reg && reg.clientPublicKey !== clientPublicKey) {
        registerAgent(
          { ...reg, clientPublicKey },
          { allowEndpointUpdate: true },
        );
      }
    }

    // Persist the agent's base URL to management so that resolution
    // survives Verifier restarts.
    if (managementUrl && evidence.claims?.endpoint) {
      const baseUrl = evidence.claims.endpoint.replace(
        /\/_spellguard\/receive\/?$/,
        '',
      );
      // Report the agent's gateway-opaque encryption mode alongside its
      // endpoint: 'full' when it registered an X25519 key (E2E-to-agent),
      // 'legacy' otherwise. Drives the dashboard's legacy-mode badge.
      // #1528: report the key too, so a registry that loses it (a session-key
      // rotation, a restart) gets it back from management instead of
      // delivering plaintext the agent refuses.
      const reportedKey = clientPublicKey?.toLowerCase();
      const patchBody = JSON.stringify({
        endpointUrl: baseUrl,
        encryptionMode: clientPublicKey ? 'full' : 'legacy',
        ...(reportedKey && /^[0-9a-f]{64}$/.test(reportedKey)
          ? { clientPublicKey: reportedKey }
          : {}),
      });
      const endpointUrl = `${managementUrl}/v1/internal/agents/${encodeURIComponent(evidence.agentId)}/endpoint`;
      signRequest('PATCH', endpointUrl, patchBody)
        .then((headers) =>
          fetch(endpointUrl, {
            method: 'PATCH',
            headers,
            body: patchBody,
            signal: AbortSignal.timeout(5000),
          }),
        )
        .catch((err) =>
          console.warn(
            `[Verifier] Failed to persist endpoint for ${evidence.agentId}: ${err}`,
          ),
        );
    }

    // Agntcy profile: publish the agent into AGNTCY dir so recipient resolution
    // (router.resolveRecipient → directory.resolve) finds it. dir is the SOLE
    // registry in agntcy mode (no A2A fallback), so resolution MUST succeed —
    // which is why we now publish in BOTH managed and no-Management modes.
    // (Management itself never wrote to dir; after a verifier restart its
    // in-memory registry is empty, so even managed recipients resolve via dir.)
    // Best-effort: a dir/gateway failure must not block attestation.
    const profile = getActiveProfile();
    if (profile?.profile === 'agntcy' && evidence.claims?.endpoint) {
      const baseUrl = evidence.claims.endpoint.replace(
        /\/_spellguard\/receive\/?$/,
        '',
      );
      // Agntcy profile delivers verifier→gateway→agent over SLIM in BOTH managed
      // and no-Management modes (the recipient stays a plain HTTP agent; the
      // gateway proxies SLIM → POST callback). So every attested agent gets a
      // 3-component slimName, is published into dir under it (the gateway's
      // doSubscribe requires exactly 3 parts; org/group from env, default/default
      // single-tenant), and is registered with the gateway so it subscribes.
      // Stamp the slimName onto this verifier's local registry entry too —
      // resolveRecipient() returns a locally-registered agent BEFORE consulting
      // dir, so without the stamp a self-registered recipient would have no
      // slimName and bypass the data plane.
      const slimOrg =
        process.env.SPELLGUARD_DEFAULT_ORG_SLIM_PREFIX ?? 'default';
      const slimName = deriveAgentSlimName(evidence.agentId);
      const localReg = getAgent(evidence.agentId);
      if (localReg && localReg.slimName !== slimName) {
        registerAgent({ ...localReg, slimName }, { allowEndpointUpdate: true });
      }
      // Publish the agent's HTTP endpoint as the dir locator: resolve() yields
      // a url that the router uses for the gateway callback (and the delivery
      // retry's re-register). The slimName itself is derived deterministically
      // from the agentId at resolve time, so it needn't be stored in dir.
      profile.directory
        .publish?.({
          agentId: evidence.agentId,
          endpoint: baseUrl,
          skills: [],
          org: slimOrg,
        })
        .catch((err) =>
          console.warn(
            `[Verifier] dir publish failed for ${evidence.agentId}: ${(err as Error).message}`,
          ),
        );
      // Register the slimName → callbackUrl mapping with the gateway so it
      // subscribes and can dispatch inbound SLIM to the agent. Fire-and-forget +
      // cached (ensureGatewayRegistered), so a later resolve of this recipient
      // skips a duplicate push; a failure here is retried on first delivery.
      void ensureGatewayRegistered(evidence.agentId, baseUrl).then((sn) =>
        console.log(
          sn
            ? `[Verifier] Published ${evidence.agentId} to dir + registered with gateway (slimName=${slimName})`
            : `[Verifier] dir-published ${evidence.agentId}; gateway registration deferred (retries on delivery)`,
        ),
      );
    }

    await persist(options);
    return c.json(result);
  });

  app.get('/agents/:id/status', async (c) => {
    const token = c.req.header('X-Spellguard-Channel-Token');
    if (!token) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const requestingAgent = getAgentByToken(token);
    if (!requestingAgent) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    const agentId = c.req.param('id');

    const targetConfig = await getAgentPolicies(agentId);
    if (!targetConfig) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (targetConfig.visibility) {
      const requesterConfig = await getAgentPolicies(requestingAgent.agentId);
      if (!requesterConfig) {
        return c.json({ error: 'Agent not found' }, 404);
      }
      const requesterContext = {
        agentId: requestingAgent.agentId,
        organizationId: requesterConfig.organizationId ?? '',
        groupIds: requesterConfig.visibility?.groups?.map((g) => g.id) ?? [],
      };
      const visResult = checkVisibility(
        requesterContext,
        targetConfig.visibility,
      );
      if (!visResult.allowed) {
        return c.json({ error: 'Agent not found' }, 404);
      }
    }

    const registered = isAgentRegistered(agentId);
    const agent = getAgent(agentId);

    return c.json({
      agentId,
      registered,
      expiresAt: agent?.expiresAt,
    });
  });

  app.get('/agents', async (c) => {
    const token = c.req.header('X-Spellguard-Channel-Token');
    if (!token) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const requestingAgent = getAgentByToken(token);
    if (!requestingAgent) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    const requesterConfig = await getAgentPolicies(requestingAgent.agentId);

    const requesterContext = requesterConfig
      ? {
          agentId: requestingAgent.agentId,
          organizationId: requesterConfig.organizationId ?? '',
          groupIds: requesterConfig.visibility?.groups?.map((g) => g.id) ?? [],
        }
      : null;

    const allRegistered = getAllAgents();
    const policyResults = await Promise.all(
      allRegistered.map((a) =>
        a.agentId === requestingAgent.agentId
          ? Promise.resolve(null)
          : getAgentPolicies(a.agentId),
      ),
    );

    const visibleAgents = allRegistered.filter((a, i) => {
      if (a.agentId === requestingAgent.agentId) return true;

      const targetConfig = policyResults[i];
      if (!targetConfig) return false;
      if (!targetConfig.visibility) return true;
      if (!requesterContext) return false;

      return checkVisibility(requesterContext, targetConfig.visibility).allowed;
    });

    const agents = visibleAgents.map((a) => ({
      agentId: a.agentId,
      endpoint: a.agentId === requestingAgent.agentId ? a.endpoint : undefined,
      agentCardUrl: a.agentCardUrl,
      registeredAt: a.registeredAt,
      expiresAt: a.expiresAt,
    }));
    return c.json({ agents });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Discovery (A2A Agent Cards)
  // ═══════════════════════════════════════════════════════════════════

  app.get('/agents/resolve/:name', async (c) => {
    const token = c.req.header('X-Spellguard-Channel-Token');
    const requestingAgent = token ? getAgentByToken(token) : null;

    const agentName = c.req.param('name');
    const card = await resolveAgentCard(agentName);

    if (!card) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const cardUrlNorm = normalizeAgentUrl(card.url);
    const cardUrlWithWellKnown = normalizeAgentUrl(
      `${card.url}/.well-known/agent.json`,
    );
    const registeredAgent = getAllAgents().find((a) => {
      const regNorm = normalizeAgentUrl(a.agentCardUrl);
      return regNorm === cardUrlWithWellKnown || regNorm === cardUrlNorm;
    });

    if (registeredAgent) {
      const targetConfig = await getAgentPolicies(registeredAgent.agentId);
      if (!targetConfig) {
        console.warn(
          `[Discovery] Could not fetch policies for ${registeredAgent.agentId}, skipping visibility check`,
        );
      } else if (targetConfig.visibility) {
        if (!requestingAgent) {
          if (
            targetConfig.visibility.effectiveInternal ||
            targetConfig.visibility.blocklist.length > 0
          ) {
            return c.json({ error: 'Agent not found' }, 404);
          }
        } else {
          const requesterConfig = await getAgentPolicies(
            requestingAgent.agentId,
          );
          if (!requesterConfig) {
            return c.json({ error: 'Agent not found' }, 404);
          }
          const requesterContext = {
            agentId: requestingAgent.agentId,
            organizationId: requesterConfig.organizationId ?? '',
            groupIds:
              requesterConfig.visibility?.groups?.map((g) => g.id) ?? [],
          };
          const visResult = checkVisibility(
            requesterContext,
            targetConfig.visibility,
          );
          if (!visResult.allowed) {
            return c.json({ error: 'Agent not found' }, 404);
          }
        }
      }
    }
    return c.json(card);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Message Proxy
  // ═══════════════════════════════════════════════════════════════════

  app.post('/messages/send', async (c) => {
    const channelToken = c.req.header('X-Spellguard-Channel-Token');
    if (!channelToken) {
      return c.json({ error: 'Missing channel token' }, 401);
    }

    const read = await readMessageBody(c.req.raw, maxMessageBodyBytes);
    if (!read.ok) {
      return refuseMessageBody(c, channelToken, '/messages/send', read.message);
    }
    const body = read.body;
    const { sender, recipient, encryptedPayload } = body as {
      sender?: string;
      recipient?: string;
      encryptedPayload?: string;
    };

    if (!sender || !recipient || !encryptedPayload) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const message: SecureMessage = {
      id: generateMessageId(),
      sender,
      recipient,
      encryptedPayload,
      timestamp: Date.now(),
    };

    const result = await routeMessage(message, channelToken, sessionServices);

    // Persist registry in case new agents were discovered during routing
    await persist(options);

    if (!result.success) {
      const status =
        result.responseLevel === 'rate_limit'
          ? 429
          : result.responseLevel === 'block' ||
              result.responseLevel === 'quarantine'
            ? 403
            : 400;
      return c.json(
        {
          error: result.error,
          responseLevel: result.responseLevel,
          warnings: result.warnings,
        },
        status as 400 | 403 | 429,
      );
    }

    return c.json({
      messageId: message.id,
      response: result.response,
      warnings: result.warnings,
    });
  });

  app.post('/messages/unilateral', async (c) => {
    const channelToken = c.req.header('X-Spellguard-Channel-Token');
    if (!channelToken) {
      return c.json({ error: 'Missing channel token' }, 401);
    }

    const read = await readMessageBody(c.req.raw, maxMessageBodyBytes);
    if (!read.ok) {
      return refuseMessageBody(
        c,
        channelToken,
        '/messages/unilateral',
        read.message,
      );
    }
    const { sender, a2aAgentUrl, payload, method } = read.body as Partial<
      Parameters<typeof routeUnilateral>[0]
    >;

    if (!sender || !a2aAgentUrl || !payload) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const result = await routeUnilateral(
      { sender, a2aAgentUrl, payload, method },
      channelToken,
      { sessionServices },
    );

    if (!result.success) {
      return c.json(
        {
          error: result.error,
          correlationId: result.correlationId,
          commitments: result.commitments,
          warnings: result.warnings,
        },
        400,
      );
    }

    return c.json(result);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Admin Evaluate (Dashboard → Verifier policy evaluation only)
  // ═══════════════════════════════════════════════════════════════════

  // #1259: every verdict management asks for is signed (see verdict-signing).
  app.use('/admin/evaluate', signVerdictResponses);
  app.use('/v1/mcp/evaluate', signVerdictResponses);
  app.use('/v1/mcp/tools', signVerdictResponses);

  app.post('/admin/evaluate', async (c) => {
    const requesterIp = getRequesterIp(
      { get: (name) => c.req.header(name) },
      TRUST_PROXY,
    );

    const declaredLength = c.req.header('content-length');
    if (declaredLength) {
      const len = Number.parseInt(declaredLength, 10);
      if (Number.isNaN(len) || len > MAX_PAYLOAD_SIZE) {
        return c.json(
          {
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'Request body exceeds size limit',
            },
          },
          413,
        );
      }
    }

    const rawBody = declaredLength
      ? await c.req.text()
      : await readBodyWithLimit(c.req.raw, MAX_PAYLOAD_SIZE);
    if (rawBody === null) {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body exceeds size limit',
          },
        },
        413,
      );
    }

    const now = Date.now();
    const rateLimitIp = getAdminRateLimitKey(c);

    const ipRateErr = checkPerIpRateLimit(rateLimitIp, now);
    if (ipRateErr) {
      console.warn(
        `[Verifier] Admin evaluate per-IP rate-limited: ${rateLimitIp}`,
      );
      return c.json(
        { error: { code: ipRateErr.code, message: ipRateErr.message } },
        ipRateErr.status as 429,
      );
    }

    const authFailErr = checkAuthFailLimit(rateLimitIp, now);
    if (authFailErr) {
      console.warn(
        `[Verifier] Admin evaluate auth-fail rate-limited: ${rateLimitIp}`,
      );
      return c.json(
        { error: { code: authFailErr.code, message: authFailErr.message } },
        authFailErr.status as 429,
      );
    }

    const authErr = await verifyAdminSignature(
      c.req.header('X-Admin-Signature'),
      c.req.header('X-Admin-Key-Id'),
      rawBody,
    );
    if (authErr) {
      if (authErr.status === 401) {
        recordAuthFailure(rateLimitIp, now);
      }
      console.warn(
        `[Verifier] Admin evaluate auth failure (${authErr.code}) from ${requesterIp}`,
      );
      return c.json(
        { error: { code: authErr.code, message: authErr.message } },
        authErr.status as 401 | 422,
      );
    }

    const globalRateErr = checkGlobalRateLimit(now);
    if (globalRateErr) {
      console.warn('[Verifier] Admin evaluate global rate limit reached');
      return c.json(
        {
          error: { code: globalRateErr.code, message: globalRateErr.message },
        },
        globalRateErr.status as 429,
      );
    }

    const parsedBody = parseAdminEvaluateRequest(rawBody);
    if (!parsedBody.ok) {
      return c.json(
        {
          error: {
            code: parsedBody.error.code,
            message: parsedBody.error.message,
          },
        },
        parsedBody.error.status as 400,
      );
    }
    const { targetAgentId, message, senderId, direction, timestamp, nonce } =
      parsedBody.value;

    // SG-09: Persistent replay defense
    try {
      const replayErr = await checkReplayDefensePersistent({
        timestamp,
        nonce,
        now,
        nonceStore: options.nonceStore,
        nonceTtlMs: NONCE_TTL_MS,
      });
      if (replayErr) {
        console.warn(
          `[Verifier] Admin evaluate replay rejection (${replayErr.code}) from ${requesterIp}`,
        );
        return c.json(
          { error: { code: replayErr.code, message: replayErr.message } },
          replayErr.status as 403,
        );
      }
    } catch (nonceErr) {
      console.warn(
        `[Verifier] Nonce store error (proceeding without replay defense): ${nonceErr}`,
      );
    }

    const effectiveSenderId = senderId || 'dashboard-admin';
    console.info(
      `[Verifier] Admin evaluate accepted: sender=${effectiveSenderId} target=${targetAgentId} direction=${direction} ip=${requesterIp}`,
    );

    try {
      const agentPolicies = await getAgentPolicies(targetAgentId);
      if (!agentPolicies) {
        console.warn(
          `[Verifier] Could not fetch policies for agent ${targetAgentId} (ip=${requesterIp})`,
        );
        return c.json(
          {
            error: {
              code: 'EVALUATION_FAILED',
              message: 'Could not process evaluation request',
            },
          },
          422,
        );
      }

      // The tester is a dry run of the MESSAGE leg, so it scope-filters
      // exactly as `proxy/router.ts` does (§12b). See
      // `selectAdminEvaluateBindings`.
      const bindings = selectAdminEvaluateBindings(agentPolicies, direction);

      const policyChecks = await evaluatePolicies(bindings, message, {
        agentId: targetAgentId,
        direction,
        identity: agentPolicies.identityContext,
      });
      const responseLevel = deriveResponseLevel(policyChecks);
      const messageId = generateMessageId();

      // See shouldQuarantineFromChecks: fire quarantine whenever any
      // check has responseLevel === 'quarantine', even if a higher-priority
      // block-effect binding wins the message-level disposition.
      if (shouldQuarantineFromChecks(policyChecks)) {
        const quarantineChecks = policyChecks.filter(
          (c) => c.responseLevel === 'quarantine' && c.detections.length > 0,
        );
        const reason =
          buildQuarantineReason(quarantineChecks) ||
          'Policy evaluation triggered quarantine';
        await handleQuarantine(targetAgentId, reason);
      }

      const sanitizedChecks = policyChecks.map((check) => ({
        policyName: check.policyName,
        decision: check.decision,
        responseLevel: check.responseLevel,
        detections: check.detections.map((d) => ({ type: d.type })),
      }));
      const text = sanitizeEvaluationSummary(responseLevel, sanitizedChecks);

      const commitment = {
        messageId,
        // A real hex digest — management ingests this through
        // `Buffer.from(hash, 'hex')`, which silently yields an EMPTY buffer
        // for a non-hex string (§12b).
        hash: adminEvaluateCommitmentHash(message),
        sender: direction === 'outbound' ? targetAgentId : effectiveSenderId,
        recipient: direction === 'outbound' ? effectiveSenderId : targetAgentId,
        timestamp: now,
        attestationLevel: 'bilateral' as const,
      };
      reportBilateralEvent(
        commitment,
        responseLevel,
        policyChecks,
        direction,
        targetAgentId,
        'admin-evaluate-test',
      );

      return c.json({
        messageId,
        direction,
        responseLevel,
        policyChecks: sanitizedChecks,
        text,
      });
    } catch (err) {
      console.error('[Verifier] Admin evaluate error:', err);
      return c.json(
        {
          error: {
            code: 'EVALUATION_FAILED',
            message: 'Could not process evaluation request',
          },
        },
        422,
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Tool Policy Check
  // ═══════════════════════════════════════════════════════════════════

  app.post('/v1/tools/check', async (c) => {
    const channelToken = c.req.header('X-Spellguard-Channel-Token');
    if (!channelToken) {
      return c.json({ error: 'Missing channel token' }, 401);
    }

    const tokenOwner = getAgentByToken(channelToken);
    if (!tokenOwner) {
      return c.json({ error: 'Invalid or expired channel token' }, 401);
    }

    let body: {
      agentId: string;
      phase: 'input' | 'output';
      toolName: string;
      params?: unknown;
      result?: unknown;
      /**
       * The conversation the call belongs to: the SDK sends the correlation
       * id of the message whose handler made the call. Joins the tool-check
       * audit row to that conversation and selects the agent's session.
       */
      correlationId?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.agentId || !body.phase || !body.toolName) {
      return c.json(
        { error: 'Missing required fields: agentId, phase, toolName' },
        400,
      );
    }

    if (body.phase !== 'input' && body.phase !== 'output') {
      return c.json({ error: 'phase must be "input" or "output"' }, 400);
    }

    const correlation = readCorrelationId(body.correlationId);
    if (!correlation.ok) {
      return c.json({ error: correlation.error }, 400);
    }
    const correlationId = correlation.value;

    if (tokenOwner.agentId !== body.agentId) {
      return c.json({ error: 'Agent ID does not match channel token' }, 403);
    }

    const agentPolicies = await getAgentPolicies(body.agentId);
    if (!agentPolicies) {
      return c.json({ error: 'Policy data unavailable', effect: 'block' }, 503);
    }

    const direction = body.phase === 'input' ? 'outbound' : 'inbound';
    const bindings =
      direction === 'outbound' ? agentPolicies.outbound : agentPolicies.inbound;

    const filtered = filterByScope(bindings, 'tools');

    // Only run policy evaluation when there are tool-scoped bindings
    // — but ALWAYS emit the audit-log entry below.  The dashboard
    // viz materializes tool nodes from tool-check audit rows, so an
    // agent that invokes a tool with no policies bound still needs
    // to leave a trace.  When policyChecks is empty, responseLevel
    // collapses to 'allow' via resolveResponseLevel and the entry
    // records "this tool was called" without implying any policy
    // decision.
    const toolPayload = JSON.stringify({
      toolName: body.toolName,
      phase: body.phase,
      params: body.params,
      result: body.result,
    });

    // The agent's session ledger for this conversation, when there is one
    // to read (a store, a correlation id, and a session policy bound).
    const session = await openAgentSession(
      sessionServices,
      body.agentId,
      correlationId,
      agentPolicies,
    );

    // The call is the agent's output at its input phase: agent-conduct
    // judges it (internal design notes). Its result is a
    // source, not an output.
    const output =
      body.phase === 'input' && judgesOutputs(filtered)
        ? toolCallOutput(body.toolName, body.params)
        : undefined;

    const policyChecks =
      filtered.length === 0
        ? []
        : await evaluateToolCallPolicies(filtered, toolPayload, {
            agentId: body.agentId,
            direction,
            toolName: body.toolName,
            toolParams:
              body.params !== null &&
              typeof body.params === 'object' &&
              !Array.isArray(body.params)
                ? (body.params as Record<string, unknown>)
                : undefined,
            agentStatus: agentPolicies.agentStatus,
            identity: agentPolicies.identityContext,
            correlationId,
            session,
            decisionModel: sessionServices.decisionModel,
            ...(output ? { output } : {}),
          });

    const responseLevel = resolveResponseLevel(
      policyChecks.map((c) => c.responseLevel),
    );

    const messageId = `tool_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
    const commitment: AuditCommitment = {
      messageId,
      // Hex SHA-256 of the checked invocation, for the same reason the
      // admin-evaluate commitment is one: management stores `message_hash`
      // via `Buffer.from(hash, 'hex')`, and the old `toolcheck_<id>` literal
      // decoded to a zero-length buffer.
      hash: hashPayload(toolPayload),
      sender: body.agentId,
      recipient: body.agentId,
      timestamp: Date.now(),
      attestationLevel: 'bilateral',
      ...(correlationId ? { correlationId } : {}),
    };

    // Record the call in the agent's session after its verdict. A denied
    // call is recorded too, marked in its label, so the ledger shows the
    // attempt (unlike the tool-call history, which drops it).
    let sessionStatus: string | undefined;
    if (session) {
      const denied = policyChecks.some((check) => check.decision === 'deny');
      sessionStatus = await recordParts(session, [
        {
          leg: body.phase === 'input' ? 'tool:input' : 'tool:output',
          kind: 'json',
          label: denied ? deniedLabel(body.toolName) : body.toolName,
          from: {
            agentId: body.agentId,
            ...(agentPolicies.organizationId
              ? { orgId: agentPolicies.organizationId }
              : {}),
          },
          text:
            JSON.stringify(
              body.phase === 'input' ? (body.params ?? {}) : body.result,
            ) ?? '',
        },
      ]);
    }

    reportBilateralEvent(
      commitment,
      responseLevel,
      policyChecks,
      direction === 'outbound' ? 'outbound' : 'inbound',
      body.agentId,
      'tool-check',
      {
        toolName: body.toolName,
        phase: body.phase,
        ...(sessionStatus ? { session: sessionStatus } : {}),
      },
    );

    // Fast-path response when no policies ran — skip the
    // quarantine + effect-switch logic below since they only have
    // anything to do with non-empty policyChecks.
    if (filtered.length === 0) {
      return c.json({ effect: 'allow' });
    }

    // See shouldQuarantineFromChecks: fire quarantine whenever any
    // check has responseLevel === 'quarantine', even if a higher-priority
    // block-effect binding wins the message-level disposition.
    if (shouldQuarantineFromChecks(policyChecks)) {
      const reason = policyChecks
        .filter((c) => c.responseLevel === 'quarantine')
        .flatMap((c) => c.detections.map((d) => d.message || d.type))
        .join('; ');
      await handleQuarantine(
        body.agentId,
        reason || 'Tool policy triggered quarantine',
      );
    }

    switch (responseLevel) {
      case 'block':
      case 'quarantine':
      // #1412: a rate limit is a deny, and a tool call it denies is blocked.
      case 'rate_limit': {
        const msg = policyChecks.find((c) => c.decision === 'deny')
          ?.detections[0]?.message;
        const retryAfter = policyChecks.find((c) => c.retryAfter)?.retryAfter;
        return c.json({
          effect: 'block',
          message: msg || 'Blocked by policy',
          ...(retryAfter !== undefined ? { retryAfter } : {}),
          policyChecks: policyChecks.map((ch) => ({
            policyName: ch.policyName,
            decision: ch.decision,
            responseLevel: ch.responseLevel,
          })),
        });
      }
      case 'redact':
        return c.json({
          effect: 'redact',
          data: null,
          policyChecks: policyChecks.map((ch) => ({
            policyName: ch.policyName,
            decision: ch.decision,
            responseLevel: ch.responseLevel,
          })),
        });
      case 'flag':
        return c.json({
          effect: 'flag',
          policyChecks: policyChecks.map((ch) => ({
            policyName: ch.policyName,
            decision: ch.decision,
            responseLevel: ch.responseLevel,
          })),
        });
      case 'allow':
        return c.json({ effect: 'allow' });
      default: {
        // Exhaustive: a response level added without a case above fails to
        // compile here, and at runtime blocks rather than allows.
        const _exhaustive: never = responseLevel;
        console.warn(
          `[Verifier] Unknown tool-check response level "${_exhaustive as string}" — blocking`,
        );
        return c.json({ effect: 'block', message: 'Blocked by policy' });
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // MCP Evaluate (MCP Proxy → Verifier policy evaluation)
  // ═══════════════════════════════════════════════════════════════════

  app.post('/v1/mcp/evaluate', handleMcpEvaluate);
  // Which tools an MCP Guard may show: its agent's approved-tools policy.
  app.post('/v1/mcp/tools', handleMcpTools);

  // ═══════════════════════════════════════════════════════════════════
  // LLM Gateway (OpenAI-compatible model-inference mediation — scope 'llm')
  // ═══════════════════════════════════════════════════════════════════

  app.post('/v1/chat/completions', handleLlmChatCompletions);

  // ═══════════════════════════════════════════════════════════════════
  // Content Evaluate (evaluate-only verdicts for on-path callers such as
  // the OpenShell supervisor middleware — scope 'llm', agent-secret auth)
  // ═══════════════════════════════════════════════════════════════════

  app.post('/v1/content/evaluate', handleContentEvaluate);

  // ═══════════════════════════════════════════════════════════════════
  // Channel Management
  // ═══════════════════════════════════════════════════════════════════

  app.post('/channels/refresh', async (c) => {
    const body = await c.req.json();
    const { channelToken } = body;

    if (!channelToken) {
      return c.json({ error: 'Missing channelToken' }, 400);
    }

    const agent = getAgentByToken(channelToken);
    if (!agent) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    const newToken = rotateChannelToken(agent.agentId);
    if (!newToken) {
      return c.json({ error: 'Failed to rotate token' }, 500);
    }

    await persist(options);

    return c.json({
      channelToken: newToken.token,
      expiresAt: newToken.expiresAt,
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════════════════════════════

  app.get('/stats', (c) => {
    const channelStats = getChannelStats();
    const agents = getAllAgents();
    const config = getBackendConfig();

    return c.json({
      agents: agents.length,
      channels: channelStats,
      uptime: options.getUptime(),
      backends: {
        commitment: config.commitmentBackend,
        archive: config.archiveBackend,
      },
      logging: {
        commitments: getCommitmentCount(),
        archives: getArchiveCount(),
      },
    });
  });

  /**
   * GET /internal/llm-usage-stats — read-only counters for the LLM-gateway
   * metering pipeline (enqueue→buffer→flush). No secrets; makes the Fargate
   * usage-reporter observable without CloudWatch access. Diagnoses whether a
   * proxied completion carried usage (completionsSeen vs completionsWithUsage)
   * and whether the buffered flush lands (enqueued vs flushOk + lastFlushStatus).
   */
  app.get('/internal/llm-usage-stats', (c) => {
    return c.json({ ...getUsageReporterStats(), identity: getIdentityStats() });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Dev-only endpoints for integration tests
  // ═══════════════════════════════════════════════════════════════════
  //
  // The /logs/* readers live here too (#1378): they expose the audit-event
  // ring — agent ids, message hashes, policy detections, archive refs and the
  // short-lived agent binding tokens — and the in-memory commitment store.
  // Management is the authoritative, authenticated audit surface; nothing
  // deployed reads these routes.

  if (isDevMode) {
    app.get('/logs/commitment/:hash', async (c) => {
      const hash = c.req.param('hash');
      const exists = await verifyCommitmentExists(hash);

      return c.json({
        hash,
        verified: exists,
        backend: getCommitmentBackendName(),
      });
    });

    app.get('/logs/commitments', (c) => {
      const config = getBackendConfig();

      if (config.commitmentBackend !== 'memory') {
        return c.json(
          { error: 'Commitment listing only available with memory backend' },
          400,
        );
      }

      const commitments = getAllCommitments();
      return c.json({
        count: commitments.length,
        commitments: commitments.map(
          (entry: {
            commitment: AuditCommitment;
            entryId: string;
            timestamp: number;
          }) => ({
            ...entry.commitment,
            entryId: entry.entryId,
            loggedAt: entry.timestamp,
          }),
        ),
      });
    });

    /**
     * Read-side surface on the reporter's in-memory audit buffer. In
     * management-configured deployments this buffer flushes upstream every
     * 500ms; in standalone (OSS) deployments without management it persists
     * up to MAX_BUFFER_SIZE recent entries as a ring buffer for tests and
     * dashboards. Filter with ?agentId=... and limit with ?limit=N.
     */
    app.get('/logs/audit-events', (c) => {
      const entries = getAuditEventBuffer();
      const agentId = c.req.query('agentId');
      const limitParam = c.req.query('limit');
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

      let filtered = agentId
        ? entries.filter((e) => e.agentId === agentId)
        : [...entries];

      if (Number.isFinite(limit) && limit !== undefined && limit > 0) {
        filtered = filtered.slice(-limit);
      }

      return c.json({ count: filtered.length, events: filtered });
    });

    app.post('/admin/reset-rate-limits', (c) => {
      adminIpBuckets.clear();
      adminAuthFailBuckets.clear();
      adminGlobalBucket.count = 0;
      adminGlobalBucket.resetAt = 0;
      return c.json({ ok: true });
    });

    app.post('/internal/reset-policy-rate-limits', (c) => {
      getSharedRateLimiter().reset();
      return c.json({ ok: true });
    });

    app.post('/internal/policies/invalidate', (c) => {
      const agentId = c.req.query('agentId');
      if (agentId) {
        invalidateAgentPolicies(agentId);
        return c.json({ invalidated: agentId });
      }
      return c.json({ error: 'agentId query parameter required' }, 400);
    });

    app.post('/internal/reporter/flush', async (c) => {
      const flushed = await flushReporterBuffer();
      return c.json({ flushed });
    });
  }

  return app;
}

// ═══════════════════════════════════════════════════════════════════
// Test helpers — exported separately so unit tests can reach into
// request-parsing / replay-defense helpers without spinning up a full
// Hono instance.
// ═══════════════════════════════════════════════════════════════════

export const __testables = {
  parseAdminEvaluateRequest,
  checkReplayDefensePersistent,
  sanitizeEvaluationSummary,
};
