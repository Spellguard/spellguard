// SPDX-License-Identifier: Apache-2.0

// Import from @spellguard/ctls
import { AsyncLocalStorage } from 'node:async_hooks';
import { fetchAndVerifyVerifier } from '@spellguard/ctls/client';
import { sign } from '@spellguard/ctls/crypto';
import type { AttestationResult, Evidence } from '@spellguard/ctls/types';

// Import from @spellguard/amp
import {
  type UnilateralSendResult,
  decryptFromVerifier,
  deriveAgentKeyPair,
  encryptForVerifier,
} from '@spellguard/amp/client';

import { getCurrentCorrelationId, getCurrentHops } from './hop-context';
// Local types
import type {
  ClientChannel,
  ResolvedAgent,
  SpellguardConfig,
  SpellguardDiscoveryConfig,
  UnilateralSendOptions,
} from './types';

/**
 * Inject the current hop count and correlation id from the trace
 * context (`hop-context.ts`) into an outbound payload.  Mutates a
 * shallow copy when the payload is a plain object so the caller's
 * original is untouched; passes other shapes through unchanged
 * (encrypted blobs, primitives, arrays — none of those carry trace
 * stamps).  Existing `_spellguard*` fields on the caller's payload
 * win, so an explicit override at the call site is preserved.
 */
function stampTraceContext(payload: unknown): unknown {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  const existing = payload as Record<string, unknown>;
  const stamps: Record<string, unknown> = {};
  if (existing._spellguardHops === undefined) {
    stamps._spellguardHops = getCurrentHops();
  }
  const correlationId = getCurrentCorrelationId();
  if (existing._spellguardCorrelationId === undefined && correlationId) {
    stamps._spellguardCorrelationId = correlationId;
  }
  if (Object.keys(stamps).length === 0) {
    return payload;
  }
  return { ...existing, ...stamps };
}

// ────────────────────────────────────────────────────────────────────
// Per-agent attestation state
// ────────────────────────────────────────────────────────────────────
//
// A single worker may host multiple agent identities (e.g. the
// the demo fleet worker multiplexes 20 agents behind /agents/:agentId/*).
// Each agent needs its own channel/config/discoveryConfig — using
// module-level singletons causes agents to overwrite each other's
// state on every initialize() and produces cross-agent sends with the
// wrong identity.
//
// We scope the four pieces of state that used to be module-level
// (channelPromise, currentConfig, discoveryConfig, rediscoveryPromise)
// into an AsyncLocalStorage-backed AttestationState object.  The Hono
// middleware in spellguard.ts wraps each request in its per-instance
// state via runWithAttestationState(), so all attestation-layer calls
// within that async call-chain see the correct identity.
//
// For callers that interact with these functions OUTSIDE a middleware
// (e.g. openclaw-plugin's eagerConfigure(), or unit tests that call
// configure() directly), we fall back to a module-level rootState.
// Single-agent deployments work unchanged: their one createSpellguard
// instance's middleware always wraps requests in the same per-
// instance state, and tooling that predates the middleware reads the
// rootState.

export interface AttestationState {
  channelPromise: Promise<ChannelImpl> | null;
  currentConfig: SpellguardConfig | null;
  discoveryConfig: SpellguardDiscoveryConfig | null;
  rediscoveryPromise: Promise<void> | null;
  /** When a pinned-key mismatch last re-ran discovery (#1259); 0 = never. */
  lastPinRefreshAt: number;
  /**
   * When the management token discovery handed out is due for renewal (epoch
   * ms); 0 = no token from discovery, nothing to renew.
   */
  managementTokenRenewAt: number;
}

const attestationContext = new AsyncLocalStorage<AttestationState>();

const rootState: AttestationState = {
  channelPromise: null,
  currentConfig: null,
  discoveryConfig: null,
  rediscoveryPromise: null,
  lastPinRefreshAt: 0,
  managementTokenRenewAt: 0,
};

function state(): AttestationState {
  return attestationContext.getStore() ?? rootState;
}

/**
 * Allocate a fresh AttestationState.  Each createSpellguard instance
 * owns one (per-agent), so agent-scoped channel/config/discovery
 * persist across requests to that agent.
 */
export function createAttestationState(): AttestationState {
  return {
    channelPromise: null,
    currentConfig: null,
    discoveryConfig: null,
    rediscoveryPromise: null,
    lastPinRefreshAt: 0,
    managementTokenRenewAt: 0,
  };
}

/**
 * Run `fn` with the given AttestationState installed in AsyncLocalStorage.
 * All calls to configure() / getConfig() / getOrCreateChannel() / etc.
 * inside `fn` will read and write `state` instead of the module-level
 * rootState.
 *
 * The Hono middleware in spellguard.ts uses this to isolate each agent's
 * state when multiple createSpellguard instances share a single worker.
 */
export function runWithAttestationState<T>(
  state: AttestationState,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return attestationContext.run(state, fn);
}

/**
 * Configure the Spellguard client.
 * Must be called before getOrCreateChannel().
 *
 * Writes to the ALS-scoped state if present, otherwise to the module-
 * level rootState (for direct callers outside middleware).
 */
export function configure(config: SpellguardConfig): void {
  const s = state();
  s.currentConfig = config;
  // Reset channel if config changes
  s.channelPromise = null;
  // A token configured directly has no known lifetime; discovery sets one.
  s.managementTokenRenewAt = 0;
}

/**
 * Get or create a channel to the Verifier.
 * Handles implicit channel establishment via attestation.
 */
// Per-agent X25519 keypair for gateway-opaque app-layer encryption, DERIVED
// deterministically from the agent's stable secret (agent-secret → signing key)
// and cached per-seed. Determinism is load-bearing: the agent registers its
// PUBLIC key at one point and decrypts inbound at another — possibly in a
// different process/instance (ephemeral or multi-instance agents). A random
// per-process key would NOT match across those, so the Verifier would encrypt
// to a stale pubkey the receiving process can't decrypt (the bug this fixes).
// Deriving from the stable secret makes every instance of an agent produce the
// SAME keypair. An agent with NO secret material can't derive a secure key →
// `undefined` → it stays on the legacy plaintext path (registers no pubkey).
const clientKeyPairCache = new Map<
  string,
  { publicKeyHex: string; privateKeyHex: string }
>();

