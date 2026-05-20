// SPDX-License-Identifier: Apache-2.0

import type { UnilateralSendResult } from '@spellguard/amp';
import type { AgentCard } from '@spellguard/ctls';

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
  /** Expected SHA384 hash of Verifier Docker image (for bidirectional attestation) */
  expectedVerifierImageHash: string;
  /** Agent secret for Verifier registration authentication (validated by management server) */
  agentSecret?: string;
  /** Ed25519 private key (hex) for signing evidence — from management server */
  signingPrivateKey?: string;
  /** Management token forwarded to Verifier during registration */
  managementToken?: string;
  /** Agent card for A2A discovery */
  agentCard: AgentCard;
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
      provider:
        | 'aws'
        | 'azure'
        | 'azure-maa'
        | 'better-auth'
        | 'gcp'
        | 'jwk'
        | 'nitro-verifier'
        | 'oidc'
        | 'salesforce'
        | 'spiffe'
        | 'verifier'
        | 'aws-agentcore'
        | 'vestauth'
        | 'x509';
      getToken: () => Promise<string>;
    }>;
  };
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
  /** Send a message to another agent through Verifier */
  send(recipient: string, payload: unknown): Promise<unknown>;
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
      provider:
        | 'aws'
        | 'azure'
        | 'azure-maa'
        | 'better-auth'
        | 'gcp'
        | 'jwk'
        | 'nitro-verifier'
        | 'oidc'
        | 'salesforce'
        | 'spiffe'
        | 'verifier'
        | 'aws-agentcore'
        | 'vestauth'
        | 'x509';
      getToken: () => Promise<string>;
    }>;
  };
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
}
