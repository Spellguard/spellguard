// SPDX-License-Identifier: Apache-2.0

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Upstream } from '../types';

export class LocalUpstream implements Upstream {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private command: string) {}

  async connect(): Promise<void> {
    // Parse command string into command + args
    const parts = this.command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    this.transport = new StdioClientTransport({
      command: cmd,
      args,
      env: { ...process.env } as Record<string, string>,
    });

    this.client = new Client({
      name: 'spellguard-mcp-guard',
      version: '0.1.0',
    });
    await this.client.connect(this.transport);
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
    this.transport = null;
  }
}