export function getClientKeyPair():
  | { publicKeyHex: string; privateKeyHex: string }
  | undefined {
  const config = getConfig();
  const seed = config?.agentSecret || config?.signingPrivateKey;
  if (!seed) return undefined;
  let kp = clientKeyPairCache.get(seed);
  if (!kp) {
    kp = deriveAgentKeyPair(seed);
    clientKeyPairCache.set(seed, kp);
  }
  return kp;
}

// The Verifier's X25519 session public key, captured at registration so the
// inbound receive handler can encrypt this agent's reply back TO the Verifier
// (return leg of gateway-opaque encryption). Undefined ⇒ legacy plaintext reply.
let verifierX25519PublicKey: string | undefined;

/** The Verifier's X25519 public key from the last registration, if any. */
export function getVerifierPublicKey(): string | undefined {
  return verifierX25519PublicKey;
}

export async function getOrCreateChannel(): Promise<ClientChannel> {
  const s = state();
  if (!s.currentConfig) {
    throw new Error('Spellguard not configured. Call configure() first.');
  }

  if (!s.channelPromise) {
    const config = s.currentConfig;
    s.channelPromise = establishChannel(config).catch((err) => {
      // Clear cached promise so the next call retries instead of
      // returning the same rejected promise forever.
      s.channelPromise = null;
      throw err;
    });
  }

  return s.channelPromise;
}

/**
 * Environment variable that opts a process into MOCK attestation — the Verifier
 * is trusted without checking its image hash, timestamp, or signature.
 *
 * It must be set to exactly `"true"`, and it is refused outright against a
 * production configuration (see `resolveMockAttestationMode`). Mock mode is
 * never inferred from the configured image hash: doing so is what let absent
 * server-side config silently disable attestation everywhere.
 */
export const MOCK_ATTESTATION_ENV_VAR = 'SPELLGUARD_ALLOW_MOCK_ATTESTATION';

/** Reason code carried by the refusal thrown when the flag is set in prod. */
export const MOCK_ATTESTATION_FORBIDDEN_REASON =
  'mock_attestation_forbidden_in_production';

/**
 * Shared or real Spellguard environments: the `spellguard.ai` apex (production)
 * and every subdomain beneath it, which covers each shared pre-production
 * environment as well as prod. Deliberately matches the whole tree rather than
 * enumerating environments — a new shared env is covered the day it is created,
 * and no internal hostname is written down here. Mirrors the deny-first host
 * classification Spellguard's own conformance tooling uses.
 */
const PRODUCTION_HOST_PATTERNS: readonly RegExp[] = [/(^|\.)spellguard\.ai$/i];

/**
 * Hosts where mock attestation MAY be enabled: a local stack, or a throwaway
 * dev-stack (per-developer, ephemeral, torn down with `dev:cloud:down`).
 *
 * Deliberately an allow-list: an unrecognized host — a customer's self-hosted
 * Verifier, an unknown staging origin — is treated as production, so the
 * bypass cannot reach an environment nobody classified.
 *
 * `*.workers.dev` is NOT blanket-allowed. A deployed environment is a
 * Cloudflare Worker that can also answer on its account's `workers.dev`
 * subdomain, the same subdomain the throwaway stacks use, so a blanket allow
 * would reach real environments too. The allow is matched on the throwaway's
 * NAME SHAPE instead:
 * `spellguard-<service>-dev-<developer>` — the trailing developer segment is
 * what distinguishes an ephemeral stack (`…-management-dev-cli-e2e`) from the
 * shared, real `dev` environment (`…-management-dev`, refused).
 *
 * Matching the shape rather than denying a list of known deployed names is
 * deliberate: a new worker or environment added later is refused by default
 * instead of silently inheriting the bypass.
 */
const NON_PRODUCTION_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127(\.\d+){3}$/,
  /^\[?::1\]?$/,
  /^0\.0\.0\.0$/,
  /^spellguard-[a-z0-9-]+-dev-[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.workers\.dev$/i,
];

/**
 * Read an env var in whichever runtime we're on.
 *
 * Returns undefined on Cloudflare Workers. Not because `process` is missing —
 * under `nodejs_compat` both `process` and `process.env` exist — but because
 * `process.env` is an EMPTY object there: workerd does not populate it from the
 * `vars` block at the compatibility dates this repo's agents pin (measured on
 * workerd via `wrangler dev --local` at `compatibility_date` 2024-12-01 +
 * `nodejs_compat`: `typeof process.env === 'object'`, 0 keys, while the same
 * var read off the `env` binding is present).
 *
 * So any setting that must work on a Worker belongs on the config, not here.
 */
function readEnvVar(name: string): string | undefined {
  return globalThis.process?.env?.[name];
}

/**
 * True when `url` is NOT a recognized local/throwaway target. Deny-first, and
 * an unparseable or unrecognized URL counts as production (fail closed).
 */
function isProductionUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  if (PRODUCTION_HOST_PATTERNS.some((deny) => deny.test(host))) return true;
  return !NON_PRODUCTION_HOST_PATTERNS.some((ok) => ok.test(host));
}

/**
 * Decide whether this channel may skip Verifier attestation (decision D1).
 *
 * Mock mode requires BOTH:
 *   1. `SPELLGUARD_ALLOW_MOCK_ATTESTATION=true` — an explicit operator opt-in.
 *   2. A non-production configuration — every URL this agent talks to
 *      (Verifier, and management when present) resolves to a local stack or a
 *      throwaway `*.workers.dev` dev-stack.
 *
 * Setting the flag against a production configuration THROWS rather than being
 * quietly ignored: an attempt to disable attestation in production is a
 * misconfiguration worth surfacing, not one to paper over.
 */
export function resolveMockAttestationMode(config: SpellguardConfig): boolean {
  if (readEnvVar(MOCK_ATTESTATION_ENV_VAR) !== 'true') return false;

  const productionUrls = [config.verifierUrl, config.managementUrl]
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
    .filter((url) => isProductionUrl(url));

  if (productionUrls.length > 0) {
    throw new Error(
      `${MOCK_ATTESTATION_ENV_VAR}=true refused [${MOCK_ATTESTATION_FORBIDDEN_REASON}]: mock attestation may only be enabled against a local stack or a throwaway *.workers.dev dev-stack, but this agent is configured against ${productionUrls.join(', ')}. Unset ${MOCK_ATTESTATION_ENV_VAR} or point the agent at a development environment.`,
    );
  }

  return true;
}

