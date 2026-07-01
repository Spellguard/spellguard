// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - Type definitions
 *
 * Core types for confidential TLS attestation and channel establishment.
 */

// ═══════════════════════════════════════════════════════════════════
// Verifier Attestation Types
// ═══════════════════════════════════════════════════════════════════

/**
 * Verifier self-attestation document for bidirectional verification.
 * Clients verify this before sending any secrets to the Verifier.
 */
export interface VerifierAttestationDocument {
  /** SHA384 hash of the Verifier Docker image (reproducible build) */
  imageHash: string;
  /** Signature from Verifier hardware (TDX quote or Nitro COSE_Sign1 document) */
  hardwareSignature: string;
  /** Verifier's ephemeral public key for this session */
  publicKey: string;
  /** Timestamp of attestation generation */
  timestamp: number;
  /** Nonce to prevent replay attacks */
  nonce: string;
  /** Verifier attestation type: 'nitro' (AWS Nitro Enclave), 'phala' (Intel TDX via Phala), 'internal' (platform-attested, intra-org only), or 'mock' (development) */
  attestationType?: 'nitro' | 'phala' | 'internal' | 'mock';
  /** Supported encryption algorithms */
  supportedAlgorithms?: string[];
  /** TDX event log from dstack (production only) */
  eventLog?: string;
  /** Docker compose hash for CVM verification (production only) */
  composeHash?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Session Types
// ═══════════════════════════════════════════════════════════════════

/**
 * Ephemeral session keys for forward secrecy.
 * These exist ONLY in Verifier RAM and are destroyed on shutdown.
 */
export interface SessionKeys {
  /** Ed25519 public key shared with clients for signing verification */
  publicKey: string;
  /** Ed25519 private key - RAM-only, never persisted */
  privateKey: string;
  /** X25519 public key for ECDH key agreement (encryption) */
  x25519PublicKey: string;
  /** X25519 private key - RAM-only, never persisted */
  x25519PrivateKey: string;
  /** When the keys were created */
  createdAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// RFC 9334 RATS Evidence Types
// ═══════════════════════════════════════════════════════════════════

/**
 * Evidence submitted by an agent for attestation (RFC 9334 RATS pattern).
 */
export interface Evidence {
  /** Unique identifier for the agent */
  agentId: string;
  /** Claims about the agent */
  claims: {
    /** Hash of the agent's code */
    codeHash: string;
    /** Agent's callback endpoint URL */
    endpoint: string;
    /** URL to the agent's A2A Agent Card */
    agentCardUrl: string;
    /** Capabilities the agent supports */
    capabilities: string[];
    /** Preferred encryption algorithm */
    preferredAlgorithm?: string;
  };
  /** Signature over the claims */
  signature: string;
}

/**
 * Result of evidence verification.
 */
export interface AttestationResult {
  /** Agent ID from the evidence */
  agentId: string;
  /** Whether the evidence was verified successfully */
  verified: boolean;
  /** Channel token for authenticated communication */
  channelToken: string;
  /** Verifier's Ed25519 session public key for signing verification */
  sessionPublicKey: string;
  /** Verifier's X25519 session public key for ECDH encryption */
  sessionX25519PublicKey?: string;
  /** When the attestation expires */
  expiresAt: number;
  /** Token rotation policy */
  rotationPolicy?: {
    /** Maximum age before rotation (milliseconds) */
    maxAge: number;
    /** Endpoint to call for token refresh */
    refreshEndpoint: string;
  };
  /** Verifier's own attestation type — lets agents know the trust level */
  verifierAttestationType?: 'nitro' | 'phala' | 'internal' | 'mock';
  /** Error message if verification failed */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Agent Registry Types
// ═══════════════════════════════════════════════════════════════════

/**
 * A registered agent in the Verifier registry.
 */
export interface RegisteredAgent {
  /** Unique identifier for the agent */
  agentId: string;
  /** Agent's callback endpoint URL */
  endpoint: string;
  /** URL to the agent's A2A Agent Card */
  agentCardUrl: string;
  /** Hash of the agent's code */
  codeHash: string;
  /** Channel token for authenticated communication */
  channelToken: string;
  /** When the agent was registered */
  registeredAt: number;
  /** When the registration expires */
  expiresAt: number;
  /**
   * AGNTCY SLIM hierarchical name (e.g. `org/agent-a`). Populated only when
   * the agent was discovered through the slim profile (DirDirectory). When
   * present, the router forwards via SlimTransport instead of HTTP fetch.
   */
  slimName?: string;
  /**
   * The agent client's X25519 public key (hex). Registered so the Verifier can
   * encrypt delivered payloads + responses TO this agent (gateway-opaque,
   * app-layer end-to-end to the agent). Absent ⇒ legacy mode: the Verifier
   * forwards app-layer plaintext to/from this agent (transport-encrypted only).
   */
  clientPublicKey?: string;
}

// ═══════════════════════════════════════════════════════════════════
// A2A Agent Card Types
// ═══════════════════════════════════════════════════════════════════

/**
 * A2A Protocol Agent Card for discovery.
 */
export interface AgentCard {
  /** Human-readable name */
  name: string;
  /** Description of the agent */
  description?: string;
  /** Base URL of the agent */
  url: string;
  /** Agent version */
  version?: string;
  /** Optional capabilities */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  /** Skills/abilities the agent provides */
  skills: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  /** Authentication schemes supported */
  authentication?: {
    schemes: string[];
  };
}
