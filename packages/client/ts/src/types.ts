// SPDX-License-Identifier: Apache-2.0

import type { UnilateralSendResult } from '@spellguard/amp';
import type { AgentCard, DeliveryNonceStore } from '@spellguard/ctls';
import type { AttestationState } from './attestation';

/**
 * Platform identity providers the Verifier can attest an agent against.
 *
 * Mirrors management's `AttestationProvider`
 * (closed source) and the
 * `AttestationProviderSchema` Zod enum it is validated by, member for member.
 * Every entry has a registered server-side verifier in
 * `workers/services/identity-verifiers/`, so a member missing here is an agent
 * that cannot declare an identity the control plane already knows how to check.
 * Add to both sides together.
 */
export type AttestationProvider =
  | 'aws'
  | 'azure'
  | 'azure-maa'
  | 'clerk'
  | 'gcp'
  | 'salesforce'
  | 'spiffe'
  | 'verifier'
  | 'nitro-verifier'
  | 'aws-agentcore'
  | 'better-auth'
  | 'jwk'
  | 'oidc'
  | 'vestauth'
  | 'x509';

/**
 * Configuration for the Spellguard client.
 */
export interface SpellguardConfig {
  /** Unique identifier for this agent */
  agentId: string;
  /** URL of the Verifier server */
  verifierUrl: string;
  /** This agent's public URL (for Verifier callbacks) */
  selfUrl: string;
  /** SHA256 hash of this agent's code (for attestation) */
  codeHash: string;
  /**
   * Expected SHA384 hash of the Verifier Docker image (for bidirectional
   * attestation).
   *
   * OPTIONAL because the management server may not have recorded one yet. It
   * is then left undefined rather than filled with a placeholder, and channel
   * creation fails closed with `verifier_image_hash_unconfigured` — absent
   * attestation config must never read as "attestation passed".
   */
  expectedVerifierImageHash?: string;
  /**
   * The Verifier session key management attested (#1259), from discovery's
   * `verifierPublicKey`. When set, the Verifier's attestation document and its
   * registration response must both carry exactly this key; a mismatch
   * re-runs discovery once, then fails closed with `verifier_key_mismatch`.
   * Always set on the managed (discovery) path; optional for a directly
   * configured agent.
   */
  expectedVerifierPublicKey?: string;
  /** Agent secret for Verifier registration authentication (validated by management server) */
  agentSecret?: string;
  /** Ed25519 private key (hex) for signing evidence — from management server */
  signingPrivateKey?: string;
  /** Management token forwarded to Verifier during registration */
  managementToken?: string;
  /**
   * Management server base URL (WITHOUT the `/v1` suffix). Populated on the
   * managed/discovery path so the SDK can reach Management directly — e.g. the
   * Tier-3 self-reported usage emit (`POST /v1/agents/:id/usage`, §6.5). Absent
   * on direct-config agents that have no management endpoint (emit skips).
   */
  managementUrl?: string;
  /** Agent card for A2A discovery */
  agentCard: AgentCard;
  /**
   * Opt OUT of the fail-closed default for tool policy checks
   * (`checkToolPolicy`, and every `spellguardTool` / LangChain / OpenAI
   * wrapper built on it).
   *
   * Default (`undefined` / `false`) is fail CLOSED: when the check cannot
   * complete — Verifier unreachable, request timed out, request refused, no
   * channel established, or the client was never configured — the check
   * returns `{ effect: 'block' }` and the wrapped tool does not run.
   *
   * **Setting this to `true` means the tool call RUNS UNCHECKED whenever the
   * policy check cannot complete.** Every policy bound to that tool is
   * silently skipped for the duration of the outage; there is no other signal
   * to the caller. Availability is being bought with enforcement.
   *
   * It does NOT overrule the Verifier. A response carrying an explicit
   * `effect` is a decision, and is honoured either way — including the
   * Verifier's own `503 { effect: 'block' }` when it cannot load policy data.
   *
   * Consumers whose config the SDK never sees (`createSpellguard()` callers,
   * or processes that wrap tools without calling `configure()` at all) can set
   * `SPELLGUARD_TOOL_POLICY_FAIL_OPEN=true` instead. This field wins when both
   * are set.
   */
  failOpen?: boolean;
}

/**
 * Configuration for discovering a Verifier via the Management Server.
 *
 * Call `discoverAndConfigure()` with this instead of `configure()` when the
 * Verifier URL is not known ahead of time — the management server will assign one.
 */
