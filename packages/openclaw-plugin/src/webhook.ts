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
 * Backoff schedule (ms before each attempt) for the managed-discovery retry.
 * `POST /v1/discover` can transiently time out (10s `AbortSignal`) through a
 * funnel/proxy during the post-reload churn, when the box is busy reconnecting
 * its agent-control + relay + Slack sockets after a credential merge. The
 * schedule spans that churn so a transient timeout self-heals. Exported-shape
 * delays are overridable in tests to avoid real waits.
 */
const DISCOVER_RETRY_DELAYS_MS = [0, 10_000, 20_000, 40_000, 60_000];

/**
 * Eagerly configure the Spellguard client so that tools (which run outside the
 * Hono middleware lifecycle) can use resolveAndCollectAgentResponses immediately,
 * AND so the before_dispatch hook has a management token for `/v1/mcp/evaluate`.
 * createSpellguard() uses lazy init; this ensures the config is available before
 * any tool execution.
 *
 * Managed bots MUST go through `discoverAndConfigure` — it is the only source of
 * the management-issued JWT (`managementToken`) that `hooks/evaluate.ts` sends as
 * the `Authorization` bearer. Without it, `/v1/mcp/evaluate` returns 401 and the
 * hook fail-closes (BLOCK) for the life of the process, so the bot silently drops
 * every inbound message even with the socket up. A single `/v1/discover` timeout
 * during the post-reload churn would do exactly that, so we RETRY with backoff
 * (`retryDelaysMs`) until it succeeds. A `configure(verifierUrl)` fallback would
 * NOT help — the verifierUrl already falls back to `config.verifierUrl` in
 * evaluate.ts; it is the TOKEN that only discovery provides.
 */
export async function eagerConfigure(
  config: SpellguardConfig,
  agentCard: AgentCard,
  retryDelaysMs: number[] = DISCOVER_RETRY_DELAYS_MS,
): Promise<void> {
  if (config.managementUrl && config.agentSecret) {
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
      if (retryDelaysMs[attempt] > 0) {
        await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
      }
      try {
        await discoverAndConfigure({
          agentId: config.agentId,
          agentSecret: config.agentSecret,
          managementUrl: config.managementUrl,
          selfUrl: config.selfUrl,
          codeHash: config.codeHash,
          agentCard,
        });
        return;
      } catch (err) {
        console.warn(
          JSON.stringify({
            service: 'openclaw-spellguard-plugin',
            event: 'discover_and_configure_retry',
            agentId: config.agentId,
            attempt: attempt + 1,
            of: retryDelaysMs.length,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
    // Exhausted retries — loud marker. A subsequent gateway/webhook restart
    // re-runs this; before_dispatch stays fail-closed until then (correct — the
    // management token cannot be minted locally).
    console.error(
      JSON.stringify({
        service: 'openclaw-spellguard-plugin',
        event: 'eager_configure_exhausted',
        agentId: config.agentId,
        attempts: retryDelaysMs.length,
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }
  if (config.verifierUrl) {
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
