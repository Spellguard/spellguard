// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-sync client — fires a single POST /v1/agents/:id/plugin-sync
 * to the management worker on plugin startup. Graceful-degrade on any
 * failure (logs ERROR, does not throw, never retried per REQ-FI-006).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagementClient } from '@spellguard/agent-control';

const FRAMEWORK = 'openclaw';
const TIMEOUT_MS = 5_000;

function readPluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, '..', 'package.json'), 'utf8'),
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
  const api = createManagementClient({
    baseUrl: options.managementUrl,
    agentId: options.agentId,
    agentSecret: options.agentSecret,
    auth: 'bearer',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { error, response } = await api.POST('/agents/{id}/plugin-sync', {
      params: { path: { id: options.agentId } },
      body: {
        framework: FRAMEWORK,
        pluginVersion: readPluginVersion(),
      },
      signal: controller.signal,
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
