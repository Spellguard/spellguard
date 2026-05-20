// SPDX-License-Identifier: Apache-2.0

import { reset } from '@spellguard/client';
import type {
  OpenClawPluginApi,
  SlackAccountConfig,
} from 'openclaw/plugin-sdk';
import { createAgentTool } from './adapter';
import { buildAgentCard, loadConfig } from './config';
import { discordAdapter } from './hooks/adapters/discord';
import { registerAdapter } from './hooks/adapters/dispatcher';
import { msteamsAdapter } from './hooks/adapters/msteams';
import { slackAdapter } from './hooks/adapters/slack';
import {
  createBeforeDispatchGuard,
  createMessageIdObserver,
} from './hooks/inbound-observer';
import { discordNormalizer } from './hooks/normalizers/discord';
import { msteamsNormalizer } from './hooks/normalizers/msteams';
import { registerNormalizer } from './hooks/normalizers/registry';
import { createOutboundGuard } from './hooks/outbound-guard';
import { createToolGuard } from './hooks/tool-guard';
import { syncFrameworkIdentity } from './plugin-sync';
// Note: platform-relay-client uses direct token-based auth (HTTP Events pipeline)
// and is separate from the adapter pattern used by before_dispatch / before_tool_call.
import { createPlatformRelayClient } from './services/platform-relay-client';
import { createTools } from './tools';
import { startWebhookServer } from './webhook';

/**
 * Detect whether any Slack account is in HTTP Events mode and return
 * its signing secret and bot token.  Checks both single-account
 * (top-level) and multi-account (accounts map) configs.
 */
function detectSlackHttpMode(api: OpenClawPluginApi): {
  signingSecret: string;
  botToken: string;
} | null {
  const slack = api.config?.channels?.slack;
  if (!slack) return null;

  const check = (account: SlackAccountConfig) =>
    account.mode === 'http' && account.signingSecret && account.botToken
      ? { signingSecret: account.signingSecret, botToken: account.botToken }
      : null;

  // Single-account config (mode at top level)
  const top = check(slack);
  if (top) return top;

  // Multi-account config
  if (slack.accounts) {
    for (const account of Object.values(slack.accounts)) {
      const found = check(account);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Detect whether Teams is configured. If so and `managementUrl` is set,
 * we enable the platform relay client for Teams inbound activities so
 * Azure → management route → DO → plugin → local OpenClaw endpoint works.
 */
function detectTeamsConfig(api: OpenClawPluginApi): {
  appId: string;
  appPassword: string;
  tenantId: string;
  port: number;
  path: string;
} | null {
  const msteams = api.config?.channels?.msteams;
  if (!msteams?.appId || !msteams?.appPassword || !msteams?.tenantId)
    return null;
  return {
    appId: msteams.appId,
    appPassword: msteams.appPassword,
    tenantId: msteams.tenantId,
    port: msteams.webhook?.port ?? 3978,
    path: msteams.webhook?.path ?? '/api/messages',
  };
}

export function register(api: OpenClawPluginApi): void {
  const config = loadConfig(api.pluginConfig ?? {});
  const agentCard = buildAgentCard(config);

  // Register tools
  const tools = createTools(config);
  for (const { definition, parameters } of tools) {
    api.registerTool(createAgentTool(definition, parameters));
  }

  // Framework identity — reconcile `agents.framework` on startup.
  // Registered BEFORE the webhook/relay services so the branch's
  // registration-order integration harness guarantees `plugin-sync`
  // completes before the first evaluate path is reachable
  // (REQ-FI-006 step 1-2).
  //
  // `agentSecret` is read from the explicit plugin config, not from
  // `getConfig()` — the latter is populated asynchronously by the
  // webhook's `fetchInitialManifest`, so on a cold start it can still
  // be `null` when this service starts. The explicit config is the
  // authoritative source here.
  if (config.agentId && config.managementUrl && config.agentSecret) {
    const managementUrl = config.managementUrl;
    const agentId = config.agentId;
    const agentSecret = config.agentSecret;
    api.registerService({
      id: 'spellguard-plugin-sync',
      async start() {
        await syncFrameworkIdentity({
          agentId,
          managementUrl,
          agentSecret,
        });
      },
      stop() {
        // No teardown — plugin-sync is a one-shot on start.
      },
    });
  } else if (config.agentId && config.managementUrl) {
    console.error(
      JSON.stringify({
        event: 'plugin_sync.skipped',
        reason: 'no-agent-secret',
        agentId: config.agentId,
      }),
    );
  }

  // Manage webhook server lifecycle via service registration
  let serverClose: (() => void) | undefined;

  api.registerService({
    id: 'spellguard-webhook',
    start() {
      const server = startWebhookServer(config, agentCard);
      serverClose = () => server.close();
    },
    stop() {
      serverClose?.();
      serverClose = undefined;
      reset();
    },
  });

  // Auto-detect Slack HTTP Events mode from OpenClaw config and register
  // the relay client (connects to management server Durable Object via WS).
  const httpSlack = detectSlackHttpMode(api);
  if (httpSlack && config.managementUrl) {
    const gatewayPort = api.config?.gateway?.port ?? 4000;
    const relayClient = createPlatformRelayClient(config, {
      slackSigningSecret: httpSlack.signingSecret,
      slackBotToken: httpSlack.botToken,
      gatewayPort,
    });

    api.registerService({
      id: 'spellguard-platform-relay',
      async start() {
        await relayClient.connect();
      },
      stop() {
        relayClient.stop();
      },
    });
  }

  // Auto-detect Teams config from OpenClaw config and register a second
  // platform relay client scoped to Teams inbound activities. For agents
  // that configure both Slack HTTP Events AND Teams, we currently open
  // two independent WebSockets to the same per-agent Durable Object — a
  // known non-ideal that will be consolidated in a follow-up once the
  // relay client supports multiplexed-platform mode.
  const teams = detectTeamsConfig(api);
  if (teams && config.managementUrl) {
    const teamsRelay = createPlatformRelayClient(config, {
      teamsPort: teams.port,
      teamsPath: teams.path,
      openclawConfig: api.config as Record<string, unknown>,
    });
    api.registerService({
      id: 'spellguard-teams-relay',
      async start() {
        await teamsRelay.connect();
      },
      stop() {
        teamsRelay.stop();
      },
    });
  }

  // Register security hooks for Verifier-based policy evaluation
  const hookConfig = {
    verifierUrl: config.verifierUrl ?? config.managementUrl ?? '',
    agentId: config.agentId,
    managementUrl: config.managementUrl,
  };

  if (hookConfig.verifierUrl) {
    // Register platform adapters for block notice dispatch
    registerAdapter(slackAdapter);
    registerAdapter(discordAdapter);
    registerAdapter(msteamsAdapter);

    // Register content normalizers
    registerNormalizer('discord', discordNormalizer);
    registerNormalizer('msteams', msteamsNormalizer);
    // Slack has no normalizer — content passes through unchanged

    api.on('message_sending', createOutboundGuard(hookConfig), {
      priority: 100,
    });
    // Stash messageId from message_received metadata so before_dispatch can
    // use it for threaded block notices — works on stock upstream OpenClaw.
    // TODO: Remove once upstream adds messageId to before_dispatch event.
    api.on('message_received', createMessageIdObserver());
    api.on(
      'before_dispatch',
      createBeforeDispatchGuard(hookConfig, {
        openclawConfig: api.config as Record<string, unknown>,
      }),
      { priority: 100 },
    );
    api.on('before_tool_call', createToolGuard(hookConfig), {
      priority: 100,
    });
  }
}

export default register;
