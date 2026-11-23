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
 * already subscribed, so delivery is warm. Steady-state passes are cheap cache
 * hits (see `warmRoster`). A gateway RESTART wipes the gateway's registry but
 * NOT this verifier's registration cache, so the cache-hit passes would stop
 * re-pushing and every recipient would degrade to a cold lazy re-register on
 * its next delivery; the gateway-restart WATCHER below detects the restart
 * (the gateway's uptime drops) and clears the cache so the next pass
 * proactively re-subscribes everyone — once per restart, never per pass. The
 * lazy path + the forwardToRecipient retry remain as a backstop for agents that
 * appear between syncs.
 *
 * Managed-only: in no-Management mode agents self-register eagerly via
 * `createSpellguard`, so there is no roster endpoint and no cold-start gap.
 */

import { signRequest } from '../management/request-signer';
import {
  ensureGatewayRegistered,
  resetGatewayRegistrations,
} from './managed-delivery';

interface RosterAgent {
  agentId: string;
  name?: string;
  endpointUrl: string | null;
}

type Logger = (level: 'info' | 'warn' | 'error', msg: string) => void;

const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_LIVENESS_INTERVAL_MS = 15_000;

/** Minimal shape read from the gateway's /health probe. */
interface GatewayHealth {
  uptimeMs: number;
}

/**
 * The gateway's /health URL, derived from the gateway URL the verifier already
 * holds — AgntcyVerifierStack sets `SPELLGUARD_AGENT_URL` to the gateway host in
 * agntcy mode. Undefined ⇒ no gateway to watch (original / no-Management mode).
 */
function deriveGatewayHealthUrl(): string | undefined {
  const base = process.env.SPELLGUARD_AGENT_URL?.trim();
  if (!base) return undefined;
  return `${base.replace(/\/$/, '')}/health`;
}

async function defaultFetchHealth(url: string): Promise<GatewayHealth | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { uptimeMs?: unknown };
  return typeof data.uptimeMs === 'number' ? { uptimeMs: data.uptimeMs } : null;
}

/**
 * One gateway-liveness probe. The gateway's `uptimeMs` (`Date.now() -
 * STARTED_AT`) only ever DECREASES across probes when the gateway process
 * restarted — which is exactly when it wiped its in-memory subscription
 * registry. On that decrease, invalidate the registration cache and ask for an
 * immediate re-warm; on an increase (or the very first probe) do nothing. A
 * failed / garbled probe is fail-safe: keep the last-seen uptime and never
 * churn on a transient error.
 *
 * Returns the uptime to remember for the next probe. Exported for testing.
 */
export async function checkGatewayRestart(opts: {
  healthUrl: string;
  lastUptimeMs: number | undefined;
  fetchHealth: (url: string) => Promise<GatewayHealth | null>;
  onRestart: () => void;
  log?: Logger;
}): Promise<number | undefined> {
  let health: GatewayHealth | null;
  try {
    health = await opts.fetchHealth(opts.healthUrl);
  } catch {
    return opts.lastUptimeMs; // transient fetch failure — never churn
  }
  if (!health) return opts.lastUptimeMs;
  const { uptimeMs } = health;
  if (opts.lastUptimeMs !== undefined && uptimeMs < opts.lastUptimeMs) {
    opts.log?.(
      'info',
      `[RosterSync] gateway restart detected (uptime ${uptimeMs}ms < last ${opts.lastUptimeMs}ms) — resetting registrations + re-warming`,
    );
    opts.onRestart();
  }
  return uptimeMs;
}

/** Fetch the agent roster from Management (signed verifier request). */
export async function fetchAgentRoster(): Promise<RosterAgent[]> {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!managementUrl) return [];
  const url = `${managementUrl}/v1/internal/agents`;
  const headers = await signRequest('GET', url, '');
  const res = await fetch(url, {
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
 * not in managed mode. Steady-state passes are cheap cache hits; a gateway
 * restart is recovered by the gateway-restart watcher (clears the cache so the
 * next pass re-subscribes everyone), not by the pass alone.
 */
export function startRosterSync(opts?: {
  intervalMs?: number;
  log?: Logger;
  /** Gateway-restart watcher overrides (testing / tuning). By default the
   *  health URL is derived from `SPELLGUARD_AGENT_URL` and the reset clears the
   *  managed-delivery registration cache. */
  gatewayHealthUrl?: string;
  livenessIntervalMs?: number;
  fetchHealth?: (url: string) => Promise<GatewayHealth | null>;
  resetRegistrations?: () => void;
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

  // ── Gateway-restart watcher (agntcy managed slim only) ──────────────────
  // A gateway OOM-recycle wipes its in-memory subscription registry. This
  // verifier's registration cache doesn't know, so warmRoster's cache-hits stop
  // re-pushing and every recipient pays a cold lazy re-register on its next
  // delivery. Poll the gateway's uptime; when it DROPS (a restart), reset the
  // cache + re-warm immediately — ONCE per restart, so this never re-creates
  // the every-pass re-registration churn the pre-sync deliberately avoids. Off
  // when the gateway URL is absent (original / no-Management) or explicitly
  // disabled via SPELLGUARD_GATEWAY_RESTART_RESYNC=0 (the kill-switch for the
  // leak-sensitive re-registration path).
  const healthUrl = opts?.gatewayHealthUrl ?? deriveGatewayHealthUrl();
  const watchEnabled =
    !!healthUrl && process.env.SPELLGUARD_GATEWAY_RESTART_RESYNC !== '0';
  const fetchHealth = opts?.fetchHealth ?? defaultFetchHealth;
  const reset = opts?.resetRegistrations ?? resetGatewayRegistrations;
  let lastGatewayUptimeMs: number | undefined;
  let livenessTimer: ReturnType<typeof setInterval> | undefined;
  if (watchEnabled && healthUrl) {
    const livenessTick = async (): Promise<void> => {
      if (stopped) return;
      lastGatewayUptimeMs = await checkGatewayRestart({
        healthUrl,
        lastUptimeMs: lastGatewayUptimeMs,
        fetchHealth,
        onRestart: () => {
          reset();
          void guardedTick(); // proactive re-warm (overlap-guarded)
        },
        log,
      });
    };
    livenessTimer = setInterval(
      () => void livenessTick(),
      opts?.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS,
    );
    (livenessTimer as { unref?: () => void }).unref?.();
  }

  return {
    primed,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (livenessTimer) clearInterval(livenessTimer);
    },
  };
}
