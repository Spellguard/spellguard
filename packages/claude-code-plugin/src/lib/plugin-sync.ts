// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-sync client — fires a single POST /v1/agents/:id/plugin-sync
 * to the Spellguard backend on plugin startup. Graceful-degrade on any
 * failure (logs ERROR, does not throw, never retried).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagementClient } from '@spellguard/agent-control';

/**
 * Canonical framework slug for the WIRE/DB (`agents.framework`) — distinct from
 * the on-disk path slug in `framework-slug.ts` (`claude-code`, hyphen). Shared
 * by both the startup plugin-sync AND the bootstrap_request frame so the value
 * the server records at creation matches what plugin-sync reconciles to.
 */
export const FRAMEWORK = 'claude_code';
const TIMEOUT_MS = 5_000;

function readPluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8'),
    );
    return pkg.version as string;
  } catch {
    return 'unknown';
  }
}

export async function syncFrameworkIdentity(options: {
  agentId: string;
  managementUrl: string;
  agentSecret: string;
}): Promise<void> {
  const base = options.managementUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const api = createManagementClient({
      baseUrl: base,
      agentId: options.agentId,
      agentSecret: options.agentSecret,
      // The plugin-sync route is authed with Authorization: Bearer
      // (requireAgentBearer), not the X-Spellguard-Agent-* headers.
      auth: 'bearer',
      fetchImpl: (input, init) =>
        fetch(input, { ...init, signal: controller.signal }),
    });
    const { error, response } = await api.POST('/agents/{id}/plugin-sync', {
      params: { path: { id: options.agentId } },
      body: {
        framework: FRAMEWORK,
        pluginVersion: readPluginVersion(),
      },
    });

    if (error) {
      console.error(
        JSON.stringify({
          event: 'plugin_sync.failed',
          status: response.status,
          agentId: options.agentId,
        }),
      );
      return;
    }

    console.log(
      JSON.stringify({
        event: 'plugin_sync.ok',
        agentId: options.agentId,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'plugin_sync.failed',
        error: (err as Error).message,
        agentId: options.agentId,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}
