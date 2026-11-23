// SPDX-License-Identifier: Apache-2.0

import {
  generateText as originalGenerateText,
  streamText as originalStreamText,
  tool,
} from 'ai';
import type { GenerateTextResult, LanguageModel } from 'ai';
import { checkToolPolicy, getConfig, getOrCreateChannel } from './attestation';
import type { ToolCheckResult } from './attestation';
import { mapWithConcurrency } from './concurrency';
import { discoverAgents } from './discovery';
import { getCurrentHops, getCurrentSenderId } from './hop-context';
import { detectAgentReferences, mightContainAgentReference } from './intent';
import type { ClientChannel, ResolvedAgent } from './types';
import { modelIdOf, reportAiSdkUsage } from './usage-telemetry';

// biome-ignore lint/suspicious/noExplicitAny: ai-sdk types require flexible generics
type AnyGenerateTextResult = GenerateTextResult<any, any, any>;

/**
 * Default peer fan-out width: 1, i.e. SEQUENTIAL. Chosen while the AGNTCY SLIM
 * control plane is flaky: concurrent dispatch fires N `createSession` calls at
 * once, and during a plane wedge that reaches the verifier sender worker's "5
 * consecutive create-session failures → recycle" threshold faster, aggravating
 * the wedge/recycle churn. One-at-a-time keeps create-session load minimal. The
 * partial-tolerance below applies either way (a failed peer is dropped, not
 * fatal).
 *
 * This is the DEFAULT, not a hard-coded ceiling — see
 * {@link resolveFanoutConcurrency}.
 */
export const DEFAULT_FANOUT_CONCURRENCY = 1;

/** Environment variable that overrides the fan-out width. */
const FANOUT_CONCURRENCY_ENV = 'SPELLGUARD_FANOUT_CONCURRENCY';

/**
 * How many peer fan-out sends may run at once.
 *
 * Read per fan-out (not captured at module load) so a host can raise it without
 * a rebuild once its SLIM plane is stable, reclaiming the `max(leg)` latency win
 * — a 2-peer turn then pays `max(legA,legB)` instead of `legA + legB`. Anything
 * that is not a positive integer (absent, blank, junk, `0`, negative) falls back
 * to {@link DEFAULT_FANOUT_CONCURRENCY}, so a typo degrades to today's
 * sequential behaviour rather than to an unbounded fan-out.
 */
export function resolveFanoutConcurrency(): number {
  let raw: string | undefined;
  try {
    raw =
      typeof process !== 'undefined'
        ? process.env?.[FANOUT_CONCURRENCY_ENV]
        : undefined;
  } catch {
    raw = undefined;
  }
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return DEFAULT_FANOUT_CONCURRENCY;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed >= 1 ? parsed : DEFAULT_FANOUT_CONCURRENCY;
}

/**
 * Total wall-clock budget for the whole peer fan-out. The management proxy's
 * POST /chat has a 60s timeout (core-chat.ts `chatWithAgent`); a fan-out that
 * blows past it is aborted mid-flight and surfaces to the user as a bare 502
 * instead of a (degraded) answer. Capping the fan-out well under 60s means it
 * always returns whatever peers replied — or falls back to the direct LLM —
 * BEFORE the proxy gives up. During a SLIM wedge (create-session hangs
 * ~10s/attempt) this turns a 60s 502 into a graceful fallback.
 */
const FANOUT_BUDGET_MS = 45_000;

/**
 * Per-peer send ceiling. A single bilateral round-trip (incl. the peer's own
 * LLM) runs ~5-18s; cap at 25s so one wedged/hung send can't eat the whole
 * budget. The effective per-send timeout is `min(this, remaining budget)`.
 */
const FANOUT_PEER_TIMEOUT_MS = 25_000;

/**
 * Options for generateText - extends ai-sdk's options.
 */
