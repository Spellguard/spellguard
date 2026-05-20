// SPDX-License-Identifier: Apache-2.0

// Import from @spellguard/ctls
import { AsyncLocalStorage } from 'node:async_hooks';
import { fetchAndVerifyVerifier } from '@spellguard/ctls/client';
import { sign } from '@spellguard/ctls/crypto';
import type { AttestationResult, Evidence } from '@spellguard/ctls/types';

// Import from @spellguard/amp
import {
  type UnilateralSendResult,
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
// demo-fleet worker multiplexes 20 agents behind /agents/:agentId/*).
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
}

const attestationContext = new AsyncLocalStorage<AttestationState>();

const rootState: AttestationState = {
  channelPromise: null,
  currentConfig: null,
  discoveryConfig: null,
  rediscoveryPromise: null,
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
}

/**
 * Get or create a channel to the Verifier.
 * Handles implicit channel establishment via attestation.
 */
export async function getOrCreateChannel(): Promise<ClientChannel> {
  const s = state();
  if (!s.currentConfig) {
    throw new Error('Spellguard not configured. Call configure() first.');
  }

  if (!s.channelPromise) {
    const config = s.currentConfig;
    s.channelPromise = createChannel(config).catch((err) => {
      // Clear cached promise so the next call retries instead of
      // returning the same rejected promise forever.
      s.channelPromise = null;
      throw err;
    });
  }

  return s.channelPromise;
}

/**
 * Create a new channel to the Verifier with bidirectional attestation.
 */
async function createChannel(config: SpellguardConfig): Promise<ChannelImpl> {
  console.log(`[Spellguard] Creating channel for ${config.agentId}...`);

  // Step 1: Verify Verifier before sending any secrets
  const isMockMode =
    config.expectedVerifierImageHash === 'sha384:dev-placeholder' ||
    config.expectedVerifierImageHash.startsWith('sha384:dev');

  const verifierVerification = await fetchAndVerifyVerifier(
    config.verifierUrl,
    config.expectedVerifierImageHash,
    { mockMode: isMockMode },
  );

  if (!verifierVerification.verified) {
    throw new Error(
      `Verifier attestation failed: ${verifierVerification.error}\nThis could indicate a compromised or fake Verifier. Connection refused.`,
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
    body: JSON.stringify({ evidence }),
    signal: AbortSignal.timeout(10_000),
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

  console.log(
    `[Spellguard] Channel established. Token expires: ${new Date(attestation.expiresAt).toISOString()}`,
  );

  return new ChannelImpl(
    config,
    attestation.channelToken,
    attestation.sessionPublicKey,
    attestation.sessionX25519PublicKey,
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
  private closed = false;
  private isRetry = false;

  constructor(
    config: SpellguardConfig,
    channelToken: string,
    sessionPublicKey: string,
    sessionX25519PublicKey?: string,
  ) {
    this.config = config;
    this.channelToken = channelToken;
    this.sessionPublicKey = sessionPublicKey;
    this.sessionX25519PublicKey = sessionX25519PublicKey;
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
  async send(recipient: string, payload: unknown): Promise<unknown> {
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
      });
    } catch (fetchError) {
      // Network error — Verifier may be down. Re-discover if possible.
      if (!this.isRetry && state().discoveryConfig) {
        return this.retryAfterRediscovery((ch) => ch.send(recipient, payload));
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
              return await newChannel.send(recipient, payload);
            } finally {
              newChannel.isRetry = false;
            }
          } catch (reregErr) {
            // Re-registration failed — Verifier may have moved. Try re-discovery.
            if (state().discoveryConfig && isVerifierUnreachable(reregErr)) {
              return this.retryAfterRediscovery((ch) =>
                ch.send(recipient, payload),
              );
            }
            throw reregErr;
          }
        }
      }

      throw new Error(`Failed to send message: ${response.status} ${error}`);
    }

    const result = (await response.json()) as { response: unknown };
    return result.response;
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
}

/**
 * Check tool call content against policies via the Verifier's /v1/tools/check endpoint.
 * Fails open on network/server errors (returns { effect: 'allow' }).
 */
export async function checkToolPolicy(
  phase: 'input' | 'output',
  toolName: string,
  params?: unknown,
  result?: unknown,
): Promise<ToolCheckResult> {
  try {
    const channel = (await getOrCreateChannel()) as ChannelImpl;
    const response = await fetch(`${channel.getVerifierUrl()}/v1/tools/check`, {
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
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(
        `[Spellguard] Tool policy check failed (${response.status}), failing open`,
      );
      return { effect: 'allow' };
    }

    return (await response.json()) as ToolCheckResult;
  } catch (error) {
    console.warn(
      `[Spellguard] Tool policy check error, failing open: ${error}`,
    );
    return { effect: 'allow' };
  }
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

  const response = await fetch(`${config.managementUrl}/discover`, {
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

  // Configure the client with the resolved Verifier URL.
  // Use the real Verifier image hash from discovery when available so agents
  // perform genuine attestation verification on staging/production.
  // Fall back to 'sha384:dev-placeholder' only when the management
  // server hasn't recorded the Verifier's image hash yet (local dev).
  configure({
    agentId: config.agentId,
    verifierUrl: discovery.verifierUrl,
    selfUrl: config.selfUrl,
    codeHash: config.codeHash,
    expectedVerifierImageHash:
      discovery.verifierImageHash || 'sha384:dev-placeholder',
    agentSecret: config.agentSecret,
    signingPrivateKey: config.signingPrivateKey,
    managementToken: discovery.managementToken,
    agentCard: config.agentCard,
  });

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
}