/**
 * Create a new channel to the Verifier with bidirectional attestation.
 */
/**
 * Establish a channel, renewing the management token first when it is due.
 *
 * Registration presents the management token, which expires an hour after
 * discovery; the Verifier refuses an expired one even with a valid agent
 * secret. Renewing it through discovery first means an agent that re-registers
 * after its first hour (a restarted Verifier, a stale channel token) is not
 * refused. Re-discovery reconfigures and registers with the new token.
 */
async function establishChannel(
  config: SpellguardConfig,
): Promise<ChannelImpl> {
  if (!managementTokenDue()) return createChannel(config);
  console.log(
    '[Spellguard] Management token due for renewal, re-running discovery...',
  );
  await rediscover();
  return (await getOrCreateChannel()) as ChannelImpl;
}

async function createChannel(config: SpellguardConfig): Promise<ChannelImpl> {
  console.log(`[Spellguard] Creating channel for ${config.agentId}...`);

  // Step 1: Verify Verifier before sending any secrets.
  //
  // Mock mode is decided by an explicit operator opt-in ONLY — never inferred
  // from `expectedVerifierImageHash`. When the management server has recorded
  // no Verifier image hash the field stays undefined and verification fails
  // closed with `verifier_image_hash_unconfigured`, instead of the absent
  // config silently switching attestation off.
  const isMockMode = resolveMockAttestationMode(config);

  const verifierVerification = await fetchAndVerifyVerifier(
    config.verifierUrl,
    config.expectedVerifierImageHash ?? '',
    {
      mockMode: isMockMode,
      expectedPublicKey: config.expectedVerifierPublicKey,
    },
  );

  if (!verifierVerification.verified) {
    // #1259: a Verifier restart changes its session key (and a redeploy its
    // measurement) before our discovery pin catches up. Re-run discovery once
    // and retry against management's fresh attestation; a second mismatch
    // within the window fails closed.
    if (
      (verifierVerification.reason === 'verifier_key_mismatch' ||
        verifierVerification.reason === 'image_hash_mismatch') &&
      claimPinRefresh()
    ) {
      console.warn(
        `[Spellguard] Verifier attestation [${verifierVerification.reason}] — re-running discovery once for a fresh pin`,
      );
      await rediscover();
      return (await getOrCreateChannel()) as ChannelImpl;
    }
    throw new Error(
      `Verifier attestation failed [${verifierVerification.reason ?? 'unknown'}]: ${verifierVerification.error}\nThis could indicate a compromised or fake Verifier. Connection refused.`,
    );
  }

  console.log('[Spellguard] Verifier verified successfully');

  // Step 2: Build and sign evidence
  const evidence: Evidence = {
    agentId: config.agentId,
    claims: {
      codeHash: config.codeHash,
      endpoint: `${config.selfUrl}/_spellguard/receive`,
      agentCardUrl: `${config.selfUrl}/.well-known/agent.json`,
      capabilities: ['receive', 'send'],
    },
    signature: '', // Will be set below
  };

  // Sign the evidence with real signing key if available, else fall back to codeHash seed.
  //
  // CR-001 (verifier-side): the Verifier validates the signature over
  // BOTH agentId and claims to prevent identity substitution
  // (packages/ctls/ts/src/server/verifier.ts:188).  Sign over the same
  // shape here — signing only `claims` produces a signature the
  // Verifier rejects with "Invalid evidence signature" whenever it has
  // a real agent public key to verify against (i.e. managed mode where
  // X-Spellguard-Management-Token carries agent.public_key).
  const evidenceData = JSON.stringify({
    agentId: evidence.agentId,
    claims: evidence.claims,
  });
  const signingKey = config.signingPrivateKey || config.codeHash;
  evidence.signature = await sign(evidenceData, signingKey);

  // Step 3: Register with Verifier
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.agentSecret) {
    headers['X-Spellguard-Agent-Secret'] = config.agentSecret;
  }
  if (config.managementToken) {
    headers['X-Spellguard-Management-Token'] = config.managementToken;
  }

  const response = await fetch(`${config.verifierUrl}/agents/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      evidence,
      clientPublicKey: getClientKeyPair()?.publicKeyHex,
    }),
    // Slim profile routes this through the gateway→SLIM→verifier hop, whose
    // cold-session establishment runs ~20-30s. 10s aborted registration
    // before the session warmed. (c976c0c4 raised the message routes to
    // 120s but left this control-plane call at 10s.)
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to register with Verifier: ${response.status} ${error}`,
    );
  }

  const attestation = (await response.json()) as AttestationResult;

  if (!attestation.verified) {
    throw new Error('Verifier rejected our evidence');
  }

  // #1259: the key registration hands back is the key everything later trusts
  // (verdicts, and #1244's signed deliveries). It must be the key this Verifier
  // was just attested with, and the key management attested.
  const attestedKey =
    verifierVerification.attestation?.publicKey ??
    config.expectedVerifierPublicKey;
  if (
    (attestedKey !== undefined &&
      attestation.sessionPublicKey !== attestedKey) ||
    (config.expectedVerifierPublicKey !== undefined &&
      attestation.sessionPublicKey !== config.expectedVerifierPublicKey)
  ) {
    throw new Error(
      `Verifier attestation failed [verifier_key_mismatch]: registration returned session key ${attestation.sessionPublicKey}, but the attested key is ${attestedKey}. Connection refused.`,
    );
  }
  verifierX25519PublicKey = attestation.sessionX25519PublicKey;

  console.log(
    `[Spellguard] Channel established. Token expires: ${new Date(attestation.expiresAt).toISOString()}`,
  );

  return new ChannelImpl(
    config,
    attestation.channelToken,
    attestation.sessionPublicKey,
    attestation.sessionX25519PublicKey,
    attestation.deliveryAuth,
  );
}

/**
 * Channel implementation.
 */
class ChannelImpl implements ClientChannel {
  private config: SpellguardConfig;
  private channelToken: string;
  private sessionPublicKey: string;
  private sessionX25519PublicKey: string | undefined;
  private deliveryAuth: 'v1' | undefined;
  private closed = false;
  private isRetry = false;

  constructor(
    config: SpellguardConfig,
    channelToken: string,
    sessionPublicKey: string,
    sessionX25519PublicKey?: string,
    deliveryAuth?: 'v1',
  ) {
    this.config = config;
    this.channelToken = channelToken;
    this.sessionPublicKey = sessionPublicKey;
    this.sessionX25519PublicKey = sessionX25519PublicKey;
    this.deliveryAuth = deliveryAuth === 'v1' ? 'v1' : undefined;
  }

