// SPDX-License-Identifier: Apache-2.0

import type { AuthClient } from '../auth/client';
import type { TrafficEntry } from '../types';

export class TrafficReporter {
  private batch: TrafficEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private authClient: AuthClient,
    private managementUrl: string,
    private options: {
      flushIntervalMs: number; // Default: 5000
      maxBatchSize: number; // Default: 50
      heartbeatIntervalMs: number; // Default: 60000
    } = { flushIntervalMs: 5000, maxBatchSize: 50, heartbeatIntervalMs: 60000 },
  ) {}

  /**
   * Start the reporter — begins flush timer and heartbeat.
   */
  start(): void {
    this.scheduleFlush();
    this.scheduleHeartbeat();
  }

  /**
   * Add a traffic entry to the batch. Flushes if batch is full.
   */
  report(entry: TrafficEntry): void {
    this.batch.push(entry);
    if (this.batch.length >= this.options.maxBatchSize) {
      this.flush().catch(() => {}); // fire-and-forget
    }
  }

  /**
   * Flush the current batch to the management server.
   * Fire-and-forget: errors are logged but don't affect proxy operation.
   */
  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const entries = this.batch;
    this.batch = [];

    try {
      const connectionId = this.authClient.getConnectionId();
      const token = this.authClient.getToken();

      await fetch(`${this.managementUrl}/connections/${connectionId}/traffic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ batch: entries }),
      });
    } catch (err) {
      console.error('[mcp-guard] Traffic report failed (non-fatal):', err);
      // Don't re-queue entries — accept data loss rather than growing memory
    }
  }

  /**
   * Close the reporter — flush remaining entries and clear timers.
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.options.flushIntervalMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  private scheduleHeartbeat(): void {
    // Send heartbeat to keep connection active (prevents staleness marking)
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, this.options.heartbeatIntervalMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private async sendHeartbeat(): Promise<void> {
    // POST empty batch to update last_active_at
    try {
      const connectionId = this.authClient.getConnectionId();
      const token = this.authClient.getToken();

      await fetch(`${this.managementUrl}/connections/${connectionId}/traffic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ batch: [] }),
      });
    } catch {
      // Non-fatal
    }
  }
}
