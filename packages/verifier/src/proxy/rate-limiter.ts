// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory token bucket rate limiter.
 *
 * Keyed by (agentId, policyId, direction). Uses a token bucket algorithm
 * where tokens refill at a steady rate of `count` per `window`.
 * The bucket capacity is `burst` (if set, must be >= count) or `count`.
 * Each message consumes 1 token. Expired buckets are cleaned up
 * after 2x their window of inactivity.
 */

export type WindowSize = '1m' | '5m' | '1h' | '1d';

export interface RateLimitKey {
  agentId: string;
  policyId: string;
  direction: 'inbound' | 'outbound';
}

export interface RateLimitConfig {
  count: number;
  window: WindowSize;
  burst?: number;
}

export interface CheckResult {
  allowed: boolean;
  retryAfter?: number; // seconds until 1 token available
}

const WINDOW_SECONDS: Record<WindowSize, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
  '1d': 86400,
};

interface Bucket {
  tokens: number;
  lastRefill: number; // ms timestamp
  windowMs: number;
  capacity: number;
  refillRate: number; // tokens per ms
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  private makeKey(key: RateLimitKey): string {
    return `${key.agentId}:${key.policyId}:${key.direction}`;
  }

  check(key: RateLimitKey, config: RateLimitConfig): CheckResult {
    const bucketKey = this.makeKey(key);
    const windowMs = WINDOW_SECONDS[config.window] * 1000;
    const capacity = config.burst ?? config.count;
    const refillRate = config.count / windowMs; // tokens per ms
    const now = Date.now();

    let bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      // First check: start with full capacity
      bucket = {
        tokens: capacity,
        lastRefill: now,
        windowMs,
        capacity,
        refillRate,
      };
      this.buckets.set(bucketKey, bucket);
    } else {
      // Refill tokens based on elapsed time
      const elapsed = now - bucket.lastRefill;
      if (elapsed > 0) {
        bucket.tokens = Math.min(
          capacity,
          bucket.tokens + elapsed * refillRate,
        );
        bucket.lastRefill = now;
        // Update config in case it changed
        bucket.capacity = capacity;
        bucket.refillRate = refillRate;
        bucket.windowMs = windowMs;
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Denied: calculate retryAfter (time until 1 token is available)
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = tokensNeeded / refillRate;
    const retryAfter = Math.ceil(retryAfterMs / 1000);

    return { allowed: false, retryAfter };
  }

  /**
   * Clean up expired buckets that have been unused for 2x their window.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > bucket.windowMs * 2) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Reset all rate limit buckets (for testing).
   */
  reset(): void {
    this.buckets.clear();
  }
}