  /**
   * What this agent trusts a delivery by (#1244): the session key from its own
   * attested registration, and whether that registration advertised signed
   * deliveries. Never anything a delivery supplies.
   */
  getDeliveryTrust(): DeliveryTrust {
    return {
      sessionPublicKey: this.sessionPublicKey,
      deliveryAuth: this.deliveryAuth,
    };
  }

  /** Get the Verifier URL for direct API calls. */
  getVerifierUrl(): string {
    return this.config.verifierUrl;
  }

  /** Get the channel token for authenticated Verifier requests. */
  getChannelToken(): string {
    return this.channelToken;
  }

  /** Get the agent ID associated with this channel. */
  getAgentId(): string {
    return this.config.agentId;
  }

  /**
   * Re-discover the Verifier from management, establish a fresh channel,
   * and retry the given operation once.
   */
  private async retryAfterRediscovery<T>(
    fn: (channel: ChannelImpl) => Promise<T>,
  ): Promise<T> {
    console.log(
      '[Spellguard] Verifier unreachable, re-discovering from management...',
    );
    await rediscover();
    const newChannel = (await getOrCreateChannel()) as ChannelImpl;
    newChannel.isRetry = true;
    try {
      return await fn(newChannel);
    } finally {
      newChannel.isRetry = false;
    }
  }

  /**
   * Send a message to another agent through Verifier.
   */
  async send(
    recipient: string,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error('Channel is closed');
    }

    // Stamp the current trace context (hops + correlation id) onto
    // the payload before encryption so the Verifier and the
    // recipient's middleware can keep multi-hop conversations
    // linked under a single audit_logs.correlation_id.  Caller-set
    // _spellguard* fields win, so explicit overrides at the call
    // site are preserved.
    const stampedPayload = stampTraceContext(payload);
    // Encrypt payload for Verifier using X25519 key (falls back to Ed25519 key for backward compat)
    const payloadJson = JSON.stringify(stampedPayload);
    const encryptionKey = this.sessionX25519PublicKey || this.sessionPublicKey;
    const encryptedPayload = encryptForVerifier(payloadJson, encryptionKey);

