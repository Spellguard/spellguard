// SPDX-License-Identifier: Apache-2.0

import type { ProxyConnectResponse } from '../types';

export class AuthClient {
  private token: string | null = null;
  private tokenExpiresAt: string | null = null;
  private connectionId: string | null = null;
  private verifierUrl: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private managementUrl: string,
    private agentId: string,
    private agentSecret: string,
  ) {}

  /**
   * Connect to the management server, authenticate, and get a management token.
   * Also registers the platform connection.
   */
  async connect(
    platform: string,
    upstreamType: string,
    upstreamUrl?: string,
    workspace?: string,
  ): Promise<ProxyConnectResponse> {
    const res = await fetch(
      `${this.managementUrl}/proxy/${this.agentId}/proxy-connect`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Agent-Secret': this.agentSecret,
          'X-Spellguard-Proxy-Version': '0.1.0', // TODO: read from package.json
        },
        body: JSON.stringify({
          platform,
          upstreamType,
          upstreamUrl,
          workspace,
        }),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Proxy-connect failed (${res.status}): ${(body as any)?.error?.message || res.statusText}`,
      );
    }

    const data = (await res.json()) as ProxyConnectResponse;
    this.token = data.managementToken;
    this.tokenExpiresAt = data.tokenExpiresAt;
    this.connectionId = data.connectionId;
    this.verifierUrl = data.verifierUrl;

    // Set refresh timer at 50 minutes (5/6 of 1hr TTL)
    this.scheduleRefresh();

    return data;
  }

  getToken(): string {
    if (!this.token) throw new Error('Not connected — call connect() first');
    return this.token;
  }

  getVerifierUrl(): string {
    if (!this.verifierUrl)
      throw new Error('Not connected — call connect() first');
    return this.verifierUrl;
  }

  getConnectionId(): string {
    if (!this.connectionId)
      throw new Error('Not connected — call connect() first');
    return this.connectionId;
  }

  async close(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.token = null;
    this.connectionId = null;
    this.verifierUrl = null;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // Refresh at 50 minutes (5/6 of TTL)
    const refreshMs = 50 * 60 * 1000;
    this.refreshTimer = setTimeout(() => this.refresh(), refreshMs);
    // Prevent timer from keeping the process alive
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch(
        `${this.managementUrl}/proxy/${this.agentId}/proxy-connect/refresh`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'X-Spellguard-Proxy-Version': '0.1.0',
          },
        },
      );

      if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);

      const data = (await res.json()) as {
        managementToken: string;
        tokenExpiresAt: string;
      };
      this.token = data.managementToken;
      this.tokenExpiresAt = data.tokenExpiresAt;
      this.scheduleRefresh();
    } catch (err) {
      // Retry after 60 seconds
      console.error('[mcp-guard] Token refresh failed, retrying in 60s:', err);
      this.refreshTimer = setTimeout(() => this.retryAuth(), 60 * 1000);
      if (this.refreshTimer.unref) this.refreshTimer.unref();
    }
  }

  /**
   * Fallback re-auth when refresh fails. Attempts another refresh since we
   * don't retain the original platform info needed to re-call proxy-connect.
   *
   * Known limitation: if the token has fully expired, this will also fail.
   * A full reconnect requires the caller to invoke connect() again with the
   * original platform arguments.
   */
  private async retryAuth(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      console.error('[mcp-guard] Re-auth failed. Token may be expired.');
    }
  }
}