export interface SpellguardDiscoveryConfig {
  /** Unique identifier for this agent */
  agentId: string;
  /** Agent secret for authentication (required for secret/dual auth mode) */
  agentSecret?: string;
  /** Management server base URL (e.g. "https://mgmt.example.com/v1") */
  managementUrl: string;
  /** This agent's public URL (for Verifier callbacks) */
  selfUrl: string;
  /** SHA256 hash of this agent's code (for attestation) */
  codeHash: string;
  /** Ed25519 private key (hex) for signing evidence — from management server */
  signingPrivateKey?: string;
  /** Preferred region for Verifier selection */
  region?: string;
  /** Required Verifier capabilities */
  capabilities?: string[];
  /** Agent card for A2A discovery */
  agentCard: AgentCard;
  /** Platform attestation providers for platform/dual auth mode */
  platformAttestation?: {
    providers: Array<{
      provider: AttestationProvider;
      getToken: () => Promise<string>;
    }>;
  };
  /**
   * Opt OUT of the fail-closed default for tool policy checks. Carried onto
   * the resolved `SpellguardConfig` — see `SpellguardConfig.failOpen` for what
   * enabling it costs.
   */
  failOpen?: boolean;
}

/**
 * Resolved agent information from A2A discovery.
 */
export interface ResolvedAgent {
  name: string;
  url: string;
  agentCard: AgentCard;
}

/**
 * Options for sending to an A2A-only agent via unilateral communication.
 */
export interface UnilateralSendOptions {
  /** A2A method to use (default: 'tasks/send') */
  method?: 'tasks/send' | 'tasks/get';
}

/**
 * Client-side secure channel to Verifier.
 * This is the client's view of a channel with methods for sending messages.
 */