    let response: Response;
    try {
      response = await fetch(`${this.config.verifierUrl}/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': this.channelToken,
        },
        body: JSON.stringify({
          sender: this.config.agentId,
          recipient,
          encryptedPayload,
        }),
        // 120s covers verifier-side LLM-bearing routing (the route
        // can synchronously call the destination agent's LLM —
        // observed ~65s). Cloudflare Workers' default subrequest
        // timeout is 30s, so without an explicit signal the agent
        // gives up before the verifier finishes.  The peer fan-out passes a
        // shorter budget-derived timeout so a wedged send can't overrun the
        // proxy's /chat window (see FANOUT_BUDGET_MS in ai.ts).
        signal: AbortSignal.timeout(options?.timeoutMs ?? 120_000),
      });
    } catch (fetchError) {
      // Network error — Verifier may be down. Re-discover if possible.
      if (!this.isRetry && state().discoveryConfig) {
        return this.retryAfterRediscovery((ch) =>
          ch.send(recipient, payload, options),
        );
      }
      throw fetchError;
    }

    if (!response.ok) {
      const error = await response.text();

      // Check if we need to re-register (Verifier might have restarted)
      if (
        error.includes('Sender not registered') ||
        error.includes('Invalid or expired') ||
        response.status === 401
      ) {
        console.log('[Spellguard] Channel token stale, re-registering...');
        // Invalidate cached channel and retry with a fresh channel (once)
        if (!this.isRetry) {
          invalidateChannel();
          try {
            const newChannel = (await getOrCreateChannel()) as ChannelImpl;
            newChannel.isRetry = true;
            try {
              return await newChannel.send(recipient, payload, options);
            } finally {
              newChannel.isRetry = false;
            }
          } catch (reregErr) {
            // Re-registration failed — Verifier may have moved. Try re-discovery.
            if (state().discoveryConfig && isVerifierUnreachable(reregErr)) {
              return this.retryAfterRediscovery((ch) =>
                ch.send(recipient, payload, options),
              );
            }
            throw reregErr;
          }
        }
      }

      throw new Error(`Failed to send message: ${response.status} ${error}`);
    }

    const result = (await response.json()) as { response: unknown };
    // Return leg: when the Verifier encrypted the response to our key, decrypt
    // it with our private key. Legacy plaintext responses pass through.
    const resp = result.response;
    const keyPair = getClientKeyPair();
    if (
      keyPair &&
      resp &&
      typeof resp === 'object' &&
      typeof (resp as { encryptedResponse?: unknown }).encryptedResponse ===
        'string'
    ) {
      return JSON.parse(
        decryptFromVerifier(
          (resp as { encryptedResponse: string }).encryptedResponse,
          keyPair.privateKeyHex,
        ),
      );
    }
    return resp;
  }

  /**
   * Send a prompt with agent context through Verifier.
   * Used when the prompt references other agents.
   */
  async sendWithAgentContext(options: {
    originalPrompt: string;
    targetAgents: ResolvedAgent[];
    model: unknown;
  }): Promise<unknown> {
    const { originalPrompt, targetAgents } = options;

    // For each target agent, send the request through Verifier
    // In a more sophisticated implementation, we might orchestrate multiple agents
    if (targetAgents.length === 0) {
      throw new Error('No target agents specified');
    }

    // For now, send to the first target agent
    // TODO: Implement multi-agent orchestration
    const targetAgent = targetAgents[0];

    const payload = {
      type: 'agent-request',
      prompt: originalPrompt,
      from: this.config.agentId,
      context: {
        targetAgents: targetAgents.map((a) => a.name),
      },
    };

    return this.send(targetAgent.name, payload);
  }

  /**
   * Send directly to AI model through Verifier.
   * The request is logged but not routed to another agent.
   */
  async sendToModel(_options: unknown): Promise<unknown> {
    // For now, this is a passthrough
    // In a full implementation, this would route through Verifier for logging
    // but go directly to the AI model
    throw new Error('Direct model calls not yet implemented through Verifier');
  }

  /**
   * Send a message to an A2A-only agent through Verifier (unilateral attestation).
   * The Verifier logs commitments for both the outbound request and inbound response.
   * Attestation level is 'unilateral' since only the sender is Spellguard-attested.
   */
  async sendToA2A(
    a2aAgentUrl: string,
    payload: unknown,
    options?: UnilateralSendOptions,
  ): Promise<UnilateralSendResult> {
    if (this.closed) {
      throw new Error('Channel is closed');
    }

    // Stamp the current trace context (hops + correlation id) onto
    // the payload before encryption so the Verifier and the
    // recipient's middleware can keep multi-hop conversations
    // linked under a single audit_logs.correlation_id.  Caller-set
    // _spellguard* fields win, so explicit overrides at the call
    // site are preserved.
    const stampedPayload = stampTraceContext(payload);
    // Encrypt payload for Verifier using X25519 key (falls back to Ed25519 key for backward compat)
    const payloadJson = JSON.stringify(stampedPayload);
    const encryptionKey = this.sessionX25519PublicKey || this.sessionPublicKey;
    const encryptedPayload = encryptForVerifier(payloadJson, encryptionKey);

    let response: Response;
    try {
      response = await fetch(`${this.config.verifierUrl}/messages/unilateral`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': this.channelToken,
        },
        body: JSON.stringify({
          sender: this.config.agentId,
          a2aAgentUrl,
          payload: encryptedPayload,
          method: options?.method || 'tasks/send',
        }),
        // 120s — same rationale as /messages/send: the unilateral
        // route can hit an A2A endpoint whose handler runs an LLM
        // call, exceeding the 30s Workers subrequest default.
        signal: AbortSignal.timeout(120_000),
      });
    } catch (fetchError) {
      // Network error — Verifier may be down. Re-discover if possible.
      if (!this.isRetry && state().discoveryConfig) {
        return this.retryAfterRediscovery((ch) =>
          ch.sendToA2A(a2aAgentUrl, payload, options),
        );
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as {
        correlationId?: string;
        error?: string;
        commitments?: { outbound: Record<string, string> };
        warnings?: string[];
      };

      // Check if we need to re-register (Verifier might have restarted)
      const errorMsg = errorData.error || '';
      if (
        errorMsg.includes('Invalid or expired') ||
        errorMsg.includes('Sender not registered') ||
        response.status === 401
      ) {
        // Retry once with a fresh channel
        if (!this.isRetry) {
          console.log(
            '[Spellguard] Channel token stale during A2A send, re-registering...',
          );
          invalidateChannel();
          try {
            const newChannel = (await getOrCreateChannel()) as ChannelImpl;
            newChannel.isRetry = true;
            try {
              return await newChannel.sendToA2A(a2aAgentUrl, payload, options);
            } finally {
              newChannel.isRetry = false;
            }
          } catch (reregErr) {
            // Re-registration failed — Verifier may have moved. Try re-discovery.
            if (state().discoveryConfig && isVerifierUnreachable(reregErr)) {
              return this.retryAfterRediscovery((ch) =>
                ch.sendToA2A(a2aAgentUrl, payload, options),
              );
            }
            throw reregErr;
          }
        }
      }

      return {
        success: false,
        correlationId: errorData.correlationId || '',
        error: errorData.error || `Request failed: ${response.status}`,
        commitments: errorData.commitments || { outbound: {} },
        warnings: errorData.warnings,
      };
    }

    return (await response.json()) as UnilateralSendResult;
  }

  /**
   * Close the channel.
   */
  close(): void {
    this.closed = true;
    console.log(`[Spellguard] Channel closed for ${this.config.agentId}`);
  }
}

/**
 * Get the Verifier URL and channel token for tool policy checks.
 * Returns null if the client is not configured or channel not established.
 */
export function getEncryptionContext(): {
  verifierUrl: string;
  channelToken: string;
  agentId: string;
} | null {
  if (!state().currentConfig) return null;
  // The channel token is only available after channel creation,
  // but we can't access it synchronously. This is resolved via
  // checkToolPolicy which awaits getOrCreateChannel().
  return null;
}

/**
 * Result of a tool policy check.
 */
export interface ToolCheckResult {
  effect: 'allow' | 'block' | 'redact' | 'flag';
  message?: string;
  data?: unknown;
  /**
   * Why the SDK — not the Verifier — decided this result. Set only when the
   * check could not complete; absent on every decision the Verifier made.
   */
  reason?: ToolPolicyUnavailableReason;
}

/**
 * Cause of a tool policy check that produced no decision.
 *
 * - `channel_unavailable` — no channel to the Verifier (registration failed,
 *   or `configure()` was never called).
 * - `verifier_unreachable` — the request never completed: connection failure,
 *   DNS, or the abort timeout.
 * - `verifier_refused` — the Verifier answered non-200 with no `effect`
 *   (401 bad channel token, 403 agent mismatch, 400 bad body, 5xx).
 * - `malformed_response` — the body was not JSON, or carried no recognized
 *   `effect`.
 * - `check_failed` — the check itself hit an error nobody anticipated (#1418).
 */
export type ToolPolicyUnavailableReason =
  | 'channel_unavailable'
  | 'verifier_unreachable'
  | 'verifier_refused'
  | 'malformed_response'
  | 'check_failed';

/**
 * Effects the Verifier is allowed to return. A body carrying anything else is
 * not a decision, and is treated as an unavailable check rather than an allow.
 */
const TOOL_CHECK_EFFECTS: ReadonlySet<string> = new Set([
  'allow',
  'block',
  'redact',
  'flag',
]);

/**
 * The effects that DENY the call: the tool does not run with its original
 * content. `allow` and `flag` both let it through (`flag` just alerts too).
 *
 * Only these are honoured off a non-2xx — see `readToolCheckDecision`.
 */
const CALL_DENYING_EFFECTS: ReadonlySet<string> = new Set(['block', 'redact']);

/**
 * Environment-variable form of `SpellguardConfig.failOpen`, for consumers whose
 * config the SDK never sees: `createSpellguard()` callers, and processes that
 * wrap tools without calling `configure()` at all.
 *
 * Must be exactly `'true'`. An explicit `failOpen` on the config wins over it.
 *
 * Setting it means a tool call RUNS UNCHECKED whenever the policy check cannot
 * complete — every policy bound to that tool is skipped for the duration.
 */
export const TOOL_POLICY_FAIL_OPEN_ENV_VAR = 'SPELLGUARD_TOOL_POLICY_FAIL_OPEN';

/** Whether this process has opted out of the fail-closed default. */
function resolveToolPolicyFailOpen(): boolean {
  const configured = state().currentConfig?.failOpen;
  if (typeof configured === 'boolean') return configured;
  return readEnvVar(TOOL_POLICY_FAIL_OPEN_ENV_VAR) === 'true';
}

/**
 * Build the result for a check that produced no decision.
 *
 * Fails CLOSED by default (§2): a tool whose policies could not be consulted
 * does not run. `failOpen` converts that to an allow, and says so loudly —
 * silently allowing is exactly the defect this replaced.
 */
function toolPolicyUnavailable(
  reason: ToolPolicyUnavailableReason,
  detail: string,
): ToolCheckResult {
  if (resolveToolPolicyFailOpen()) {
    console.warn(
      `[Spellguard] Tool policy check unavailable (${reason}: ${detail}) — failing OPEN because failOpen is set; this tool call runs UNCHECKED.`,
    );
    return { effect: 'allow', reason };
  }
  console.warn(
    `[Spellguard] Tool policy check unavailable (${reason}: ${detail}) — failing closed.`,
  );
  return {
    effect: 'block',
    message: `[Spellguard] Tool call blocked: the policy check could not complete (${reason}).`,
    reason,
  };
}

/**
 * Read the Verifier's decision out of a response, or `null` when it made none.
 *
 * A 2xx body is honoured whatever it says. Off a NON-2xx the rule is one-way:
 * only a decision that DENIES the call is honoured. That keeps the property
 * that matters — the Verifier's own fail-closed answer when it cannot load
 * policy data is `503 { effect: 'block' }`, and discarding it because 503 is
 * not 200 turned the one case it is designed to block into an allow (§2) —
 * without letting the same door swing the other way. A non-2xx carrying
 * `allow` (or `flag`, which also lets the call through) is not a decision
 * anyone intends: it is an error response that happens to contain the field,
 * and honouring it would be the only remaining path by which a failed request
 * grants permission.
 *
 * No live handler emits one today: every error branch of
 * `packages/verifier/src/app.ts`'s `/v1/tools/check` omits `effect` entirely
 * except the 503, which sends `block`. This closes the shape of the hole, not
 * an observed instance of it.
 */
async function readToolCheckDecision(
  response: Response,
): Promise<ToolCheckResult | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object') return null;
  const { effect, message, data } = body as {
    effect?: unknown;
    message?: unknown;
    data?: unknown;
  };
  if (typeof effect !== 'string' || !TOOL_CHECK_EFFECTS.has(effect))
    return null;
  if (!response.ok && !CALL_DENYING_EFFECTS.has(effect)) return null;
  return {
    effect: effect as ToolCheckResult['effect'],
    ...(typeof message === 'string' ? { message } : {}),
    ...(data === undefined ? {} : { data }),
  };
}

/**
 * The Verifier's rule for a correlation id on the tool check
 * (`packages/verifier/src/session/keys.ts`): 1-128 characters of
 * `[A-Za-z0-9._:-]`. A UUID, the SDK's own ids, always passes.
 */
const TOOL_CHECK_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The correlation id to send on a tool check, or undefined to send none. */
export function toolCheckCorrelationId(
  correlationId: string | undefined,
): string | undefined {
  return correlationId !== undefined &&
    TOOL_CHECK_CORRELATION_ID.test(correlationId)
    ? correlationId
    : undefined;
}

/**
 * Check tool call content against policies via the Verifier's /v1/tools/check
 * endpoint.
 *
 * **Fails CLOSED.** A check that cannot complete — unreachable Verifier,
 * timeout, refusal, malformed body, or no channel at all — returns
 * `{ effect: 'block' }` carrying a `reason`, so the wrapped tool does not run.
 * Set `SpellguardConfig.failOpen` (or `SPELLGUARD_TOOL_POLICY_FAIL_OPEN=true`)
 * to trade that enforcement for availability; the consequence is spelled out on
 * `SpellguardConfig.failOpen`.
 *
 * A **2xx** carrying a recognized `effect` is the Verifier's DECISION and is
 * returned verbatim, `failOpen` included.
 *
 * Off a **non-2xx** the rule is one-way: only a decision that DENIES the call
 * (`block`, `redact`) is honoured — that is what keeps the Verifier's own
 * `503 { effect: 'block' }` working. A non-2xx carrying `allow` or `flag`
 * (both of which let the call run) is NOT honoured; it becomes
 * `verifier_refused`, because a failed request must never grant permission.
 *
 * **Never throws** (#1418). Any other error is an unavailable check
 * (`check_failed`) and takes the same `failOpen`-aware path, so a wrapper
 * never needs a catch of its own, and never has one that fails open.
 */
export async function checkToolPolicy(
  phase: 'input' | 'output',
  toolName: string,
  params?: unknown,
  result?: unknown,
): Promise<ToolCheckResult> {
  try {
    return await requestToolPolicyDecision(phase, toolName, params, result);
  } catch (error) {
    return toolPolicyUnavailable('check_failed', String(error));
  }
}

/** The Verifier did not know the channel's token (401, no decision). */
const STALE_CHANNEL = Symbol('stale-channel');

/**
 * Ask the Verifier, re-registering once when it no longer knows this
 * channel's token, as a send does. A token goes stale when the Verifier
 * restarts or rotates its keys, when it expires, and when another instance
 * of this agent registers since: the Verifier keeps one token per agent, so
 * each registration replaces the last (#1603). Without this a stale channel
 * failed every tool check closed until something else re-registered.
 */
async function requestToolPolicyDecision(
  phase: 'input' | 'output',
  toolName: string,
  params?: unknown,
  result?: unknown,
): Promise<ToolCheckResult> {
  const first = await askToolPolicy(phase, toolName, params, result);
  if (first !== STALE_CHANNEL) return first;
  console.log(
    '[Spellguard] Channel token stale during tool check, re-registering...',
  );
  invalidateChannel();
  const retried = await askToolPolicy(phase, toolName, params, result);
  return retried === STALE_CHANNEL
    ? toolPolicyUnavailable('verifier_refused', 'HTTP 401')
    : retried;
}

async function askToolPolicy(
  phase: 'input' | 'output',
  toolName: string,
  params?: unknown,
  result?: unknown,
): Promise<ToolCheckResult | typeof STALE_CHANNEL> {
  let channel: ChannelImpl;
  try {
    channel = (await getOrCreateChannel()) as ChannelImpl;
  } catch (error) {
    return toolPolicyUnavailable('channel_unavailable', String(error));
  }

  // A tool call made while handling a message belongs to that message's
  // conversation: the receive handler runs `onMessage` inside the inbound
  // correlation id's trace context. Sending it lets the Verifier join the
  // tool-check audit row to the conversation and judge the call against the
  // agent's session. Omitted outside any trace context, and omitted when the
  // id is one the Verifier would refuse (it answers 400, which fails closed).
  const correlationId = toolCheckCorrelationId(getCurrentCorrelationId());

  let response: Response;
  try {
    response = await fetch(`${channel.getVerifierUrl()}/v1/tools/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Spellguard-Channel-Token': channel.getChannelToken(),
      },
      body: JSON.stringify({
        agentId: channel.getAgentId(),
        phase,
        toolName,
        params,
        result,
        ...(correlationId ? { correlationId } : {}),
      }),
      // Same SLIM hop as the other control-plane calls; keep above the
      // ~20-30s cold-session establishment so a first tool check after an
      // idle period doesn't abort prematurely.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    return toolPolicyUnavailable('verifier_unreachable', String(error));
  }

