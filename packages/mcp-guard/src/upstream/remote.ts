// SPDX-License-Identifier: Apache-2.0

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Upstream } from '../types';

export class RemoteUpstream implements Upstream {
  private client: Client | null = null;

  constructor(
    private url: string,
    private token?: string,
  ) {}

  async connect(): Promise<void> {
    this.client = new Client({
      name: 'spellguard-mcp-guard',
      version: '0.1.0',
    });

    const authOpts = this.token
      ? { requestInit: { headers: { Authorization: `Bearer ${this.token}` } } }
      : undefined;

    // Try StreamableHTTP first (newer protocol), fall back to SSE
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(this.url),
        authOpts,
      );
      await this.client.connect(transport);
    } catch {
      // Create a fresh Client for fallback — the previous connect() may have
      // left internal state inconsistent.
      this.client = new Client({
        name: 'spellguard-mcp-guard',
        version: '0.1.0',
      });
      const transport = new SSEClientTransport(new URL(this.url), authOpts);
      await this.client.connect(transport);
    }
  }

  async toolsList(): Promise<unknown> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.listTools();
    return result.tools;
  }

  async toolsCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
