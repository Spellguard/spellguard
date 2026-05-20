// SPDX-License-Identifier: Apache-2.0

/**
 * Types for Spellguard external policy servers.
 */

/**
 * A detection result from a policy check.
 */
export interface Detection {
  /** Detection type/label (e.g., 'pii-email', 'injection-attempt') */
  type: string;
  /** Confidence score from 0 to 1 */
  confidence: number;
  /** Optional human-readable message */
  message?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Request payload sent by Spellguard Verifier to external policy servers.
 */
export interface PolicyRequest {
  /** The content to evaluate */
  content: string;
  /** Policy ID (UUID) */
  policyId: string;
  /** Policy slug (human-readable identifier) */
  policySlug: string;
  /** User-defined configuration for this policy */
  config?: Record<string, unknown>;
}

/**
 * Response expected by Spellguard Verifier.
 * Just an array of detections.
 */
export type PolicyResponse = Detection[];

/**
 * Policy engine interface for implementing custom policies.
 */
export interface PolicyEngine {
  /** Unique name for this engine */
  readonly name: string;

  /**
   * Evaluate content against this policy.
   *
   * @param request - The policy request from Spellguard
   * @returns Array of detections (empty if content passes)
   */
  evaluate(request: PolicyRequest): Detection[] | Promise<Detection[]>;
}

/**
 * Configuration for the policy server.
 */
export interface ServerConfig {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Base path for routes (default: /) */
  basePath?: string;
  /** Enable request logging (default: true) */
  logging?: boolean;
  /** Health check path (default: /health) */
  healthPath?: string;
}