  const decision = await readToolCheckDecision(response);
  if (decision) return decision;
  if (response.status === 401) return STALE_CHANNEL;

  return response.ok
    ? toolPolicyUnavailable(
        'malformed_response',
        'response carried no recognized effect',
      )
    : toolPolicyUnavailable('verifier_refused', `HTTP ${response.status}`);
}

/**
 * Response shape from POST /v1/discover on the Management Server.
 */
interface DiscoveryResponse {
  verifierUrl: string;
  verifierPublicKey: string;
  verifierRegion: string;
  verifierId: string;
  verifierImageHash?: string;
  managementToken: string;
  refreshInterval: number;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

/**
 * Retry pre-registration in the background with exponential backoff.
 * Ensures the agent eventually becomes discoverable by other agents
 * even when the initial eager registration fails (e.g. Verifier cold-starting).
 *
 * Captures the current attestation state so the retry closure operates
 * on the correct per-agent context even when it fires outside the
 * original request's async scope.
 */
function retryPreRegistration(): void {
  const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes
  const BASE_DELAY_MS = 5_000;
  const MAX_DELAY_MS = 60_000;
  const startedAt = Date.now();
  let attempt = 0;
  // Snapshot the current state so setTimeout callbacks (which lose ALS
  // context) use the right agent's channel/config.
  const capturedState = state();

  function tryRegister(): void {
    attempt++;
    runWithAttestationState(capturedState, () =>
      getOrCreateChannel()
        .then(() => {
          console.log(
            `[Spellguard] Background pre-registration succeeded (attempt ${attempt})`,
          );
        })
        .catch((err) => {
          const elapsed = Date.now() - startedAt;
          if (elapsed >= MAX_DURATION_MS) {
            console.warn(
              `[Spellguard] Background pre-registration gave up after ${Math.round(elapsed / 1000)}s (${attempt} attempts): ${err}`,
            );
            return;
          }
          const delay = Math.min(
            BASE_DELAY_MS * 2 ** (attempt - 1),
            MAX_DELAY_MS,
          );
          console.warn(
            `[Spellguard] Background pre-registration attempt ${attempt} failed, retrying in ${delay / 1000}s: ${err}`,
          );
          setTimeout(tryRegister, delay);
        }),
    );
  }

  setTimeout(tryRegister, BASE_DELAY_MS);
}

/**
 * Discover a Verifier via the Management Server and configure the client.
 *
 * Calls `POST {managementUrl}/discover` with the agent's credentials, receives
 * the assigned Verifier URL, then calls `configure()` with a resolved config.
 *
 * Returns the full discovery response (including `managementToken` for refresh).
 */
export async function discoverAndConfigure(
  config: SpellguardDiscoveryConfig,
): Promise<DiscoveryResponse> {
  // Store for re-discovery when the Verifier becomes unreachable later
  state().discoveryConfig = config;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add agent secret header if provided (required for secret/dual auth mode)
  if (config.agentSecret) {
    headers['X-Spellguard-Agent-Secret'] = config.agentSecret;
  }

  // Add platform attestation header if providers are configured
  if (config.platformAttestation?.providers.length) {
    const tokens = await Promise.all(
      config.platformAttestation.providers.map(async (p) => ({
        provider: p.provider,
        token: await p.getToken(),
      })),
    );
    headers['X-Spellguard-Platform-Attestation'] = btoa(JSON.stringify(tokens));
  }

  // managementUrl convention in this codebase is split: agent-template +
  // the demo fleet wranglers + deploy.ts inject it WITH `/v1` already baked in
  // (legacy CF Worker agents); the managed-provisioning bootstrap
  // (install.ts → openclaw.json) writes it WITHOUT `/v1`. Nine existing
  // callsites already normalize defensively (e.g. plugin-sync.ts:32,
  // verifier-state.ts:165, discovery/resolver.ts:112). Match that idiom
  // here so the SDK is the canonical home for the normalization rather
  // than every caller having to remember which convention to use.
  const baseUrl = config.managementUrl
    .replace(/\/v1\/?$/, '')
    .replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/v1/discover`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: config.agentId,
      region: config.region,
      capabilities: config.capabilities,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Discovery failed: ${response.status} ${error}`);
  }

  const discovery = (await response.json()) as DiscoveryResponse;

  // #1259: management returns the session key its own challenge attested. An
  // agent has nothing to pin without it, so it fails closed rather than trust
  // whatever key the Verifier endpoint presents.
  if (!discovery.verifierPublicKey) {
    throw new Error(
      'Discovery response carries no verifierPublicKey [verifier_key_unconfigured]: the management server did not return an attested Verifier key. Connection refused.',
    );
  }

  // Configure the client with the resolved Verifier URL.
  //
  // The Verifier image hash is taken from discovery verbatim. It is left
  // UNDEFINED when the management server hasn't recorded one — never
  // substituted with a placeholder. A placeholder used to double as the mock-
  // mode trigger, so missing server config silently disabled attestation for
  // every agent in that environment; absent config must fail closed instead.
  configure({
    agentId: config.agentId,
    verifierUrl: discovery.verifierUrl,
    selfUrl: config.selfUrl,
    codeHash: config.codeHash,
    expectedVerifierImageHash: discovery.verifierImageHash,
    expectedVerifierPublicKey: discovery.verifierPublicKey,
    agentSecret: config.agentSecret,
    signingPrivateKey: config.signingPrivateKey,
    managementToken: discovery.managementToken,
    // Normalized base (no `/v1`) so the Tier-3 usage emit can reach Management
    // directly (§6.5); the emit helper appends `/v1/agents/:id/usage`.
    managementUrl: baseUrl,
    agentCard: config.agentCard,
    failOpen: config.failOpen,
  });
  // Management states the token's lifetime as issuedAt..expiresAt, in seconds.
  state().managementTokenRenewAt = tokenRenewalTime(
    discovery.expiresAt - discovery.issuedAt,
  );

  console.log(
    `[Spellguard] Discovered Verifier at ${discovery.verifierUrl} (region: ${discovery.verifierRegion})`,
  );

  // Eagerly create the channel so this agent registers with the Verifier
  // and becomes discoverable by other agents via /agents/resolve/:name.
  // Cap the total wall-clock time to avoid blocking init for 90+ seconds
  // (fetchAttestationWithRetry × 3 attempts × backoff adds up quickly).
  // If it doesn't complete in time, the channel is created lazily on
  // first send — bilateral communication still works, just with a
  // one-time delay on the first message.
  const PRE_REG_TIMEOUT_MS = 15_000;
  try {
    await Promise.race([
      getOrCreateChannel(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('pre-registration timed out')),
          PRE_REG_TIMEOUT_MS,
        ),
      ),
    ]);
    console.log('[Spellguard] Pre-registered with Verifier for discovery');
  } catch (error) {
    console.warn(
      `[Spellguard] Pre-registration failed (retrying in background): ${error}`,
    );
    retryPreRegistration();
  }

  return discovery;
}

