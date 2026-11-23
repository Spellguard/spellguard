// SPDX-License-Identifier: Apache-2.0

import { reset } from '@spellguard/client';
import type {
  OpenClawPluginApi,
  SlackAccountConfig,
} from 'openclaw/plugin-sdk';
import { createAgentTool } from './adapter';
import { buildAgentCard, loadConfig } from './config';
import {
  type CredentialSource,
  createCredentialService,
  decideCredentialSource,
} from './credentials';
import { buildLegacyRelayClient } from './credentials/legacy-relay-client';
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
import type { RelayForwardOptions } from './services/relay-dispatch';
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

/**
 * Merge the per-platform relay-forward parameters into ONE options object for
 * the single agent-control socket (it multiplexes Slack + Teams relay frames).
 * Returns null when no http-mode Slack/Teams channel is configured alongside a
 * `managementUrl` — in which case relay dispatch is never wired.
 */
function computeRelayForwardOptions(args: {
  managementUrl: string | undefined;
  httpSlack: { signingSecret: string; botToken: string } | null;
  teams: { port: number; path: string } | null;
  gatewayPort: number;
  openclawConfig: Record<string, unknown>;
}): RelayForwardOptions | null {
  const { managementUrl, httpSlack, teams, gatewayPort, openclawConfig } = args;
  if (!managementUrl || (!httpSlack && !teams)) return null;
  return {
    ...(httpSlack
      ? {
          slackSigningSecret: httpSlack.signingSecret,
          slackBotToken: httpSlack.botToken,
          gatewayPort,
        }
      : {}),
    ...(teams
      ? {
          teamsPort: teams.port,
          teamsPath: teams.path,
          openclawConfig,
        }
      : {}),
  };
}

/**
 * Register the legacy `spellguard-plugin-sync` service if a static
 * `agentSecret` is present in the OpenClaw config. Returns `true` when it
 * registered, so callers can suppress the credential service's own
 * framework-reconcile call during the deprecation window (CR-015).
 */
function registerLegacyPluginSync(
  api: OpenClawPluginApi,
  config: ReturnType<typeof loadConfig>,
): boolean {
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
    return true;
  }
  if (config.agentId && config.managementUrl) {
    console.error(
      JSON.stringify({
        event: 'plugin_sync.skipped',
        reason: 'no-agent-secret',
        agentId: config.agentId,
      }),
    );
  }
  return false;
}

/**
 * Legacy/none deployments with an http-mode Slack/Teams config: the box has a
 * static `agentSecret` but no on-disk credential store, so the credential
 * service (which owns the agent-control socket — and, since Refactor B, the
 * relay wiring) never starts. Before Refactor B a standalone relay client
 * carried inbound Slack/Teams events for legacy mode; that transport is gone, so
 * open a RELAY-ONLY agent-control client (secret-mode auth via the existing
 * agentSecret) that consumes relay frames without touching legacy credential
 * handling. `buildLegacyRelayClient` returns null in socket mode (the credential
 * service already owns the socket) and when `agentUuid` is absent (pre-UUID
 * legacy config — disclosed residual: no relay). See
 * `docs/reference/managed-agent-channels.md`.
 */
function registerLegacyRelayService(
  api: OpenClawPluginApi,
  source: CredentialSource,
  config: ReturnType<typeof loadConfig>,
  relayForwardOptions: RelayForwardOptions | null,
): void {
  const legacyRelayClient = buildLegacyRelayClient({
    source,
    config,
    relayForwardOptions,
  });
  if (!legacyRelayClient) return;
  api.registerService({
    id: 'spellguard-legacy-relay',
    start() {
      legacyRelayClient.start();
    },
    stop() {
      legacyRelayClient.close();
    },
  });
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
  const legacyPluginSyncRegistered = registerLegacyPluginSync(api, config);

  // Consolidated agent socket — detect relay-eligible platform configs. Inbound
  // Slack/Teams relay frames ride the single agent-control socket (wired into
  // the credential service below); there is no separate relay WebSocket.
  const httpSlack = detectSlackHttpMode(api);
  const teams = detectTeamsConfig(api);
  const gatewayPort = api.config?.gateway?.port ?? 4000;

  // Merged relay-forward options — the single agent-control socket carries BOTH
  // Slack and Teams relay frames, so ONE dispatcher needs both parameter sets.
  // Populated only for platforms actually configured alongside a managementUrl.
  const relayForwardOptions = computeRelayForwardOptions({
    managementUrl: config.managementUrl,
    httpSlack,
    teams,
    gatewayPort,
    openclawConfig: api.config as Record<string, unknown>,
  });

  // === Credential socket (Stream B) ===
  // Auto-detect whether the operator has run `openclaw spellguard setup` (new
  // path) versus the legacy agentSecret-based config. Prefer the socket if
  // both are present; emit a deprecation log line. If neither is present, do
  // not register the service — the plugin's security hooks still work in
  // observation mode.
  const credentialDecision = decideCredentialSource({
    hasLegacyConfig: !!(config.agentSecret && config.managementUrl),
  });
  if (credentialDecision.source === 'socket') {
    // CR-015: when the legacy `agentSecret`-driven `spellguard-plugin-sync`
    // service above is *also* registered (deprecation-window case), suppress
    // the framework-reconcile call inside the credential service to avoid
    // two POSTs per startup. Outside that window (socket-only — the
    // future-state), the credential service is the only path that writes
    // `agents.framework='openclaw'`.
    const credentialService = createCredentialService({
      reconcileFrameworkOnStart: !legacyPluginSyncRegistered,
      // Consolidated agent socket — wire inbound Slack/Teams relay frames that
      // ride the agent-control socket into the local Slack/Teams bot
      // (fire-and-forget). Present only when an http-mode Slack or Teams config
      // is configured (`relayForwardOptions` non-null). The credential service
      // also owns the `channel_ready` emit path; on socket (re)connect it fires
      // the http-mode readiness signal that the separate relay WS used to carry.
      ...(relayForwardOptions
        ? { relayDispatch: { options: relayForwardOptions } }
        : {}),
    });
    api.registerService({
      id: 'spellguard-credential-channel',
      async start() {
        await credentialService.start();
      },
      stop() {
        credentialService.stop();
      },
    });
  }

  // Legacy/none deployments with an http-mode Slack/Teams config: restore
  // inbound relay via a relay-only agent-control client (see
  // registerLegacyRelayService). No-op in socket mode.
  registerLegacyRelayService(
    api,
    credentialDecision.source,
    config,
    relayForwardOptions,
  );

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

  // Register security hooks for Verifier-based policy evaluation
  const hookConfig = {
    verifierUrl: config.verifierUrl ?? config.managementUrl ?? '',
    agentId: config.agentId,
    agentUuid: config.agentUuid,
    managementUrl: config.managementUrl,
    verifierTimeout: config.verifierTimeout,
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
