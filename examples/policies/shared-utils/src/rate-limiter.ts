// SPDX-License-Identifier: Apache-2.0

/**
 * Simple rate limiter using token bucket algorithm
 * Helps respect API rate limits and quotas
 */

export interface RateLimiterConfig {
  maxTokens: number; // Maximum tokens in the bucket
  refillRate: number; // Tokens added per refill interval
  refillIntervalMs: number; // Interval in milliseconds
}

export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.tokens = config.maxTokens;
    this.lastRefillTime = Date.now();
  }

  /**
   * Try to consume a token
   * @returns true if token was available and consumed, false otherwise
   */
  tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Wait until a token is available, then consume it
   * @param maxWaitMs Maximum time to wait in milliseconds (default: 5000)
   * @returns Promise that resolves when token is consumed
   * @throws Error if max wait time exceeded
   */
  async consume(maxWaitMs = 5000): Promise<void> {
    const startTime = Date.now();

    while (!this.tryConsume()) {
      const elapsed = Date.now() - startTime;
      if (elapsed > maxWaitMs) {
        throw new Error('Rate limit: max wait time exceeded');
      }

      // Wait for next refill opportunity
      const waitTime = Math.min(100, this.config.refillIntervalMs / 10);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefillTime;
    const intervalsElapsed = Math.floor(
      timePassed / this.config.refillIntervalMs,
    );

    if (intervalsElapsed > 0) {
      const tokensToAdd = intervalsElapsed * this.config.refillRate;
      this.tokens = Math.min(this.config.maxTokens, this.tokens + tokensToAdd);
      this.lastRefillTime = now;
    }
  }

  /**
   * Get current number of available tokens
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Reset the rate limiter to full capacity
   */
  reset(): void {
    this.tokens = this.config.maxTokens;
    this.lastRefillTime = Date.now();
  }
}

/**
 * Create a rate limiter with common API limits
 */
export function createAPIRateLimiter(requestsPerMinute: number): RateLimiter {
  return new RateLimiter({
    maxTokens: requestsPerMinute,
    refillRate: requestsPerMinute,
    refillIntervalMs: 60000, // 1 minute
  });
}