/** The registration facts a delivery is verified against (#1244). */
export interface DeliveryTrust {
  /** The Verifier session key this agent pinned at attested registration. */
  sessionPublicKey: string;
  /** 'v1' when that registration advertised signed deliveries. */
  deliveryAuth: 'v1' | undefined;
}

/**
 * The current channel's delivery trust, establishing (attesting and
 * registering) the channel first if needed.
 */
export async function getDeliveryTrust(): Promise<DeliveryTrust> {
  const channel = (await getOrCreateChannel()) as ChannelImpl;
  return channel.getDeliveryTrust();
}

/**
 * Get current configuration.
 */
export function getConfig(): SpellguardConfig | null {
  return state().currentConfig;
}

/**
 * Invalidate the cached channel (forces re-registration on next use).
 */
export function invalidateChannel(): void {
  state().channelPromise = null;
  console.log(
    '[Spellguard] Channel invalidated, will re-register on next request',
  );
}

/**
 * Detect network-level failures that indicate the Verifier is unreachable
 * (as opposed to application-level errors like 401).
 */
function isVerifierUnreachable(error: unknown): boolean {
  // fetch() throws TypeError on network failures in most runtimes
  if (error instanceof TypeError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('timed out') ||
      msg.includes('aborted') ||
      msg.includes('socket hang up')
    );
  }
  return false;
}

