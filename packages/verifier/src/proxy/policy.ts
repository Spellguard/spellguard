// SPDX-License-Identifier: Apache-2.0

/**
 * Policy enforcement for external agent interactions.
 *
 * Provides outbound and inbound policy checks for:
 * - URL allowlisting
 * - PII detection
 * - Prompt injection detection
 */

import type { A2AResponse } from '@spellguard/amp';

/**
 * Result of a policy check.
 */
export interface PolicyResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Reason for denial (if not allowed) */
  reason?: string;
  /** List of detections (PII patterns, injection attempts, etc.) */
  detections?: string[];
}

/**
 * Policy for outbound requests to external agents.
 */
export interface OutboundPolicy {
  /** Allowed agent URL patterns (empty = allow all) */
  allowedAgents?: string[];
  /** Patterns to block in outbound payloads */
  blockedPatterns?: RegExp[];
}

/**
 * Policy for inbound responses from external agents.
 */
export interface InboundPolicy {
  /** Patterns to detect PII in responses */
  piiPatterns?: RegExp[];
  /** Whether to detect prompt injection attempts */
  detectInjection?: boolean;
}

/**
 * Default PII patterns to detect in responses.
 */
export const DEFAULT_PII_PATTERNS: RegExp[] = [
  // US Social Security Number (SSN)
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Email address
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  // US Phone number (various formats)
  /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  // Credit card number (basic pattern)
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,
];

/**
 * Default prompt injection patterns to detect.
 */
export const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /disregard\s+(?:all\s+)?prior/i,
  /forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?instructions?/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you\s+are/i,
  /\[\[system\]\]/i,
  /\{\{system\}\}/i,
];

/**
 * Enforce outbound policy on a request to an external agent.
 *
 * @param url - The external agent URL
 * @param payload - The payload being sent
 * @param policy - The outbound policy to enforce
 * @returns PolicyResult indicating whether the request is allowed
 */
export function enforceOutboundPolicy(
  url: string,
  payload: unknown,
  policy: OutboundPolicy,
): PolicyResult {
  // Check URL allowlist
  if (policy.allowedAgents && policy.allowedAgents.length > 0) {
    const isAllowed = policy.allowedAgents.some((pattern) => {
      // Support glob-like patterns with * wildcard
      const regex = new RegExp(
        `^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
      );
      return regex.test(url);
    });

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `External agent URL not in allowlist: ${url}`,
      };
    }
  }

  // Check blocked patterns in payload
  if (policy.blockedPatterns && policy.blockedPatterns.length > 0) {
    const payloadStr =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    const detections: string[] = [];

    for (const pattern of policy.blockedPatterns) {
      if (pattern.test(payloadStr)) {
        detections.push(`Blocked pattern detected: ${pattern.source}`);
      }
    }

    if (detections.length > 0) {
      return {
        allowed: false,
        reason: 'Outbound payload contains blocked content',
        detections,
      };
    }
  }

  return { allowed: true };
}

/**
 * Enforce inbound policy on a response from an external agent.
 *
 * @param response - The A2A response from the external agent
 * @param policy - The inbound policy to enforce
 * @returns PolicyResult indicating whether the response is safe
 */
export function enforceInboundPolicy(
  response: A2AResponse,
  policy: InboundPolicy,
): PolicyResult {
  // Extract text content from response
  const textContent = extractTextFromResponse(response);
  const detections: string[] = [];

  // Check for PII
  const piiPatterns = policy.piiPatterns || DEFAULT_PII_PATTERNS;
  for (const pattern of piiPatterns) {
    if (pattern.test(textContent)) {
      detections.push(`PII pattern detected: ${pattern.source}`);
    }
  }

  // Check for prompt injection
  if (policy.detectInjection !== false) {
    for (const pattern of DEFAULT_INJECTION_PATTERNS) {
      if (pattern.test(textContent)) {
        detections.push(`Potential injection detected: ${pattern.source}`);
      }
    }
  }

  // Return result with detections (but allow by default - just warn)
  // The caller can decide whether to block based on detections
  return {
    allowed: true,
    detections: detections.length > 0 ? detections : undefined,
  };
}

/**
 * Extract all text content from an A2A response.
 */
function extractTextFromResponse(response: A2AResponse): string {
  const parts: string[] = [];

  if (response.result?.artifacts) {
    for (const artifact of response.result.artifacts) {
      for (const part of artifact.parts) {
        if (part.type === 'text' && part.text) {
          parts.push(part.text);
        }
      }
    }
  }

  if (response.error?.message) {
    parts.push(response.error.message);
  }

  return parts.join('\n');
}

/**
 * Create a default outbound policy.
 */
export function createDefaultOutboundPolicy(): OutboundPolicy {
  return {
    allowedAgents: [], // Empty = allow all
    blockedPatterns: [],
  };
}

/**
 * Create a default inbound policy.
 */
export function createDefaultInboundPolicy(): InboundPolicy {
  return {
    piiPatterns: DEFAULT_PII_PATTERNS,
    detectInjection: true,
  };
}
