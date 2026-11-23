// SPDX-License-Identifier: Apache-2.0

/**
 * Gateway usage reporter.
 *
 * The LLM gateway meters each proxied model call and enqueues a usage event
 * here; a buffer is flushed periodically (one signed POST per agent per flush)
 * to `POST /v1/internal/agents/{agentId}/usage`, authenticated with the
 * Verifier's Ed25519 identity (`signRequest`).
 *
 * Buffered — not a bare per-call fire-and-forget — because Fargate has no
 * `waitUntil`: a naive background fetch can be cut mid-flight at the RSS
 * self-recycle. The buffer + short flush interval keep the emit off the per-call
 * hot path while making delivery best-effort-durable. Usage is approximate, and
 * for non-fully-proxied agents the Source-A poller still backstops the dollars,
 * so a rare lost buffer on recycle is acceptable.
 */

import { signRequest } from './request-signer';

export interface GatewayUsageEvent {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** Provider-authoritative USD (OpenRouter usage.cost); null when absent. */
  costUsd: number | null;
}

const FLUSH_INTERVAL_MS =
  Number(process.env.SPELLGUARD_LLM_USAGE_FLUSH_MS) || 10_000;
const MAX_BATCH = 200;

// agentId → pending events
const buffers = new Map<string, GatewayUsageEvent[]>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

// ── Diagnostic counters (read-only; surfaced via GET /internal/llm-usage-stats)
// so the enqueue→buffer→flush chain is observable on Fargate without log access.
// Distinguishes the two failure modes: completion-had-no-usage (completionsSeen >
// completionsWithUsage) vs flush-never-lands (enqueued > flushOk, lastFlushStatus).
interface UsageReporterStats {
  managementUrlPresent: boolean;
  completionsSeen: number;
  completionsWithUsage: number;
  enqueued: number;
  flushAttempts: number;
  flushOk: number;
  flushFail: number;
  bufferedNow: number;
  lastFlushStatus: string | null;
  lastEventTokens: {
    prompt: number;
    completion: number;
    total: number;
    cost: number | null;
  } | null;
  lastEnqueueAt: number | null;
  lastFlushAt: number | null;
}

const stats = {
  completionsSeen: 0,
  completionsWithUsage: 0,
  enqueued: 0,
  flushAttempts: 0,
  flushOk: 0,
  flushFail: 0,
  lastFlushStatus: null as string | null,
  lastEventTokens: null as UsageReporterStats['lastEventTokens'],
  lastEnqueueAt: null as number | null,
  lastFlushAt: null as number | null,
};

/** Record that the gateway parsed a completion (whether or not it carried usage). */
export function recordCompletionSeen(hadUsage: boolean): void {
  stats.completionsSeen += 1;
  if (hadUsage) stats.completionsWithUsage += 1;
}

/** Read-only snapshot of the metering pipeline counters (diagnostic endpoint). */
export function getUsageReporterStats(): UsageReporterStats {
  let buffered = 0;
  for (const b of buffers.values()) buffered += b.length;
  return {
    managementUrlPresent: !!process.env.MANAGEMENT_URL,
    completionsSeen: stats.completionsSeen,
    completionsWithUsage: stats.completionsWithUsage,
    enqueued: stats.enqueued,
    flushAttempts: stats.flushAttempts,
    flushOk: stats.flushOk,
    flushFail: stats.flushFail,
    bufferedNow: buffered,
    lastFlushStatus: stats.lastFlushStatus,
    lastEventTokens: stats.lastEventTokens,
    lastEnqueueAt: stats.lastEnqueueAt,
    lastFlushAt: stats.lastFlushAt,
  };
}

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushAllUsage();
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** Enqueue one gateway-metered usage event for an agent (non-blocking). */
export function enqueueGatewayUsage(
  agentId: string,
  event: GatewayUsageEvent,
): void {
  if (!process.env.MANAGEMENT_URL) return; // no consumer configured
  const buf = buffers.get(agentId);
  if (buf) buf.push(event);
  else buffers.set(agentId, [event]);
  stats.enqueued += 1;
  stats.lastEnqueueAt = Date.now();
  stats.lastEventTokens = {
    prompt: event.promptTokens,
    completion: event.completionTokens,
    total: event.totalTokens,
    cost: event.costUsd,
  };
  ensureTimer();
}

async function flushOne(
  agentId: string,
  events: GatewayUsageEvent[],
): Promise<void> {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!managementUrl) return;
  const batch = events.slice(0, MAX_BATCH);
  stats.flushAttempts += 1;
  stats.lastFlushAt = Date.now();
  try {
    const bodyStr = JSON.stringify({ events: batch });
    const url = `${managementUrl}/v1/internal/agents/${encodeURIComponent(agentId)}/usage`;
    const headers = await signRequest('POST', url, bodyStr);
    // Pass the signed headers verbatim — do NOT add `content-type:
    // application/json`. With that header + verifierAuth's `c.req.raw.clone()`
    // body read, the JSON body arrives EMPTY at the route's zod validation
    // ("events: expected array, received undefined" → 422, every flush
    // re-queued). The default text/plain (from a string body) validates fine —
    // this is exactly how the working audit-log reporter (reporter.ts) posts.
    // Confirmed live on staging 2026-07-19 via /internal/llm-usage-stats.
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`usage ingest HTTP ${res.status}`);
    stats.flushOk += 1;
    stats.lastFlushStatus = `ok ${res.status}`;
  } catch (err) {
    stats.flushFail += 1;
    stats.lastFlushStatus = err instanceof Error ? err.message : String(err);
    console.warn(
      `[GatewayUsageReporter] flush failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Re-queue (front) for the next flush.
    const cur = buffers.get(agentId);
    if (cur) cur.unshift(...batch);
    else buffers.set(agentId, batch);
  }
}

/** Flush all buffered usage. Exported for the shutdown hook + tests. */
export async function flushAllUsage(): Promise<void> {
  for (const agentId of [...buffers.keys()]) {
    const events = buffers.get(agentId);
    if (!events || events.length === 0) {
      buffers.delete(agentId);
      continue;
    }
    buffers.set(agentId, []); // take the batch; re-queue handled by flushOne
    await flushOne(agentId, events);
    if (buffers.get(agentId)?.length === 0) buffers.delete(agentId);
  }
}

export function stopUsageReporter(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
