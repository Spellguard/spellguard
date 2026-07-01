// SPDX-License-Identifier: Apache-2.0

/**
 * Profile abstractions — swap transport, discovery, and identity at deploy
 * time without touching application code or policy semantics.
 *
 * `original` profile: HTTP/JSON-RPC transport + A2A discovery + CTLS channel
 * tokens. The Spellguard stack as it has historically shipped.
 *
 * `agntcy` profile: the full AGNTCY stack — SLIM data plane (transport) +
 * AGNTCY Directory / `dir` (discovery) + AGNTCY Identity Verifiable
 * Credentials. Same application surface; different layers underneath. (This
 * profile was formerly named `slim`; it is the whole AGNTCY integration, not
 * just the SLIM transport, hence the rename.)
 *
 * A `ProfileBundle` is a triple of (transport, directory, identity) that the
 * Verifier and client SDKs resolve once at startup. Everything downstream
 * calls through the three interfaces; nothing else branches on profile.
 */

import type { SecureMessage } from '../types/index';

// ═══════════════════════════════════════════════════════════════════
// Profile identity
// ═══════════════════════════════════════════════════════════════════

/**
 * Top-level profile name. Selects a coherent bundle of transport, directory,
 * and identity implementations. `agntcy` selects the full AGNTCY stack.
 */
export type ProfileName = 'original' | 'agntcy';

/**
 * Per-layer profile names. Set individually via env vars to mix and match
 * (e.g. `SPELLGUARD_TRANSPORT=slim SPELLGUARD_DIRECTORY=original` for
 * testing). When unset, each layer inherits from `SPELLGUARD_PROFILE`.
 *
 * Note: the layer names below are the real AGNTCY component names — `slim`
 * is the AGNTCY SLIM transport, `dir` is the AGNTCY Directory, and
 * `agntcy-vc` is AGNTCY Identity. These stay as-is; only the top-level
 * profile name changed from `slim` to `agntcy`.
 */
export type TransportName = 'http' | 'slim';
export type DirectoryName = 'a2a-wellknown' | 'dir';
export type IdentityName = 'ctls' | 'agntcy-vc';

// ═══════════════════════════════════════════════════════════════════
// Addressing
// ═══════════════════════════════════════════════════════════════════

/**
 * A profile-agnostic agent address. Transport implementations interpret the
 * shape they need (`url` for HTTP, `slimName` for SLIM, `did` for DID
 * resolution), and ignore the rest.
 *
 * The Directory implementation populates this when resolving an agent.
 */
export interface AgentAddress {
  /** Logical agent identifier (e.g. "agent-a"). Always present. */
  agentId: string;
  /** HTTPS URL of the agent. Populated by A2A and original profile. */
  url?: string;
  /** SLIM hierarchical name (e.g. "org/agent-a"). Populated by `dir`. */
  slimName?: string;
  /** Decentralized identifier (W3C DID). Populated by `agntcy-vc` when present. */
  did?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Transport
// ═══════════════════════════════════════════════════════════════════

/**
 * Outbound message transport. Sends a SecureMessage to a recipient address
 * and returns the response synchronously (request/response semantics).
 *
 * Implementations:
 * - `HttpTransport` (original profile): POST to `${verifier}/messages/send`.
 * - `SlimTransport` (slim profile): SRPC call over SLIM data plane, framed
 *   so a SLIM intermediary node (the Verifier) sees the message.
 *
 * The Verifier-in-path policy enforcement is preserved by routing transport
 * naming through a known intermediary in both modes.
 */
export interface SpellguardTransport {
  /** Backend name for logging / metrics (e.g. "http", "slim-sidecar"). */
  readonly name: string;

  /**
   * Send a message to an agent. Recipient addressing is profile-specific;
   * the address object carries whatever the transport needs.
   */
  send(to: AgentAddress, msg: SecureMessage): Promise<SecureMessage>;

  /**
   * Send a message to an A2A-only external agent (unilateral). Always falls
   * back to HTTP regardless of profile — external agents speak HTTP/A2A.
   * This is how the Verifier bridges between a SLIM mesh and the wider A2A
   * ecosystem (see Phase 3 design notes).
   */
  sendUnilateral(
    a2aAgentUrl: string,
    msg: SecureMessage,
    method?: 'tasks/send' | 'tasks/get',
  ): Promise<SecureMessage>;

  /** Lazy / lightweight initialization. Called once before first send. */
  init?(): Promise<void>;