/**
 * Renew a discovered management token this long before it expires, so a
 * registration never presents one that lapses in flight.
 */
const MANAGEMENT_TOKEN_RENEW_MARGIN_MS = 5 * 60_000;

/**
 * When a token discovery issued for `lifetimeSeconds` is due for renewal, or 0
 * when the lifetime is unknown. Measured from now on this clock, so a skewed
 * clock does not move it.
 */
function tokenRenewalTime(lifetimeSeconds: number): number {
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) return 0;
  const lifetimeMs = lifetimeSeconds * 1000;
  return (
    Date.now() +
    Math.max(lifetimeMs - MANAGEMENT_TOKEN_RENEW_MARGIN_MS, lifetimeMs / 2)
  );
}

/** True when this agent's discovered management token is due for renewal. */
function managementTokenDue(): boolean {
  const s = state();
  return (
    s.discoveryConfig !== null &&
    s.managementTokenRenewAt !== 0 &&
    Date.now() >= s.managementTokenRenewAt
  );
}

/** At most one pin-driven re-discovery per agent per minute (#1259). */
const PIN_REFRESH_INTERVAL_MS = 60_000;

/**
 * Claim this agent's pin refresh, if it has a discovery config and has not
 * refreshed within the interval. The claim is taken before re-discovery runs,
 * so the channel creation re-discovery triggers cannot recurse.
 */
function claimPinRefresh(): boolean {
  const s = state();
  if (!s.discoveryConfig) return false;
  const now = Date.now();
  if (now - s.lastPinRefreshAt < PIN_REFRESH_INTERVAL_MS) return false;
  s.lastPinRefreshAt = now;
  return true;
}

/**
 * Re-discover the Verifier from the management server.
 *
 * Called when the current Verifier becomes unreachable. Re-runs the full
 * discoverAndConfigure() flow which updates currentConfig, creates a
 * fresh channel, and registers with the newly-assigned Verifier.
 *
 * Uses a singleton promise PER-AGENT (scoped to the current attestation
 * state) so concurrent callers on the same agent coalesce into one
 * management request.
 */
export async function rediscover(): Promise<void> {
  const s = state();
  if (!s.discoveryConfig) {
    throw new Error(
      'No discovery config available — client was not initialized via discoverAndConfigure()',
    );
  }

  if (!s.rediscoveryPromise) {
    console.log('[Spellguard] Re-discovering Verifier from management...');
    const discoveryConfigSnapshot = s.discoveryConfig;
    s.rediscoveryPromise = discoverAndConfigure(discoveryConfigSnapshot)
      .then(() => undefined)
      .finally(() => {
        s.rediscoveryPromise = null;
      });
  }

  await s.rediscoveryPromise;
}

/**
 * Reset client state (for testing).
 *
 * Clears whichever state bucket is currently active: the ALS-scoped
 * state if called from inside runWithAttestationState, otherwise the
 * module-level rootState.
 */
export function reset(): void {
  const s = state();
  s.channelPromise = null;
  s.currentConfig = null;
  s.discoveryConfig = null;
  s.rediscoveryPromise = null;
  s.lastPinRefreshAt = 0;
  s.managementTokenRenewAt = 0;
}
