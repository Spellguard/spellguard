// SPDX-License-Identifier: Apache-2.0

import type { ProxyConnectResponse } from '../types';
import { VERSION } from '../version';

interface ConnectArgs {
  platform: string;
  upstreamType: string;
  upstreamUrl?: string;
  workspace?: string;
}

/** Refresh at 50 minutes, 5/6 of the token's one-hour life. */
const REFRESH_AFTER_MS = 50 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;

export class AuthClient {
  private token: string | null = null;
  private connectionId: string | null = null;
  private verifierUrl: string | null = null;
  private canonicalAgentId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnect: ConnectArgs | null = null;
  private reconnecting: Promise<void> | null = null;
  private tokenIssuedAt = 0;

  constructor(
    private managementUrl: string,
    private agentId: string,
    private agentSecret: string,
  ) {}

  /**
   * Authenticate with the agent secret, register the platform connection, and
   * collect the management token the Verifier checks.
   */
  async connect(
    platform: string,
    upstreamType: string,
    upstreamUrl?: string,
    workspace?: string,
  ): Promise<ProxyConnectResponse> {
    const args = { platform, upstreamType, upstreamUrl, workspace };
    let res: Response;
    try {
      res = await fetch(
        `${this.managementUrl}/proxy/${encodeURIComponent(this.agentId)}/proxy-connect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Spellguard-Agent-Secret': this.agentSecret,
            'X-Spellguard-Proxy-Version': VERSION,
          },
          body: JSON.stringify(args),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach Spellguard at ${this.managementUrl} (${message}). Check SPELLGUARD_BASE_URL.`,
      );
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const hint =
        res.status === 401
          ? ' Check SPELLGUARD_AGENT_ID and SPELLGUARD_AGENT_SECRET.'
          : res.status === 404 || res.status === 405
            ? ' Check SPELLGUARD_BASE_URL: it should be your Spellguard console address.'
            : '';
      throw new Error(
        `Spellguard refused the connection (${res.status}: ${body?.error?.message || res.statusText}).${hint}`,
      );
    }

    const data = (await res.json()) as ProxyConnectResponse;
    if (
      typeof data?.managementToken !== 'string' ||
      typeof data.verifierUrl !== 'string' ||
      typeof data.connectionId !== 'string'
    ) {
      throw new Error('Spellguard answered proxy-connect without a token');
    }
    this.token = data.managementToken;
    this.tokenIssuedAt = Date.now();
    this.connectionId = data.connectionId;
    this.verifierUrl = data.verifierUrl.replace(/\/+$/, '');
    // The token names the agent's canonical ID; the Verifier compares every
    // request's agentId with it. The configured value may be the UUID.
    this.canonicalAgentId =
      typeof data.agentId === 'string' && data.agentId
        ? data.agentId
        : this.agentId;
    this.lastConnect = args;
    this.scheduleRefresh(REFRESH_AFTER_MS);
    return data;
  }

  /**
   * Connect again with the agent secret, after a token expired or a refresh
   * failed. Concurrent callers share one attempt.
   */
  async reconnect(): Promise<void> {
    if (!this.lastConnect)
      throw new Error('Not connected — call connect() first');
    if (!this.reconnecting) {
      const args = this.lastConnect;
      this.reconnecting = this.connect(
        args.platform,
        args.upstreamType,
        args.upstreamUrl,
        args.workspace,
      )
        .then(() => {
          console.error('[mcp-guard] Reconnected to Spellguard');
        })
        .finally(() => {
          this.reconnecting = null;
        });
    }
    return this.reconnecting;
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

  /** How long ago the current token was issued, in milliseconds. */
  tokenAgeMs(): number {
    return this.tokenIssuedAt ? Date.now() - this.tokenIssuedAt : 0;
  }

  /** The agent ID to send the Verifier: the one the token names. */
  getAgentId(): string {
    return this.canonicalAgentId ?? this.agentId;
  }

  async close(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.token = null;
    this.connectionId = null;
    this.verifierUrl = null;
    this.lastConnect = null;
  }

  private scheduleRefresh(ms: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch(() => {});
    }, ms);
    // Never keep the process alive just to refresh.
    this.refreshTimer.unref?.();
  }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch(
        `${this.managementUrl}/proxy/${encodeURIComponent(this.agentId)}/proxy-connect/refresh`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'X-Spellguard-Proxy-Version': VERSION,
          },
        },
      );
      if (!res.ok) throw new Error(`refresh answered ${res.status}`);
      const data = (await res.json()) as { managementToken?: unknown };
      if (typeof data.managementToken !== 'string') {
        throw new Error('refresh answered without a token');
      }
      this.token = data.managementToken;
      this.tokenIssuedAt = Date.now();
      this.scheduleRefresh(REFRESH_AFTER_MS);
    } catch (err) {
      // An expired token can't be refreshed (the machine slept, say), so
      // connect again with the secret instead of retrying the refresh forever.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[mcp-guard] Token refresh failed (${message}); reconnecting`,
      );
      try {
        await this.reconnect();
      } catch (reconnectErr) {
        const detail =
          reconnectErr instanceof Error
            ? reconnectErr.message
            : String(reconnectErr);
        console.error(
          `[mcp-guard] Reconnect failed (${detail}); retrying in 60s`,
        );
        if (this.lastConnect) this.scheduleRefresh(RETRY_AFTER_MS);
      }
    }
  }
}
