// SPDX-License-Identifier: Apache-2.0
//
// #1407 slice B (REM-064): a bypass of the mediated path raises an alert a
// person sees. The Verifier never sees a delivery that didn't come through it,
// so the receiver reports it: each delivery `/_spellguard/receive` refused (or,
// in report-only mode, accepted unverified) is posted to management's
// `POST /v1/agents/:id/delivery-bypass` with the agent secret, and the org's
// owners and admins get a dashboard notice.
//
// Anyone who can reach the agent can POST to `/_spellguard/receive`, so the
// reporter sends at most one report per outcome and reason every five
// minutes; management also folds repeats into one open notice. Like the usage
// telemetry it is fire-and-forget and fail-open: it never throws into, or
// slows, the receive handler. It returns the pending report so a Worker can
// hand it to `waitUntil`: workerd cancels a fetch still pending when the
// response returns.

import type { DeliveryAuthFailure } from '@spellguard/ctls/delivery';
import { getConfig } from './attestation';
import { resolveManagementBase } from './usage-telemetry';

export type DeliveryBypassOutcome = 'refused' | 'accepted_unverified';

/**
 * Management's closed vocabulary (`DELIVERY_BYPASS_REASONS`). No
 * `plaintext_refused`: a plaintext delivery refused after it passed the
 * signature check came from the Verifier, so it is not a bypass (#1858).
 */
export type DeliveryBypassReason =
  | DeliveryAuthFailure
  | 'missing_channel_token'
  | 'plaintext_accepted';

const REPORT_INTERVAL_MS = 5 * 60_000;
const EMIT_TIMEOUT_MS = 5000;

/**
 * A per-agent reporter (one per `createSpellguard` instance). Returns the
 * pending report, which never rejects, or undefined when nothing was sent.
 */
export function createDeliveryBypassReporter(): (
  outcome: DeliveryBypassOutcome,
  reason: DeliveryBypassReason,
) => Promise<void> | undefined {
  const lastReportedAt = new Map<string, number>();
  return (outcome, reason) => {
    try {
      const cfg = getConfig();
      if (!cfg?.agentId || !cfg?.agentSecret) return undefined;
      const base = resolveManagementBase(cfg);
      if (!base) return undefined;
      const key = `${outcome}:${reason}`;
      const now = Date.now();
      const last = lastReportedAt.get(key);
      if (last !== undefined && now - last < REPORT_INTERVAL_MS) {
        return undefined;
      }
      lastReportedAt.set(key, now);
      return fetch(
        `${base}/v1/agents/${encodeURIComponent(cfg.agentId)}/delivery-bypass`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.agentSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ outcome, reason }),
          signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
        },
      )
        .then(async (res) => {
          await res.text();
        })
        .catch(() => undefined);
    } catch {
      // fail-open: a report must never affect the delivery's answer
      return undefined;
    }
  };
}
