// SPDX-License-Identifier: Apache-2.0

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Upstream } from '../types';
import { VERSION } from '../version';
import { listAllTools } from './list-tools';

/**
 * A local stdio MCP server the guard starts and talks to. It gets the
 * environment the caller built (`buildChildEnv`), never the guard's own.
 */
export class LocalUpstream implements Upstream {
  private client: Client | null = null;
  private closing = false;
  onClose?: () => void;

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
    });
    const client = new Client({
      name: 'spellguard-mcp-guard',
      version: VERSION,
    });
    // The wrapped server exited (or closed its stdio) on its own: the guard
    // has nothing left to guard, so its owner should stop too.
    client.onclose = () => {
      if (!this.closing) this.onClose?.();
    };
    await client.connect(transport);
    this.client = client;
  }

  async toolsList(): Promise<Tool[]> {
    if (!this.client) throw new Error('Not connected');
    return listAllTools(this.client);
  }

  async toolsCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.client) throw new Error('Not connected');
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    this.closing = true;
    const client = this.client;
    this.client = null;
    // Closing the transport ends the child: stdin closed, then SIGTERM, then
    // SIGKILL (the SDK waits 2 s between steps).
    await client?.close();
  }
}
