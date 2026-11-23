// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy-mode relay-only agent-control client.
 *
 * Refactor B (consolidated agent socket) folded inbound Slack/Teams relay onto
 * the single agent-control socket and DELETED the standalone platform-relay
 * client + its separate transport. But that relay wiring now lives inside the
 * credential service, which `index.ts` only starts for `source === 'socket'`
 * deployments (a credential store on disk). A LEGACY deployment (`agentSecret`
 * in `openclaw.json`, no store) therefore lost inbound Slack/Teams relay
 * entirely — the bot goes silent on mentions even though it evaluated fine
 * before. (Pre-Refactor B the standalone relay client carried these events for
 * legacy mode via proxy-connect/management-token auth, independent of the
 * credential store.)
 *
 * The box still holds a valid `agentSecret`, so it CAN authenticate the
 * agent-control socket in secret mode. This factory builds a RELAY-ONLY client:
 * it wires ONLY `onRelayEvent` into the shared relay dispatcher. It does NOT
 * handle credential frames (the required credential callbacks are no-ops — the
 * client still ACKs delivered frames on the wire, but nothing is persisted or
 * merged into `openclaw.json`), declares NO capabilities, and does NOT emit
 * `channel_ready` — so the legacy credential path (static `agentSecret` in
 * config) is left completely untouched.
 *
 * Disclosed side effects (admin-telemetry-level, on a deprecated path): a legacy
 * box now appears ONLINE server-side, and any `credential_delivered` frames the
 * server emits on Resume are ACKed-but-ignored here. These are documented as an
 * operator-vetoable design call in the PR and ride the same `qa:cross-plugin`
 * gate as the rest of the branch.
 *
 * Residual (disclosed): a pre-`agentUuid` legacy config carries only the public
 * slug, and the agent-control channel route requires the INTERNAL UUID. Without
 * `agentUuid` we cannot open the socket, so those deployments still get NO relay
 * — the factory no-ops with a `legacy_relay.skipped` log naming the missing field.
 */

import {
  AgentControlClient,
  type AgentControlClientOptions,
} from '@spellguard/agent-control';
import type { loadConfig } from '../config';
import {
  type RelayForwardOptions,
  createRelayDispatcher,
} from '../services/relay-dispatch';
import type { CredentialSource } from './legacy-flow-detector';

/** The minimal client-lifecycle surface `index.ts` drives (start + close). */
export interface MinimalRelayClient {
  start(): void;
  close(): void;
}

export interface LegacyRelayClientDeps {
  /** Test seam — defaults to constructing a real `AgentControlClient`. */
  clientFactory?: (opts: AgentControlClientOptions) => MinimalRelayClient;
  /** Test seam — defaults to the real `createRelayDispatcher`. */
  createDispatcher?: typeof createRelayDispatcher;
  /** Logger seam for tests. Defaults to `console.warn`. */
  logger?: (line: string) => void;
}

/**
 * Build the legacy relay-only agent-control client, or return `null` when it
 * should not run. `index.ts` calls this once and registers a service around the
 * result. All gating lives here so every case is unit-testable at one seam
 * (there is no `register()` unit-test seam in this repo — see
 * `credential-service-relay.test.ts`).
 */
export function buildLegacyRelayClient(
  args: {
    source: CredentialSource;
    config: ReturnType<typeof loadConfig>;
    relayForwardOptions: RelayForwardOptions | null;
  },
  deps: LegacyRelayClientDeps = {},
): MinimalRelayClient | null {
  const { source, config, relayForwardOptions } = args;
  const log = deps.logger ?? ((s: string) => console.warn(s));

  // Socket-mode deployments already own the agent-control socket via the
  // credential service (which wires relay itself) — NEVER open a second client.
  if (source === 'socket') return null;
  // No http-mode Slack/Teams channel configured → nothing to relay into.
  if (!relayForwardOptions) return null;
  // Not a legacy relay-capable config (needs the agent secret + management URL).
  if (!config.agentSecret || !config.managementUrl) return null;
  // Pre-`agentUuid` legacy config: the channel route keys on the INTERNAL UUID,
  // which we don't have. Disclosed residual — no relay for these deployments
  // until they migrate via `openclaw spellguard setup`.
  if (!config.agentUuid) {
    log(
      JSON.stringify({
        event: 'legacy_relay.skipped',
        reason: 'missing-agent-uuid',
        message:
          'Legacy relay-only client not started: openclaw.json has no agentUuid (the agent-control socket keys on the internal UUID). Run `openclaw spellguard setup` to migrate to the credential socket.',
        agentId: config.agentId,
      }),
    );
    return null;
  }

  const agentUuid = config.agentUuid;
  const agentSecret = config.agentSecret;
  const managementUrl = config.managementUrl;

  const dispatcher = (deps.createDispatcher ?? createRelayDispatcher)(
    { agentId: agentUuid },
    relayForwardOptions,
  );

  const options: AgentControlClientOptions = {
    apiBaseUrl: managementUrl,
    agentId: agentUuid,
    // Secret-mode auth with the box's existing agent secret (same shape the
    // credential service uses). Reconnect/backoff is the client's own machinery.
    credentials: () => ({
      mode: 'secret' as const,
      agentId: agentUuid,
      agentSecret,
    }),
    // Relay-ONLY: credential frames are ACKed by the client but intentionally
    // NOT handled here — the legacy credential path (static agentSecret in
    // openclaw.json) owns credential material. No persistence, no merge, no
    // seq-cursor tracking (relay frames carry no seq anyway).
    onCredentialDelivered: () => {},
    onSeqAdvanced: () => {},
    onFatalClose: (code, reason) =>
      log(JSON.stringify({ event: 'legacy_relay.fatal_close', code, reason })),
    onError: (err) =>
      log(
        JSON.stringify({ event: 'legacy_relay.error', message: err.message }),
      ),
    // The ONE thing this client exists for: forward inbound Slack/Teams relay
    // frames to the local bot surface (fire-and-forget; the client swallows any
    // throw so a faulty forward can never disturb the socket).
    onRelayEvent: (frame) => dispatcher.dispatchRelayEnvelope(frame),
    // NOTE: no `capabilities` (don't provoke multi-org credential minting) and
    // no `onConnect`/channel_ready (a credential-service concern) — relay only.
  };

  log(JSON.stringify({ event: 'legacy_relay.starting', agentId: agentUuid }));

  return deps.clientFactory
    ? deps.clientFactory(options)
    : new AgentControlClient(options);
}