export interface GenerateTextOptions {
  model: LanguageModel;
  prompt?: string;
  messages?: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

/**
 * Call the original generateText function with proper type casting.
 *
 * instrumentation seam: this single helper backs BOTH
 * `generateText` return paths, so the await-and-rewrap usage emit lives here once
 * rather than at each call site. The emit is fire-and-forget + fail-open
 * (`reportAiSdkUsage`) — it never throws into, blocks, or slows the LLM call.
 */
async function callOriginalGenerateText<T extends GenerateTextOptions>(
  options: T,
): Promise<AnyGenerateTextResult> {
  const result = (await originalGenerateText(
    options as Parameters<typeof originalGenerateText>[0],
  )) as AnyGenerateTextResult;
  const resultModelId = (result as { response?: { modelId?: string } }).response
    ?.modelId;
  reportAiSdkUsage(result.usage, resultModelId ?? modelIdOf(options.model));
  return result;
}

/**
 * One agent's contribution to a fan-out turn: its reply, or — when the agent
 * was referenced but could NOT be reached (discovery miss, offline peer, or a
 * transient send failure) — an `unreachable` marker.
 *
 * The marker exists so a referenced-but-unreachable agent is surfaced to the
 * model as an explicit "could not reach" note rather than being dropped to an
 * empty result. Dropping to empty is what let the unguarded LLM answer with NO
 * signal that the peer was unreachable, so it would confidently fabricate a
 * reply on the agent's behalf ("I reached out to agent-a and agent-b…") — a
 * correctness/trust bug independent of latency.
 */
export interface AgentResponse {
  agent: string;
  response: string;
  unreachable?: boolean;
}

/**
 * Format a list of agent responses into a context block string.
 * Shared between the ai-sdk and LangChain integrations.
 *
 * Reached agents render their reply; unreachable agents render an explicit
 * "could not be reached" block plus a directive not to fabricate an answer on
 * their behalf, so the model tells the user the truth instead of confabulating.
 */
export function buildAgentContextBlock(
  agentResponses: Array<AgentResponse>,
): string {
  const reached = agentResponses.filter((r) => !r.unreachable);
  const unreached = agentResponses.filter((r) => r.unreachable);

  const blocks = [
    ...reached.map(
      (r) =>
        `--- Response from ${r.agent} ---\n${r.response}\n--- End response from ${r.agent} ---`,
    ),
    ...unreached.map(
      (r) =>
        `--- ${r.agent}: UNREACHABLE ---\nSpellguard could not reach ${r.agent} — it is offline or did not respond, so NO answer was received from it.\n--- End ${r.agent} ---`,
    ),
  ];

  const instruction =
    reached.length > 0
      ? "You have received responses from other agents. Use this information along with your own data to provide a comprehensive answer to the user's query."
      : "You attempted to reach other agents on the user's behalf but received no responses.";
  const truthGuard =
    unreached.length > 0
      ? ` The following agent(s) could NOT be reached: ${unreached
          .map((r) => r.agent)
          .join(
            ', ',
          )}. Do NOT invent, guess, or paraphrase an answer on their behalf — tell the user plainly that you were unable to reach them.`
      : '';

  return `${instruction}${truthGuard}\n\n${blocks.join('\n\n')}`;
}

/**
 * Build the augmented system prompt with agent responses.
 */
function buildAugmentedSystem(
  originalSystem: string | undefined,
  agentResponses: Array<AgentResponse>,
): string {
  const block = buildAgentContextBlock(agentResponses);
  return originalSystem ? `${originalSystem}\n\n${block}` : block;
}

/**
 * Check whether a resolved agent is a Spellguard-attested (bilateral) agent.
 * Agents with 'spellguard-verifier' authentication or Verifier-routed stubs are bilateral.
 * All others are external and require unilateral attestation.
 */
export function isSpellguardAgent(agent: ResolvedAgent): boolean {
  // Verifier-routed stubs are created by discoverAgents when the Verifier can resolve them
  if (agent.url === 'verifier-routed') return true;

  // Check authentication scheme in the agent card
  const schemes = agent.agentCard?.authentication?.schemes;
  if (Array.isArray(schemes) && schemes.includes('spellguard-verifier'))
    return true;

  return false;
}

/**
 * Send a request to a single agent, automatically choosing bilateral or unilateral.
 */
async function sendToAgent(
  channel: ClientChannel,
  agent: ResolvedAgent,
  prompt: string,
  fromAgentId: string,
  timeoutMs?: number,
): Promise<string> {
  if (isSpellguardAgent(agent)) {
    // Bilateral: both agents are Spellguard-attested
    const response = await channel.send(
      agent.name,
      {
        type: 'agent-request',
        prompt,
        from: fromAgentId,
        context: { targetAgents: [agent.name] },
        _spellguardHops: getCurrentHops(),
      },
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
    return extractTextFromResponse(response);
  }

  // Unilateral: external agent, route through Verifier for audit logging
  console.log(
    `[Spellguard] Using unilateral attestation for external agent: ${agent.name}`,
  );
  const result = await channel.sendToA2A(agent.url || agent.name, {
    type: 'query',
    text: prompt,
  });

  if (!result.success) {
    throw new Error(
      `External agent ${agent.name} query failed: ${result.error}`,
    );
  }

  return (
    result.response?.result?.artifacts?.[0]?.parts?.[0]?.text ||
    'No response text'
  );
}

/**
 * Check whether an error from the Verifier indicates a policy block or rate limit.
 * These are terminal — the client must NOT fall back to the unguarded path.
 *
 * Note: fail-closed errors ("Blocked: policy data unavailable") also match
 * this check, but are handled by `isTransientError` first in the retry loop.
 * After retries are exhausted, the transient classification takes precedence
 * so the caller can fall back to the direct LLM path.
 */
export function isPolicyOrRateLimitError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('blocked by') ||
    lower.includes('blocked:') ||
    lower.includes('policy violation') ||
    lower.includes('too many requests') ||
    lower.includes('rate_limited')
  );
}

