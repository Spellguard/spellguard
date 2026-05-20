// SPDX-License-Identifier: Apache-2.0

import { serve } from '@hono/node-server';
import {
  configure,
  createSpellguard,
  discoverAndConfigure,
} from '@spellguard/client';
import type { AgentCard } from '@spellguard/client';
import { Hono } from 'hono';

import type { SpellguardConfig } from './config';

/**
 * Eagerly configure the Spellguard client so that tools (which run outside the
 * Hono middleware lifecycle) can use resolveAndCollectAgentResponses immediately.
 * createSpellguard() uses lazy init; this ensures the config is available before
 * any tool execution.
 */
async function eagerConfigure(
  config: SpellguardConfig,
  agentCard: AgentCard,
): Promise<void> {
  if (config.managementUrl && config.agentSecret) {
    await discoverAndConfigure({
      agentId: config.agentId,
      agentSecret: config.agentSecret,
      managementUrl: config.managementUrl,
      selfUrl: config.selfUrl,
      codeHash: config.codeHash,
      agentCard,
    });
  } else if (config.verifierUrl) {
    configure({
      agentId: config.agentId,
      verifierUrl: config.verifierUrl,
      selfUrl: config.selfUrl,
      codeHash: config.codeHash,
      expectedVerifierImageHash: config.expectedVerifierImageHash,
      agentSecret: config.agentSecret,
      agentCard,
    });
  }
}

export function startWebhookServer(
  config: SpellguardConfig,
  agentCard: AgentCard,
) {
  // Eagerly set the client config for tool readiness
  eagerConfigure(config, agentCard).catch((err) => {
    console.error(
      JSON.stringify({
        service: 'openclaw-spellguard-plugin',
        event: 'eager_configure_failed',
        agentId: config.agentId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  const app = new Hono();

  const spellguard = createSpellguard({
    agentCard,
    config: config.managementUrl
      ? {
          type: 'managed' as const,
          agentId: config.agentId,
          agentSecret: config.agentSecret || '',
          managementUrl: config.managementUrl,
          selfUrl: config.selfUrl,
          codeHash: config.codeHash,
        }
      : {
          type: 'direct' as const,
          agentId: config.agentId,
          verifierUrl: config.verifierUrl || '',
          selfUrl: config.selfUrl,
          codeHash: config.codeHash,
          expectedVerifierImageHash: config.expectedVerifierImageHash,
          agentSecret: config.agentSecret,
        },
    onMessage: async ({ message, senderId }) => {
      console.log(
        JSON.stringify({
          service: 'openclaw-spellguard-plugin',
          event: 'inbound_message',
          senderId,
          timestamp: new Date().toISOString(),
        }),
      );

      return { response: 'Message received.' };
    },
  });

  app.route('/', spellguard.middleware());

  const port = new URL(config.selfUrl).port;

  const server = serve({
    fetch: app.fetch,
    port: Number(port),
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        JSON.stringify({
          service: 'openclaw-spellguard-plugin',
          event: 'startup_failed',
          agentId: config.agentId,
          error: `Port ${port} is already in use`,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      console.error(
        JSON.stringify({
          service: 'openclaw-spellguard-plugin',
          event: 'server_error',
          agentId: config.agentId,
          error: err.message,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  });

  console.log(
    JSON.stringify({
      service: 'openclaw-spellguard-plugin',
      event: 'startup',
      agentId: config.agentId,
      webhookUrl: config.selfUrl,
      timestamp: new Date().toISOString(),
    }),
  );

  return {
    close() {
      server.close();
      console.log(
        JSON.stringify({
          service: 'openclaw-spellguard-plugin',
          event: 'shutdown',
          agentId: config.agentId,
          timestamp: new Date().toISOString(),
        }),
      );
    },
  };
}
