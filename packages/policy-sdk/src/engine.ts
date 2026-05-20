// SPDX-License-Identifier: Apache-2.0

/**
 * Base class for building policy engines with helper utilities.
 */

import type { Detection, PolicyEngine, PolicyRequest } from './types';

/**
 * Abstract base class for policy engines with common utilities.
 */
export abstract class BasePolicyEngine implements PolicyEngine {
  abstract readonly name: string;

  /**
   * Evaluate content against this policy.
   * Override this in your subclass.
   */
  abstract evaluate(request: PolicyRequest): Detection[] | Promise<Detection[]>;

  /**
   * Create a detection result.
   */
  protected detection(
    type: string,
    confidence: number,
    message?: string,
    metadata?: Record<string, unknown>,
  ): Detection {
    return {
      type,
      confidence: Math.max(0, Math.min(1, confidence)),
      message,
      metadata,
    };
  }

  /**
   * Get a config value with a default.
   */
  protected getConfig<T>(
    request: PolicyRequest,
    key: string,
    defaultValue: T,
  ): T {
    if (!request.config) return defaultValue;
    const value = request.config[key];
    return value !== undefined ? (value as T) : defaultValue;
  }

  /**
   * Check if content contains any of the given strings (case-insensitive).
   * Returns the matched string or null.
   */
  protected containsAny(content: string, values: string[]): string | null {
    const lower = content.toLowerCase();
    for (const value of values) {
      if (lower.includes(value.toLowerCase())) {
        return value;
      }
    }
    return null;
  }

  /**
   * Check if content matches any of the given regex patterns.
   * Returns the first match or null.
   */
  protected matchesAny(
    content: string,
    patterns: RegExp[],
  ): RegExpMatchArray | null {
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) return match;
    }
    return null;
  }

  /**
   * Count occurrences of a pattern in content.
   */
  protected countMatches(content: string, pattern: RegExp): number {
    const matches = content.match(new RegExp(pattern.source, 'gi'));
    return matches ? matches.length : 0;
  }
}
