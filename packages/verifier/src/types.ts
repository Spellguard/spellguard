// SPDX-License-Identifier: Apache-2.0

// Verifier Self-Attestation (for bidirectional verification)
export interface VerifierAttestationDocument {
  imageHash: string; // SHA384 of Docker image (reproducible build)
  hardwareSignature: string; // Signed by Verifier hardware (Phala/Intel TDX quote)
  publicKey: string; // Verifier's ephemeral public key for this session
  timestamp: number;
  nonce: string; // Prevents replay attacks
  supportedAlgorithms?: string[]; // Supported encryption algorithms
  eventLog?: string; // TDX event log from dstack (production only)
  composeHash?: string; // Docker compose hash for CVM verification (production only)
}

// Ephemeral Session Keys (forward secrecy)
export interface SessionKeys {
  publicKey: string; // Ed25519 public key for signing verification
  privateKey: string; // Ed25519 private key, RAM-only, never persisted
  x25519PublicKey: string; // X25519 public key for ECDH key agreement
  x25519PrivateKey: string; // X25519 private key, RAM-only, never persisted
  createdAt: number;
  // Note: These keys exist ONLY in Verifier RAM
}

// RFC 9334 RATS types
export interface Evidence {
  agentId: string;
  claims: {
    codeHash: string;
    endpoint: string; // Client's callback URL (for Verifier to call)
    agentCardUrl: string; // A2A discovery URL
    capabilities: string[];
    preferredAlgorithm?: string; // Optional encryption algorithm preference
  };
  signature: string;
}

export interface AttestationResult {
  agentId: string;
  verified: boolean;
  channelToken: string;
  sessionPublicKey: string; // Verifier's Ed25519 ephemeral public key for signing
  sessionX25519PublicKey?: string; // Verifier's X25519 ephemeral public key for ECDH encryption
  expiresAt: number;
  rotationPolicy?: {
    maxAge: number; // milliseconds before token should be rotated
    refreshEndpoint: string; // endpoint to call for token refresh
  };
}

// A2A Agent Card (simplified)
export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  authentication?: {
    schemes: string[];
  };
}

// Message types (encrypted with session keys)
export interface SecureMessage {
  id: string;
  sender: string;
  recipient: string;
  encryptedPayload: string; // Encrypted with session key
  timestamp: number;
}

// Re-export AuditCommitment from @spellguard/amp
export type { AuditCommitment } from '@spellguard/amp';

// Registered agent in the registry
export interface RegisteredAgent {
  agentId: string;
  endpoint: string;
  agentCardUrl: string;
  codeHash: string;
  channelToken: string;
  registeredAt: number;
  expiresAt: number;
}

// Channel between two agents
export interface Channel {
  id: string;
  participants: [string, string];
  createdAt: number;
  lastActivity: number;
}