  /** Release any held resources (sockets, sidecar connections). */
  close?(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════
// Directory
// ═══════════════════════════════════════════════════════════════════

/**
 * Agent discovery. Maps logical agent names to addresses transports can use.
 *
 * Implementations:
 * - `A2ADirectory` (original profile): fetches `/.well-known/agent.json`
 *   from the agent, falls back to the Verifier's `/agents/resolve/{name}`
 *   for Management-server-backed resolution.
 * - `DirDirectory` (slim profile): queries the AGNTCY `dir` distributed
 *   registry over DHT, falls back to A2A `/.well-known` for external agents
 *   not in the SLIM mesh.
 */
export interface SpellguardDirectory {
  /** Backend name for logging (e.g. "a2a-wellknown", "agntcy-dir"). */
  readonly name: string;

  /**
   * Resolve an agent name (or URL) to a profile-appropriate address.
   * Returns `null` when the agent cannot be found in this directory.
   */
  resolve(agentNameOrUrl: string): Promise<AgentAddress | null>;

  /**
   * Publish this agent's record so other agents in the mesh can find it.
   * Called at startup. No-op for `a2a-wellknown` (publication is implicit
   * via the agent's own HTTP endpoint).
   */
  publish?(card: PublishableRecord): Promise<void>;
}

/**
 * The subset of an agent's identity that the Directory needs to publish.
 * Both A2A AgentCard and AGNTCY OASF records can be projected into this shape.
 */
export interface PublishableRecord {
  agentId: string;
  /** Endpoint the transport will use (URL for HTTP, name for SLIM). */
  endpoint: string;
  /** Free-form skills/capabilities list, profile-agnostic. */
  skills?: string[];
  /** Owner organization for multi-tenant deployments. */
  org?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Identity
// ═══════════════════════════════════════════════════════════════════

/**
 * Agent identity issuance + verification. Both profiles bind a credential
 * to an attested agent; the wire format differs.
 *
 * Implementations:
 * - `CtlsIdentity` (original profile): issues Spellguard channel tokens after
 *   CTLS attestation; tokens are opaque bearer strings stored in the Verifier
 *   registry.
 * - `AgntcyIdentity` (slim profile): issues Verifiable Credentials (Agent
 *   Badges) per AGNTCY identity spec, published at `/.well-known/vcs.json`.
 *   CTLS code-attestation evidence is preserved as a claim inside the VC
 *   (OASF Module extension).
 */
export interface SpellguardIdentity {
  /** Backend name (e.g. "ctls", "agntcy-vc"). */
  readonly name: string;

  /**
   * Issue a credential to an agent that has passed attestation. The opaque
   * `attestationEvidence` is whatever the CTLS attestation flow produced —
   * the identity layer doesn't interpret it beyond embedding it as a claim
   * (for `agntcy-vc`) or storing it alongside the token (for `ctls`).
   */
  issueCredential(input: IssueCredentialInput): Promise<IssuedCredential>;

  /**
   * Verify a credential presented in an inbound request. Returns the agent
   * identity and claims when valid; null when the credential is invalid,
   * expired, or revoked.
   */
  verifyCredential(credential: string): Promise<VerifiedClaims | null>;
}

export interface IssueCredentialInput {
  agentId: string;
  /** Opaque CTLS attestation evidence (signed Evidence document, base64). */
  attestationEvidence: string;
  /** Optional TTL hint; implementations may clamp or ignore. */
  ttlSeconds?: number;
}

export interface IssuedCredential {
  /** The credential string carried on subsequent requests (token, VC JWT, …). */
  credential: string;
  /** Wall-clock expiration timestamp (ms since epoch). */
  expiresAt: number;
}

export interface VerifiedClaims {
  agentId: string;
  /** Whether the credential carries a code-attestation claim. */
  codeAttested: boolean;
  /** Optional claim bag — issuer, scope, etc. Shape is profile-specific. */
  claims?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════
// Bundle
// ═══════════════════════════════════════════════════════════════════

/**
 * The three layers wired together. Resolved once at startup via
 * `loadProfile(env)`; passed through to anything that needs to send messages,
 * resolve agents, or issue/verify credentials.
 */
export interface ProfileBundle {
  /** The composite profile name (for diagnostics + audit metadata). */
  readonly profile: ProfileName;
  readonly transport: SpellguardTransport;
  readonly directory: SpellguardDirectory;
  readonly identity: SpellguardIdentity;
}

/**
 * Environment shape consulted by `loadProfile()`. A subset of the agent's
 * Worker/process env; we extract only the profile-related keys.
 */
export interface ProfileEnv {
  SPELLGUARD_PROFILE?: string;
  SPELLGUARD_TRANSPORT?: string;
  SPELLGUARD_DIRECTORY?: string;
  SPELLGUARD_IDENTITY?: string;
  /** Sidecar WebSocket URL for the slim transport (e.g. "ws://localhost:46358"). */
  SPELLGUARD_SLIM_GATEWAY_URL?: string;
  /** AGNTCY `dir` node URL for Directory-based discovery. */
  SPELLGUARD_DIR_URL?: string;
  /** AGNTCY identity issuer URL for VC issuance. */
  SPELLGUARD_IDENTITY_ISSUER_URL?: string;
}
