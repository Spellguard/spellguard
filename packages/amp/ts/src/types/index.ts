// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/amp - Type definitions
 *
 * Core types for the Auditable Messaging Protocol.
 */

// ═══════════════════════════════════════════════════════════════════
// Shared Policy Primitives
// ═══════════════════════════════════════════════════════════════════

/**
 * Obligations that can be attached to policy bindings.
 * Shared across Verifier, management, and dashboard packages.
 */
export type Obligation =
  | 'log_access'
  | 'log_for_review'
  | 'require_human_approval'
  | 'audit_trail'
  | 'notify_owner'
  | 'rate_limit_check';

export const OBLIGATION_VALUES = [
  'log_access',
  'log_for_review',
  'require_human_approval',
  'audit_trail',
  'notify_owner',
  'rate_limit_check',
] as const;

// ═══════════════════════════════════════════════════════════════════
// Message Types
// ═══════════════════════════════════════════════════════════════════

/**
 * A secure message encrypted with session keys.
 */
export interface SecureMessage {
  /** Unique message identifier */
  id: string;
  /** Sender agent ID */
  sender: string;
  /** Recipient agent ID */
  recipient: string;
  /** Encrypted payload (base64-encoded) */
  encryptedPayload: string;
  /** Timestamp when the message was created */
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════
// Commitment Types
// ═══════════════════════════════════════════════════════════════════

/**
 * Attestation level for communication between agents.
 * - bilateral: Both agents are attested via Spellguard
 * - unilateral: Only one agent (sender) is attested; recipient is A2A-only
 * - none: No attestation (not used in normal Spellguard operation)
 */
export type AttestationLevel = 'bilateral' | 'unilateral' | 'none';

/**
 * Unified audit commitment for all agent-to-agent communication.
 * Contains NO plaintext - only cryptographic proof of message existence.
 *
 * All communications are logged with an attestation level:
 * - Bilateral: Both agents are Spellguard-attested
 * - Unilateral: Only sender is attested, recipient is A2A-only
 */
export interface AuditCommitment {
  /** Message ID this commitment refers to */
  messageId: string;
  /** Sender agent ID */
  sender: string;
  /** Recipient agent ID */
  recipient: string;
  /** SHA256 hash proving message existence */
  hash: string;
  /** Timestamp of commitment generation */
  timestamp: number;
  /** Attestation level for this communication */
  attestationLevel: AttestationLevel;

  // === Unilateral-specific fields (present only for A2A-only recipients) ===

  /** Direction of unilateral interaction (outbound = to A2A agent, inbound = from A2A agent) */
  direction?: 'outbound' | 'inbound';
  /** URL of the A2A-only agent (for unilateral communication) */
  a2aAgentUrl?: string;
  /** Whether the A2A agent was reachable (for unilateral communication) */
  reachable?: boolean;
  /** HTTP status code if a response was received (for unilateral communication) */
  httpStatus?: number;
  /** Correlation ID linking outbound request to inbound response (for unilateral communication) */
  correlationId?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Channel Types
// ═══════════════════════════════════════════════════════════════════

/**
 * A communication channel between two agents.
 */
export interface Channel {
  /** Unique channel identifier */
  id: string;
  /** The two agents participating in this channel */
  participants: [string, string];
  /** When the channel was created */
  createdAt: number;
  /** Last activity timestamp */
  lastActivity: number;
}

// ═══════════════════════════════════════════════════════════════════
// Logging Backend Types
// ═══════════════════════════════════════════════════════════════════

/**
 * Backend for logging message commitments to a tamper-evident audit trail.
 *
 * Implementations:
 * - memory: In-memory for testing
 * - rekor: Sigstore transparency log (free, public)
 */
export interface CommitmentBackend {
  /** Backend name for identification */
  readonly name: string;

  /** Initialize the backend */
  init(): Promise<void>;

  /**
   * Log a commitment to the audit trail.
   * @returns Entry ID/transaction hash, or null on failure
   */
  logCommitment(commitment: AuditCommitment): Promise<string | null>;

  /**
   * Verify a commitment exists in the audit trail.
   */
  verifyCommitment(commitmentHash: string): Promise<boolean>;