export interface ClientChannel {
  /** Send a message to another agent through Verifier.
   *  `options.timeoutMs` overrides the default 120s send timeout — the peer
   *  fan-out passes a shorter, budget-derived value so a wedged send can't
   *  blow the turn past the proxy's /chat timeout. */
  send(
    recipient: string,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  /** Send a prompt with agent context through Verifier */
  sendWithAgentContext(options: {
    originalPrompt: string;
    targetAgents: ResolvedAgent[];
    model: unknown;
  }): Promise<unknown>;
  /** Send directly to AI model through Verifier (logged but no agent routing) */
  sendToModel(options: unknown): Promise<unknown>;
  /**
   * Send a message to an A2A-only agent through Verifier (unilateral attestation).
   * The Verifier will log commitments for both the outbound request and inbound response.
   * Attestation level is 'unilateral' since only the sender is Spellguard-attested.
   */
  sendToA2A(
    a2aAgentUrl: string,
    payload: unknown,
    options?: UnilateralSendOptions,
  ): Promise<UnilateralSendResult>;
  /** Close the channel */
  close(): void;
  /** Get the channel token for authenticated Verifier API calls */
  getChannelToken(): string;
}

// ═══════════════════════════════════════════════════════════════════
// Spellguard configuration types
// ═══════════════════════════════════════════════════════════════════

/**
 * Intent detection model — either a static model instance or a factory
 * that receives the env bindings and returns a model.
 */
export type IntentDetectionModelOrFactory<E> =
  | { model: unknown }
  | ((env: E) => unknown);

/**
 * Main LLM model/client — either a static instance or a factory
 * that receives the env bindings and returns the model.
 */
export type ModelOrFactory<E, M> = ((env: E) => M) | { model: M };

/**
 * Context passed to the `onMessage` handler.
 */
export interface MessageContext<M> {
  /** The incoming message payload from Verifier */
  message: unknown;
  /** The sender agent's ID */
  senderId: string;
  /** The initialized main model/client */
  model: M;
  /**
   * Hono request env (Cloudflare Workers Bindings, Node process env, etc.)
   * for the request that delivered this message. Typed as `unknown` because
   * @spellguard/client doesn't know the agent's env shape; cast to your
   * agent's env interface at the call site.
   */
  env: unknown;
}

/**
 * Managed mode: Verifier is discovered via the management server at runtime.
 */
export interface ManagedConfig {
  type: 'managed';
  /** Unique identifier for this agent */
  agentId: string;
  /** Agent secret for management server authentication (required for secret/dual auth mode) */
  agentSecret?: string;
  /**
   * Hex-encoded Ed25519 private key for signing Verifier-registration
   * evidence.  When omitted, the client falls back to deriving a key
   * from `codeHash` — that fallback only verifies on the Verifier
   * when no `agents.public_key` is recorded server-side, so any
   * managed-mode deployment that has registered a real public key
   * MUST supply this, otherwise registration fails with "Invalid
   * evidence signature".
   */
  signingPrivateKey?: string;
  /** Management server base URL (e.g. "https://mgmt.example.com/v1") */
  managementUrl: string;
  /** This agent's public URL (for Verifier callbacks) */
  selfUrl: string;
  /** SHA256 hash of this agent's code (for attestation) */
  codeHash: string;
  /** Platform attestation providers for platform/dual auth mode */
  platformAttestation?: {
    providers: Array<{
      provider: AttestationProvider;
      getToken: () => Promise<string>;
    }>;
  };
  /**
   * Opt OUT of the fail-closed default for tool policy checks. Carried onto
   * the resolved `SpellguardConfig` — see `SpellguardConfig.failOpen` for what
   * enabling it costs.
   *
   * This is the ONLY opt-out a Cloudflare Worker agent has:
   * `SPELLGUARD_TOOL_POLICY_FAIL_OPEN` is read off `process.env`, which
   * workerd does not populate from `vars` at the compatibility dates the
   * agents pin.
   */
  failOpen?: boolean;
}

/**
 * Direct mode: Verifier URL is known ahead of time (e.g. local dev).
 */
export interface DirectConfig {
  type: 'direct';
  /** Unique identifier for this agent */
  agentId: string;
  /** URL of the Verifier server */
  verifierUrl: string;
  /** This agent's public URL (for Verifier callbacks) */
  selfUrl: string;
  /** SHA256 hash of this agent's code (for attestation) */
  codeHash: string;
  /** Expected SHA384 hash of Verifier Docker image */
  expectedVerifierImageHash: string;
  /** Optional agent secret */
  agentSecret?: string;
  /**
   * Opt OUT of the fail-closed default for tool policy checks. Carried onto
   * the resolved `SpellguardConfig` — see `SpellguardConfig.failOpen` for what
   * enabling it costs.
   *
   * This is the ONLY opt-out a Cloudflare Worker agent has:
   * `SPELLGUARD_TOOL_POLICY_FAIL_OPEN` is read off `process.env`, which
   * workerd does not populate from `vars` at the compatibility dates the
   * agents pin.
   */
  failOpen?: boolean;
}

/**
 * Discriminated union for Spellguard configuration mode.
 */
export type SpellguardConfigMode = ManagedConfig | DirectConfig;

/**
 * Options for `createSpellguard()`.
 *
 * @typeParam E - The environment type (e.g. Cloudflare Workers Env bindings)
 * @typeParam M - The main LLM model/client type
 */
export interface SpellguardOptions<E extends object = object, M = unknown> {
  /** Agent card for A2A discovery — single source of truth */
  agentCard: AgentCard;
  /** Spellguard config: static object or env-resolver function */
  config: SpellguardConfigMode | ((env: E) => SpellguardConfigMode);
  /** Main LLM model/client — called once during lazy init, then available via getModel() and onMessage context */
  model?: ModelOrFactory<E, M>;
  /** Optional intent detection model: static value or env-resolver function */
  intentDetectionModel?: IntentDetectionModelOrFactory<E>;
  /** Handler for incoming bilateral messages from Verifier */
  onMessage: (ctx: MessageContext<M>) => Promise<unknown>;
  /**
   * Optional hook called once after Spellguard initialises (configure /
   * discoverAndConfigure complete).
   */
  onInitialized?: (env: E) => void | Promise<void>;
  /**
   * Signed deliveries (#1244). `/_spellguard/receive` verifies every delivery
   * against the key from this agent's attested registration, and refuses an
   * unsigned or invalid one when that registration advertised
   * `deliveryAuth: 'v1'` (report-only otherwise). Replays are caught by an
   * in-process nonce cache; a deployment that runs several receivers (Workers
   * isolates, replicas) passes a shared `nonceStore` to make that strict.
   */
  deliveryAuth?: {
    nonceStore?: DeliveryNonceStore;
  };
  /**
   * The attestation state (configuration, discovery, Verifier channel) this
   * instance runs in. Omitted, the instance owns a fresh one. Pass one when
   * the same agent also acts outside this instance's requests in the same
   * process, a scheduled job sending as it, say, and run that code in the same
   * state with `runWithAttestationState`. Both then share one Verifier
   * channel. The Verifier keeps one channel token per agent, so two states
   * for one agent each register and replace the other's token.
   */
  attestationState?: AttestationState;
}

/**
 * A file sent with an agent-to-agent message, as the `attachments` field of
 * the payload object passed to `channel.send`. The Verifier reads each one on
 * the recipient's inbound leg: a PDF's text layer is extracted, checked by the
 * recipient's inbound message policies, and recorded in the recipient's
 * session for the session policies. At most 4 per message and 1 MB decoded
 * each; one over a limit is recorded as unreadable, never extracted.
 */
export interface MessageAttachment {
  /** File name, shown as the document's label. */
  name: string;
  /** Media type; `application/pdf` is the one the Verifier reads today. */
  mediaType: string;
  /** The file, base64-encoded. */
  data: string;
}

/** A payload object that carries attachments. */
export interface WithAttachments {
  attachments?: MessageAttachment[];
}
