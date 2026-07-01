// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy-flow coexistence: during the transition window, the OpenClaw plugin
 * may have ONE OR BOTH of:
 *   - Config-file credentials (`agentSecret` in OpenClaw config)
 *   - New disk-persisted credential store (populated by `openclaw spellguard setup`)
 *
 * Decision matrix:
 *   | store | legacy | source  | deprecation |
 *   | ----- | ------ | ------- | ----------- |
 *   |  yes  |   yes  | socket  |    true     |  ← warn operator about config-file path
 *   |  yes  |   no   | socket  |    false    |
 *   |  no   |   yes  | legacy  |    false    |  ← supported until window closes
 *   |  no   |   no   | none    |    false    |  ← plugin runs in observation-only mode
 *
 * `deprecation: true` triggers a structured log line so we can grep for
 * how many deployments still carry stale legacy config after the
 * migration window — same approach Stream D uses for measuring rollout.
 *
 * Transition window length: **2 minor releases** from this stream's merge,
 * matching the deprecation cadence in `docs/operations-retention.md`. After
 * that, a follow-up PR removes the legacy branch in `index.ts`.
 */

import { readCredentialStore } from './credential-store';

export type CredentialSource = 'socket' | 'legacy' | 'none';

export interface DecideInput {
  storePath?: string;
  /** True iff the OpenClaw config has an `agentSecret` AND a `managementUrl`. */
  hasLegacyConfig: boolean;
  /** Logger seam for tests. Defaults to console.warn. */
  logger?: (line: string) => void;
}

export interface DecideResult {
  source: CredentialSource;
  /** True when both paths exist; the socket wins but the operator should be
   *  told the legacy config is no longer needed. */
  deprecation: boolean;
}

export function decideCredentialSource(input: DecideInput): DecideResult {
  const log = input.logger ?? ((s: string) => console.warn(s));
  const r = readCredentialStore(input.storePath);
  const hasStore = !!r.store;
  if (hasStore && input.hasLegacyConfig) {
    log(
      JSON.stringify({
        event: 'credential_source.legacy_config_active',
        message:
          'Both new credential store and legacy agentSecret are present; preferring the credential store. Remove agentSecret from openclaw.json after confirming the bot is healthy.',
      }),
    );
    return { source: 'socket', deprecation: true };
  }
  if (hasStore) return { source: 'socket', deprecation: false };
  if (input.hasLegacyConfig) {
    log(
      JSON.stringify({
        event: 'credential_source.legacy_only',
        message:
          'Using legacy agentSecret-based credentials. Run `openclaw spellguard setup` to migrate to the credential socket.',
      }),
    );
    return { source: 'legacy', deprecation: false };
  }
  return { source: 'none', deprecation: false };
}
