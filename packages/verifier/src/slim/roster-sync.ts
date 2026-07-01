// SPDX-License-Identifier: Apache-2.0

/**
 * Slim-profile roster PRE-SYNC.
 *
 * Always-on SLIM delivery (managed-delivery.ts) needs the gateway subscribed to
 * a recipient's slimName BEFORE the verifier delivers to it — otherwise the
 * first `createSession` finds no subscriber and the message races (or hangs).
 * Registering lazily at delivery time put that race + a control-plane round-trip
 * INSIDE the message hot path, which blew the demo's per-scenario time budget
 * on every cold recipient.
 *
 * This module moves the warming OUT of the hot path: on verifier startup, and
 * on a timer, it fetches the full agent roster from Management
 * (`GET /v1/internal/agents`) and registers every agent's slimName → HTTP
 * callback with the gateway. By the time a message is delivered the gateway is
 * already subscribed, so delivery is warm. The timer also re-registers each
 * cycle, so a gateway restart (which drops its in-memory registry) self-heals
 * within one interval rather than degrading every recipient until its first
 * lazy re-register. The lazy path + the forwardToRecipient retry remain as a
 * backstop for agents that appear between syncs.
 *
 * Managed-only: in no-Management mode agents self-register eagerly via
 * `createSpellguard`, so there is no roster endpoint and no cold-start gap.
 */

import { signRequest } from '../management/request-signer';
import { ensureGatewayRegistered } from './managed-delivery';

interface RosterAgent {
  agentId: string;
  name?: string;
  endpointUrl: string | null;
}

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const DEFAULT_INTERVAL_MS = 120_000;

/** Fetch the agent roster from Management (signed verifier request). */
export async function fetchAgentRoster(): Promise<RosterAgent[]> {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!managementUrl) return [];
  const headers = await signRequest('');
  const res = await fetch(`${managementUrl}/v1/internal/agents`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`management /v1/internal/agents → HTTP ${res.status}`);
  }
  const data = (await res.json()) as { agents?: RosterAgent[] };
  return data.agents ?? [];
}

export interface RosterSyncHandle {
  /** Resolves after the first sync pass completes (best-effort). */
  primed: Promise<void>;
  stop: () => void;
}

/** Register every agent that has an endpoint with the gateway (one pass). */
async function warmRoster(
  roster: RosterAgent[],
  isStopped: () => boolean,
): Promise<{ warmed: number; skipped: number }> {
  let warmed = 0;
  let skipped = 0;
  for (const agent of roster) {
    if (isStopped()) break;
    if (!agent.endpointUrl) {
      skipped++;
      continue;
    }
    const httpBase = agent.endpointUrl.replace(/\/$/, '');
    // ensureGatewayRegistered is cached + idempotent: it only pushes a
    // register (which opens a fresh SLIM control session) when the agent is
    // not yet registered or its callback URL changed. We deliberately do NOT
    // force-invalidate each pass: that re-created a SLIM session for ALL ~N
    // agents every interval, and unclosed sessions accumulate (the SLIM 1.4.0
    // leak) until the verifier hits its memory ceiling and GC-thrashes the
    // event loop. After the first warm pass, subsequent passes are cheap
    // cache hits. Gateway-restart recovery instead rides the delivery retry,
    // which invalidates + re-registers the specific recipient on a
    // `session-failed` send (see forwardToRecipient) — a one-delivery
    // cold-start per agent rather than a permanent re-registration storm.
    if (await ensureGatewayRegistered(agent.agentId, httpBase)) warmed++;
  }
  return { warmed, skipped };
}

/**
 * Start the roster pre-sync loop. No-op (immediately resolved, stop = noop) when
 * not in managed mode. Each pass force-re-registers every agent that has an
 * endpoint, so a gateway restart is recovered within one interval.
 */
export function startRosterSync(opts?: {
  intervalMs?: number;
  log?: Logger;
}): RosterSyncHandle {
  const log: Logger =
    opts?.log ??
    ((lvl, msg) => console[lvl === 'error' ? 'error' : 'log'](msg));
  if (!process.env.MANAGEMENT_URL) {
    return { primed: Promise.resolve(), stop: () => undefined };
  }
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let roster: RosterAgent[];
    try {
      roster = await fetchAgentRoster();
    } catch (err) {
      log(
        'warn',
        `[RosterSync] roster fetch failed: ${(err as Error).message}`,
      );
      return;
    }
    const { warmed, skipped } = await warmRoster(roster, () => stopped);
    const suffix = skipped ? ` (${skipped} skipped — no endpoint)` : '';
    log(
      'info',
      `[RosterSync] warmed ${warmed}/${roster.length} agents with the gateway${suffix}`,
    );
  };

  // Overlap guard: under SLIM control-plane flakiness a pass can take longer
  // than `intervalMs` (each ensureGatewayRegistered drags). Without this, the
  // interval fires anyway and passes pile up — N concurrent passes each
  // re-registering ~20 agents multiply the SLIM load, which is exactly the
  // churn that saturates the verifier's event loop. Skip a tick while the
  // previous one is still in flight.
  let running = false;
  const guardedTick = async (): Promise<void> => {
    if (running) {
      log('warn', '[RosterSync] previous pass still running — skipping tick');
      return;
    }
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  };

  const primed = guardedTick();
  const timer = setInterval(() => void guardedTick(), intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    primed,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