  /** Check if the backend is connected and ready */
  isConnected(): boolean;
}

/**
 * Options for archiving a message, including optional encrypted envelope
 * for management-decryptable content.
 */
export interface ArchiveOptions {
  /** Base64-encoded envelope encrypted with the Management Server's public key.
   *  Contains sender, recipient, message content, and metadata.
   *  If present, stored alongside (or instead of) the raw SecureMessage. */
  encryptedEnvelope?: string;
}

/**
 * Payload stored in the archive backend when an encrypted envelope is provided.
 */
export interface ArchivePayload {
  /** Message ID for cross-referencing with audit logs */
  messageId: string;
  /** Base64-encoded management-encrypted envelope */
  encryptedEnvelope: string;
  /** Commitment metadata (hashes only, no PII) */
  commitment: Pick<AuditCommitment, 'hash' | 'attestationLevel'>;
  /** ISO timestamp of archival */
  archivedAt: string;
}

/**
 * Backend for archiving encrypted messages.
 *
 * Implementations:
 * - memory: In-memory for testing
 * - s3: AWS S3 (supports S3-compatible services like MinIO)
 */
export interface ArchiveBackend {
  /** Backend name for identification */
  readonly name: string;

  /** Initialize the backend */
  init(): Promise<void>;

  /**
   * Archive an encrypted message.
   * @returns Archive ID, or null on failure
   */
  archive(
    message: SecureMessage,
    commitment: AuditCommitment,
    options?: ArchiveOptions,
  ): Promise<string | null>;

  /**
   * Retrieve an archived payload (raw JSON from storage).
   */
  retrieve(archiveId: string): Promise<ArchivePayload | SecureMessage | null>;

  /** Check if the backend is connected and ready */
  isConnected(): boolean;
}

/**
 * Result of logging and archiving operations.
 */
export interface LoggingResult {
  /** Commitment entry ID (from Rekor, etc.) */
  commitmentId?: string;
  /** Archive ID (from S3, etc.) */
  archiveId?: string;
  /** Warnings about partial failures */
  warnings: string[];
}

/**
 * Backend configuration.
 */
export interface BackendConfig {
  /** Commitment backend type */
  commitmentBackend: string;
  /** Archive backend type */
  archiveBackend: string;
}

// ═══════════════════════════════════════════════════════════════════
// A2A Protocol Types
// ═══════════════════════════════════════════════════════════════════

/**
 * A2A JSON-RPC request format.
 * Used for communicating with A2A-compatible agents.
 */
export interface A2ARequest {
  jsonrpc: '2.0';
  id: string;
  method: 'tasks/send' | 'tasks/get';
  params: {
    id: string;
    message: {
      role: 'user';
      parts: Array<{ type: 'text'; text: string }>;
    };
  };
}

/**
 * A2A JSON-RPC response format.
 */
export interface A2AResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    id: string;
    status: { state: 'completed' | 'pending' | 'failed' };
    artifacts?: Array<{ parts: Array<{ type: 'text'; text: string }> }>;
  };
  error?: { code: number; message: string };
}

/**
 * Request to send a message via unilateral communication (to an A2A-only agent).
 */
export interface UnilateralSendRequest {
  /** Sender agent ID (must be Spellguard-attested) */
  sender: string;
  /** URL of the A2A-only agent */
  a2aAgentUrl: string;
  /** Payload to send */
  payload: unknown;
  /** A2A method to use */
  method?: 'tasks/send' | 'tasks/get';
}

/**
 * Result of sending a message via unilateral communication.
 */
export interface UnilateralSendResult {
  /** Whether the send was successful */
  success: boolean;
  /** Correlation ID linking request and response */
  correlationId: string;
  /** Response from the A2A agent (if successful) */
  response?: A2AResponse;
  /** Error message (if unsuccessful) */
  error?: string;
  /** Commitment IDs for audit trail */
  commitments: {
    outbound: { commitmentId?: string; archiveId?: string };
    inbound?: { commitmentId?: string; archiveId?: string };
  };
  /** Warnings about partial failures */
  warnings?: string[];
}