function isTransientError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('channel expired') ||
    lower.includes('recipient not found') ||
    lower.includes('not registered') ||
    lower.includes('policy data unavailable') ||
    lower.includes('fail-closed') ||
    lower.includes('failed to deliver')
  );
}

/**
 * Send to ONE peer with transient-error retry, bounded by a shared fan-out
 * `deadline` (absolute epoch-ms). Each attempt's send is capped at
 * `min(FANOUT_PEER_TIMEOUT_MS, remaining budget)`, and once the budget is spent
 * no further attempt/retry runs — so a wedged plane (create-session hangs
 * ~10s/attempt) can't drag the turn past the management proxy's 60s /chat
 * timeout (→ a bare 502). Backoff is short and never exceeds the remaining
 * budget. Only transient/infra failures are retried; a genuine policy/rate-limit
 * block propagates immediately, unretried.
 */
async function sendToAgentWithRetry(
  channel: ClientChannel,
  agent: ResolvedAgent,
  prompt: string,
  fromAgentId: string,
  deadline: number,
): Promise<string> {
  const maxRetries = 3;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw (
        lastError ??
        new Error(`[Spellguard] ${agent.name}: fan-out time budget exhausted`)
      );
    }
    try {
      return await sendToAgent(
        channel,
        agent,
        prompt,
        fromAgentId,
        Math.min(FANOUT_PEER_TIMEOUT_MS, remaining),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(msg);
      // Retry only a transient error, and only with meaningful budget left.
      // Backoff is short (the budget is tight) and capped to what remains.
      const budgetLeft = deadline - Date.now();
      if (isTransientError(msg) && attempt < maxRetries && budgetLeft > 3000) {
        const delay = Math.min(attempt * 1500, budgetLeft);
        console.log(
          `[Spellguard] Retrying ${agent.name} after transient error (attempt ${attempt + 1}/${maxRetries}, waiting ${delay / 1000}s): ${msg.substring(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error(`[Spellguard] ${agent.name} send failed`);
}

/**
 * Collect responses from the target agents via the Verifier channel, tolerant
 * of PARTIAL failure: each peer settles independently (bounded concurrency), so
 * one peer's transient failure — a wedged SLIM plane, a timeout, a cold peer —
 * no longer discards another peer's successful reply. EVERY resolved agent is
 * represented in the result: a reply when it answered, or an `unreachable`
 * marker when it failed transiently — so the caller never silently drops a
 * referenced agent (which would let the model fabricate a reply for it).
 *
 * The ONE exception is a genuine policy / rate-limit BLOCK: it is terminal and
 * must never be silently dropped (that would answer from the unguarded path),
 * so it is re-thrown to abort the whole fan-out (fail-fast via
 * `mapWithConcurrency`) and propagate to the caller. Fail-closed
 * ("policy data unavailable") is transient infra, tolerated like any other
 * failure. `mapWithConcurrency` preserves input order, so the responses feed
 * `buildAgentContextBlock` deterministically.
 */
async function collectAgentResponses(
  resolvedAgents: ResolvedAgent[],
  prompt: string,
): Promise<AgentResponse[]> {
  const channel = await getOrCreateChannel();
  const fromAgentId = getConfig()?.agentId || 'unknown';
  // Shared budget for the whole fan-out — each peer send is bounded by the
  // slice that remains, so the turn degrades to a fallback before the 60s
  // proxy timeout instead of surfacing a bare 502 during a SLIM wedge.
  const deadline = Date.now() + FANOUT_BUDGET_MS;

  type Settled =
    | { ok: true; agent: string; response: string }
    | { ok: false; agent: string };

  const settled = await mapWithConcurrency<ResolvedAgent, Settled>(
    resolvedAgents,
    resolveFanoutConcurrency(),
    async (agent) => {
      try {
        const text = await sendToAgentWithRetry(
          channel,
          agent,
          prompt,
          fromAgentId,
          deadline,
        );
        console.log(
          `[Spellguard] Received response from ${agent.name}: ${text.substring(0, 100)}...`,
        );
        return { ok: true, agent: agent.name, response: text };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // A genuine policy/rate-limit block is terminal — rethrow so
        // mapWithConcurrency aborts the fan-out and the caller propagates it
        // (never bypass enforcement). Fail-closed + every transient/infra
        // failure is swallowed so this peer simply drops out of the results.
        if (
          isPolicyOrRateLimitError(msg) &&
          !msg.includes('policy data unavailable')
        ) {
          throw error;
        }
        console.warn(
          `[Spellguard] Peer ${agent.name} dropped from fan-out (transient): ${msg.substring(0, 120)}`,
        );
        return { ok: false, agent: agent.name };
      }
    },
  );

  return settled.map((r) =>
    r.ok
      ? { agent: r.agent, response: r.response }
      : { agent: r.agent, response: '', unreachable: true },
  );
}

/**
 * Full agent-routing pipeline: detect references → filter self → discover
 * agents → collect responses (with retry).
 *
 * Framework-agnostic — used by both the AI SDK `generateText()` wrapper and
 * the LangChain `SpellguardChatModel`.
 *
 * @param prompt      The user prompt to scan for agent references.
 * @param detectFn    Optional custom detection function (defaults to the
 *                    client's `detectAgentReferences`).
 * @returns           One entry per referenced agent — its reply, or an
 *                    `unreachable` marker when it could not be reached. Returns
 *                    `[]` ONLY when the prompt referenced no other agents (so
 *                    the caller runs the plain LLM). Throws on policy/rate-limit.
 */
export async function resolveAndCollectAgentResponses(
  prompt: string,
  detectFn: (prompt: string) => Promise<string[]> = detectAgentReferences,
): Promise<AgentResponse[]> {
  if (!mightContainAgentReference(prompt)) return [];

  const agentRefs = await detectFn(prompt);
  const config = getConfig();
  // Exclude SELF and the immediate inbound SENDER from auto-route targets so
  // a receiver never routes BACK to whoever just messaged it — that would be
  // a 2-node cycle (A→B→A). This keeps the agent-communication graph a DAG.
  // The sender id (lowercased to match detectAgentReferences' normalized
  // output) comes from the receive handler via the hop-context ALS; it's
  // undefined for hop-0 top-level sends and /chat (no inbound), so the
  // sender clause is a no-op there. Deeper cycles (A→B→C→A) are backstopped
  // by the Verifier's MAX_MESSAGE_HOPS.
  const selfId = config?.agentId;
  const senderId = getCurrentSenderId()?.toLowerCase();
  const filteredRefs = agentRefs.filter(
    (ref) =>
      ref !== selfId &&
      (senderId === undefined || ref.toLowerCase() !== senderId),
  );

  if (filteredRefs.length === 0) return [];

  console.log(
    `[Spellguard] Detected agent references: ${filteredRefs.join(', ')}`,
  );

  const resolvedAgents = await discoverAgents(filteredRefs);
  if (resolvedAgents.length === 0) {
    // Referenced agents the directory can't resolve are UNREACHABLE, not "no
    // agents" — surface them so the model reports it couldn't reach them
    // instead of fabricating replies. (A prompt with NO agent references
    // already returned [] above → the plain-LLM path.)
    console.warn(
      `[Spellguard] No agents could be discovered for: ${filteredRefs.join(', ')}`,
    );
    return filteredRefs.map((agent) => ({
      agent,
      response: '',
      unreachable: true,
    }));
  }

  console.log(
    `[Spellguard] Discovered ${resolvedAgents.length} agents: ${resolvedAgents.map((a) => a.name).join(', ')}`,
  );

  try {
    return await collectAgentResponses(resolvedAgents, prompt);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Policy/rate-limit blocks must propagate — never bypass Verifier enforcement.
    // Exception: fail-closed errors (policy data unavailable) are transient
    // infrastructure issues, not actual policy violations — allow fallback.
    const isFailClosed = msg.includes('policy data unavailable');
    if (isPolicyOrRateLimitError(msg) && !isFailClosed) throw error;

    // Non-policy routing failure (the whole fan-out threw before any peer
    // settled — e.g. the channel could not be created). Every referenced agent
    // is unreachable; surface that so the model says so, rather than returning
    // [] (which would let the plain LLM fabricate replies on their behalf).
    // Verifier-mediated audit logging is necessarily skipped for this request.
    console.warn(
      `[Spellguard] Agent routing unavailable, marking peers unreachable: ${msg}`,
    );
    return resolvedAgents.map((a) => ({
      agent: a.name,
      response: '',
      unreachable: true,
    }));
  }
}

/**
 * Drop-in replacement for ai-sdk's generateText.
 * Automatically detects agent references and routes through Verifier.
 */
export async function generateText<T extends GenerateTextOptions>(
  options: T,
): Promise<AnyGenerateTextResult> {
  const prompt = extractPrompt(options);

  const agentResponses = await resolveAndCollectAgentResponses(prompt);
  if (agentResponses.length === 0) {
    return callOriginalGenerateText(options);
  }

  const augmentedSystem = buildAugmentedSystem(options.system, agentResponses);
  console.log('[Spellguard] Processing agent responses with local LLM...');
  return callOriginalGenerateText({ ...options, system: augmentedSystem });
}

/**
 * Extract the prompt text from options.
 */
function extractPrompt(options: GenerateTextOptions): string {
  if (options.prompt) {
    return options.prompt;
  }

  if (options.messages) {
    // Concatenate user messages
    return options.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
  }

  return '';
}

/**
 * Extract text from a potentially nested response structure.
 * Handles structures like { response: { response: "text" } } or { success: true, response: { response: "text" } }
 */
export function extractTextFromResponse(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (typeof response !== 'object' || response === null) {
    return JSON.stringify(response);
  }

  const obj = response as Record<string, unknown>;

  // If there's a 'response' property, recurse into it
  if ('response' in obj) {
    return extractTextFromResponse(obj.response);
  }

  // If there's a 'text' property, use it
  if ('text' in obj && typeof obj.text === 'string') {
    return obj.text;
  }

  // Fallback to JSON
  return JSON.stringify(response);
}

/**
 * Wrap a response in ai-sdk compatible format.
 */
function _wrapResponse(response: unknown): AnyGenerateTextResult {
  const text = extractTextFromResponse(response);

  return {
    text,
    toolCalls: [],
    toolResults: [],
    finishReason: 'stop',
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    rawCall: { rawPrompt: '', rawSettings: {} },
    rawResponse: { headers: {} },
    response: {
      id: `spellguard-${Date.now()}`,
      timestamp: new Date(),
      modelId: 'spellguard-proxy',
    },
    warnings: [],
    request: {},
    providerMetadata: undefined,
    logprobs: undefined,
    steps: [],
    responseMessages: [],
    roundtrips: [],
    reasoning: undefined,
    reasoningDetails: [],
    files: [],
    sources: [],
  } as unknown as AnyGenerateTextResult;
}

/**
 * Drop-in replacement for ai-sdk `tool()` that wraps the execute function
 * with Spellguard tool policy checks.
 *
 * Accepts an extra `name` field (used to identify the tool when calling
 * the Verifier's /v1/tools/check endpoint). The `name` is stripped before
 * delegating to the ai-sdk `tool()`.
 *
 * On input phase: block and redact both prevent execution.
 * On output phase: block prevents returning the result, redact returns null.
 * Flag and allow pass through normally.
 * Fails closed: a check that cannot complete blocks the call, unless
 * `failOpen` is configured (see `checkToolPolicy`, which never throws). There
 * is deliberately no catch here (#1418): one that "continued" ran the tool,
 * or returned its output, with no policy decision.
 */
// biome-ignore lint/suspicious/noExplicitAny: ai-sdk tool() has complex generics
export function spellguardTool(options: any): any {
  const { execute, name, ...rest } = options;
  if (!execute) return tool(rest);

  const toolName: string = name ?? 'unknown';

  return tool({
    ...rest,
    execute: async (args: unknown, toolOpts: unknown) => {
      // Input phase
      const inp: ToolCheckResult = await checkToolPolicy(
        'input',
        toolName,
        args,
      );
      if (inp.effect === 'block') return inp.message ?? '[BLOCKED]';
      if (inp.effect === 'redact') return inp.message ?? '[BLOCKED]';

      const result = await execute(args, toolOpts);

      // Output phase
      const out: ToolCheckResult = await checkToolPolicy(
        'output',
        toolName,
        args,
        result,
      );
      if (out.effect === 'block') return out.message ?? '[BLOCKED]';
      if (out.effect === 'redact') return out.data ?? null;

      return result;
    },
  });
}

export type { ToolCheckResult };

/**
 * Drop-in replacement for ai-sdk's `streamText` (, PRD §6.1).
 *
 * MUST be a NAMED export — it shadows `streamText` flowing through the
 * `export * from 'ai'` wildcard below; without this shadow the wildcard would
 * re-export the raw, uninstrumented function (a silent fail-open coverage hole,
 * §6.2). Unlike `generateText`, a `StreamTextResult`'s `usage` is a Promise that
 * resolves only when the stream FINISHES, so we drain it off the consumer's
 * critical path (`.then`) rather than read a field — never consuming the text
 * stream itself, never blocking, never throwing (fail-open).
 */
export function streamText(
  options: Parameters<typeof originalStreamText>[0],
): ReturnType<typeof originalStreamText> {
  const result = originalStreamText(options);
  try {
    const usagePromise = (result as unknown as { usage?: Promise<unknown> })
      .usage;
    // Handle fulfilment AND rejection in the SAME reaction (onFulfilled,
    // onRejected) so the usage promise is settled directly — a stream that
    // errors must never surface as an unhandled rejection. The trailing .catch
    // absorbs any throw from the emit itself (belt-and-suspenders; the emit is
    // already fail-open).
    void Promise.resolve(usagePromise)
      .then(
        (usage) => {
          reportAiSdkUsage(
            usage as
              | {
                  inputTokens?: number;
                  outputTokens?: number;
                  promptTokens?: number;
                  completionTokens?: number;
                  totalTokens?: number;
                }
              | undefined,
            modelIdOf((options as { model?: unknown })?.model),
          );
        },
        () => undefined,
      )
      .catch(() => undefined);
  } catch {
    /* fail-open — telemetry must never affect the stream */
  }
  return result;
}

// Re-export everything else from ai unchanged. NOTE: the named `generateText`,
// `streamText`, and `tool`/`spellguardTool` exports above intentionally shadow
// the same names coming through this wildcard.
export * from 'ai';
