// SPDX-License-Identifier: Apache-2.0
//
// Source B — self-reported SDK token telemetry. The instrumented LLM call paths
// (`generateText`, `intent`, the OpenAI + LangChain adapters, `streamText`) emit
// a per-call token-usage event here; this fires a direct, agent-authenticated
// `POST /v1/agents/:id/usage` to Management (Decision A — the Verifier adds no
// trust for self-reported numbers, §6.5).
//
// LOAD-BEARING — fail-open + off the critical path (§6.2). This runs INSIDE the
// agent we are policing, so it must NEVER throw into, block, or slow the user's
// LLM call, and a compromised agent simply not emitting is expected. It is
// therefore fire-and-forget and swallows every error. Self-reported tokens drive
// dashboards + observe/alert limits ONLY — never a hard key-disabling stop
// (the management resolver structurally refuses token-only → disable, §7.2).

import { getConfig } from './attestation';
import type { SpellguardConfig } from './types';

/** One self-reported usage event (matches the management ingest contract). */
export interface UsageEvent {
  /** Provider model id (e.g. `openai/gpt-4.1-mini`) — priced server-side. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface ReportUsageDeps {
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override the resolved config (tests). */
  config?: SpellguardConfig | null;
  /**
   * Await the POST instead of fire-and-forget (tests). Production call sites
   * never set this — the emit must stay off the critical path.
   */
  await?: boolean;
}

const EMIT_TIMEOUT_MS = 5000;

/** Coerce to a non-negative integer; treat junk as 0. */
function clampInt(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/** Read an env var when running under Node (absent in Workers → undefined). */
function envVar(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve Management's base URL (no trailing `/v1`). Prefers the configured
 * `managementUrl` (managed/discovery path), then `SPELLGUARD_MANAGEMENT_URL` /
 * `SPELLGUARD_BASE_URL`. Returns null when none is known (emit skips).
 */
function resolveManagementBase(cfg: SpellguardConfig | null): string | null {
  const raw =
    cfg?.managementUrl ??
    envVar('SPELLGUARD_MANAGEMENT_URL') ??
    envVar('SPELLGUARD_BASE_URL');
  if (!raw) return null;
  return raw.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

/**
 * Emit one usage event to Management. Fire-and-forget + fail-open by default:
 * never throws, never blocks, never reports for an agent without an agent
 * secret + a known management URL. Normalizes/clamps token counts and drops
 * all-zero events.
 */
export function reportUsageEvent(
  event: UsageEvent,
  deps?: ReportUsageDeps,
): void | Promise<void> {
  const run = async (): Promise<void> => {
    const cfg = deps?.config !== undefined ? deps.config : getConfig();
    if (!cfg?.agentId || !cfg?.agentSecret) return; // can't authenticate → skip
    const base = resolveManagementBase(cfg);
    if (!base) return;

    const normalized: UsageEvent = {
      model: typeof event.model === 'string' ? event.model : 'unknown',
      promptTokens: clampInt(event.promptTokens),
      completionTokens: clampInt(event.completionTokens),
      totalTokens: clampInt(event.totalTokens),
    };
    const cached = clampInt(event.cachedInputTokens);
    const reasoning = clampInt(event.reasoningTokens);
    if (cached > 0) normalized.cachedInputTokens = cached;
    if (reasoning > 0) normalized.reasoningTokens = reasoning;

    // Nothing to report — don't write empty buckets.
    if (
      normalized.promptTokens === 0 &&
      normalized.completionTokens === 0 &&
      normalized.totalTokens === 0
    ) {
      return;
    }

    const fetchImpl = deps?.fetchImpl ?? fetch;
    const url = `${base}/v1/agents/${encodeURIComponent(cfg.agentId)}/usage`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.agentSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ events: [normalized] }),
      signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
    });
    // Drain the body so the connection can be reused; ignore the result.
    await res.text().catch(() => undefined);
  };

  if (deps?.await) {
    return run().catch(() => undefined);
  }
  // Fire-and-forget: swallow everything, including a synchronous throw.
  try {
    void run().catch(() => undefined);
  } catch {
    /* fail-open */
  }
}

/** Best-effort model id from an ai-sdk `LanguageModel` (string or object). */
export function modelIdOf(model: unknown, fallback = 'unknown'): string {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const m = model as { modelId?: unknown; id?: unknown };
    if (typeof m.modelId === 'string') return m.modelId;
    if (typeof m.id === 'string') return m.id;
  }
  return fallback;
}

/**
 * Build + emit a usage event from an ai-sdk result's `usage` field
 * (`{ promptTokens, completionTokens, totalTokens }` in ai-sdk v4). DRYs the
 * `generateText` + `intent` call sites. No-op when usage is absent.
 */
export function reportAiSdkUsage(
  usage:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      }
    | undefined,
  model: string,
  deps?: ReportUsageDeps,
): void | Promise<void> {
  if (!usage) return;
  return reportUsageEvent(
    {
      model,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens:
        usage.totalTokens ??
        (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    },
    deps,
  );
}
