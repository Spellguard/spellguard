// SPDX-License-Identifier: Apache-2.0

import { type VerifierKey, isVerifierKey } from '../evaluate/verdict-signature';
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
/**
 * Ask for the Verifier keys on demand at most this often. A Verifier rotates
 * its session key once a day and Spellguard attests the new one within
 * seconds, so a verdict signed by an unknown key is worth one fresh look, not
 * one per call.
 */
export const KEY_REFRESH_MIN_MS = 10 * 1000;

/** What to check after proxy-connect refused with this status. */
function refusalHint(status: number): string {
  if (status === 401) {
    return ' Check SPELLGUARD_AGENT_ID and SPELLGUARD_AGENT_SECRET.';
  }
  if (status === 404 || status === 405) {
    return ' Check SPELLGUARD_BASE_URL: it should be your Spellguard console address.';
  }
  return '';
}

/** The well-formed entries of a `verifierKeys` answer, or null if absent. */
function readVerifierKeys(value: unknown): VerifierKey[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isVerifierKey).map((key) => ({
    verifierId: key.verifierId,
    publicKey: key.publicKey.toLowerCase(),
  }));
}

export class AuthClient {
  private token: string | null = null;
  private connectionId: string | null = null;
  private verifierUrl: string | null = null;
  private canonicalAgentId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnect: ConnectArgs | null = null;
  private reconnecting: Promise<void> | null = null;
  private tokenIssuedAt = 0;
  private verifierKeys: VerifierKey[] = [];
  private lastKeyRefreshAt = 0;
  private refreshingKeys: Promise<void> | null = null;

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
      throw new Error(
        `Spellguard refused the connection (${res.status}: ${body?.error?.message || res.statusText}).${refusalHint(res.status)}`,
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
    const keys = readVerifierKeys(data.verifierKeys);
    if (!keys) {
      // Without keys every verdict would fail its check and block, so say
      // why once instead.
      throw new Error(
        `Spellguard at ${this.managementUrl} sent no Verifier keys, so the guard can't check that the Verifier's answers are genuine. Update Spellguard.`,
      );
    }
    this.setVerifierKeys(keys);
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

  /** The keys a Verifier answer may be signed with. */
  getVerifierKeys(): readonly VerifierKey[] {
    return this.verifierKeys;
  }

  /**
   * Ask Spellguard for the current Verifier keys, after an answer failed its
   * signature check (the Verifier may have rotated its key). Concurrent
   * callers share one request, and no other is made for KEY_REFRESH_MIN_MS
   * after it, whether it worked or not. Never throws: the caller checks again
   * with whatever keys the guard then holds.
   */
  async refreshVerifierKeys(): Promise<void> {
    if (this.refreshingKeys) return this.refreshingKeys;
    if (Date.now() - this.lastKeyRefreshAt < KEY_REFRESH_MIN_MS) return;
    this.lastKeyRefreshAt = Date.now();
    this.refreshingKeys = this.refreshToken()
      .catch(() => this.reconnect())
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[mcp-guard] Could not fetch the current Verifier keys (${message})`,
        );
      })
      .finally(() => {
        this.refreshingKeys = null;
      });
    return this.refreshingKeys;
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
    this.verifierKeys = [];
  }

  private setVerifierKeys(keys: VerifierKey[]): void {
    this.verifierKeys = keys;
    if (keys.length === 0) {
      console.error(
        '[mcp-guard] Spellguard named no attested Verifier right now; checks block until it does.',
      );
    }
  }

  private scheduleRefresh(ms: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch(() => {});
    }, ms);
    // Never keep the process alive just to refresh.
    this.refreshTimer.unref?.();
  }

  /** Swap the token for a fresh one, and take the current Verifier keys. */
  private async refreshToken(): Promise<void> {
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
    const data = (await res.json()) as {
      managementToken?: unknown;
      verifierKeys?: unknown;
    };
    if (typeof data.managementToken !== 'string') {
      throw new Error('refresh answered without a token');
    }
    this.token = data.managementToken;
    this.tokenIssuedAt = Date.now();
    const keys = readVerifierKeys(data.verifierKeys);
    if (keys) this.setVerifierKeys(keys);
    this.scheduleRefresh(REFRESH_AFTER_MS);
  }

  private async refresh(): Promise<void> {
    try {
      await this.refreshToken();
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
