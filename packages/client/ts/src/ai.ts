// SPDX-License-Identifier: Apache-2.0

import {
  generateText as originalGenerateText,
  streamText as originalStreamText,
  tool,
} from 'ai';
import type { GenerateTextResult, LanguageModel } from 'ai';
import { checkToolPolicy, getConfig, getOrCreateChannel } from './attestation';
import type { ToolCheckResult } from './attestation';
import { discoverAgents } from './discovery';
import { getCurrentHops, getCurrentSenderId } from './hop-context';
import { detectAgentReferences, mightContainAgentReference } from './intent';
import type { ClientChannel, ResolvedAgent } from './types';
import { modelIdOf, reportAiSdkUsage } from './usage-telemetry';

// biome-ignore lint/suspicious/noExplicitAny: ai-sdk types require flexible generics
type AnyGenerateTextResult = GenerateTextResult<any, any>;

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
  maxTokens?: number;
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
 * Format a list of agent responses into a context block string.
 * Shared between the ai-sdk and LangChain integrations.
 */
export function buildAgentContextBlock(
  agentResponses: Array<{ agent: string; response: string }>,
): string {
  const agentContext = agentResponses
    .map(
      (r) =>
        `--- Response from ${r.agent} ---\n${r.response}\n--- End response from ${r.agent} ---`,
    )
    .join('\n\n');

  const instruction =
    "You have received responses from other agents. Use this information along with your own data to provide a comprehensive answer to the user's query.";

  return `${instruction}\n\n${agentContext}`;
}

/**
 * Build the augmented system prompt with agent responses.
 */
function buildAugmentedSystem(
  originalSystem: string | undefined,
  agentResponses: Array<{ agent: string; response: string }>,
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
): Promise<string> {
  if (isSpellguardAgent(agent)) {
    // Bilateral: both agents are Spellguard-attested
    const response = await channel.send(agent.name, {
      type: 'agent-request',
      prompt,
      from: fromAgentId,
      context: { targetAgents: [agent.name] },
      _spellguardHops: getCurrentHops(),
    });
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

/**
 * Collect responses from all target agents via the Verifier channel.
 */
async function collectAgentResponses(
  resolvedAgents: ResolvedAgent[],
  prompt: string,
): Promise<Array<{ agent: string; response: string }>> {
  const channel = await getOrCreateChannel();
  const config = getConfig();
  const responses: Array<{ agent: string; response: string }> = [];

  for (const agent of resolvedAgents) {
    const text = await sendToAgent(
      channel,
      agent,
      prompt,
      config?.agentId || 'unknown',
    );
    responses.push({ agent: agent.name, response: text });
    console.log(
      `[Spellguard] Received response from ${agent.name}: ${text.substring(0, 100)}...`,
    );
  }

  return responses;
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
 * Collect agent responses with retry support for transient errors.
 *
 * Error handling priority:
 * 1. Transient errors (including Verifier fail-closed) → retry up to 3 times.
 * 2. Policy/rate-limit errors → re-thrown immediately (never retry or fallback).
 * 3. All other errors → re-thrown so the caller can decide on fallback.
 *
 * Transient errors are checked BEFORE policy errors because a Verifier fail-closed
 * response ("Blocked: policy data unavailable") is both policy-relevant AND
 * transient — management may respond on the next attempt.
 */
async function collectAgentResponsesWithRetry(
  resolvedAgents: ResolvedAgent[],
  prompt: string,
): Promise<Array<{ agent: string; response: string }>> {
  const maxRetries = 3;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await collectAgentResponses(resolvedAgents, prompt);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(msg);

      // Transient errors (channel expired, fail-closed, delivery failure) get
      // retried — checked first because fail-closed errors are both transient
      // AND policy-relevant, and we want the retry to have a chance.
      const transient = isTransientError(msg);
      if (transient && attempt < maxRetries) {
        const delay = attempt * 5000;
        console.log(
          `[Spellguard] Retrying after transient error (attempt ${attempt + 1}/${maxRetries}, waiting ${delay / 1000}s): ${msg.substring(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Policy/rate-limit errors are terminal — never fallback to direct LLM.
      // Skip this check when the error was already classified as transient
      // (e.g. "Blocked: policy data unavailable (fail-closed)" matches both
      // isTransientError and isPolicyOrRateLimitError). After retries are
      // exhausted the error should propagate as a non-policy failure so the
      // caller can fall back to the direct LLM path.
      if (!transient && isPolicyOrRateLimitError(msg)) throw error;

      // All retries exhausted or unrecognized error — propagate so the
      // caller has full visibility into what went wrong.
      console.error(
        `[Spellguard] Agent routing failed after ${attempt} attempt(s): ${msg}`,
      );
      throw lastError;
    }
  }

  throw lastError || new Error('[Spellguard] Agent routing failed');
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
 * @returns           Collected agent responses, or `[]` when no agents are
 *                    found / all fail. Throws on policy or rate-limit errors.
 */
export async function resolveAndCollectAgentResponses(
  prompt: string,
  detectFn: (prompt: string) => Promise<string[]> = detectAgentReferences,
): Promise<Array<{ agent: string; response: string }>> {
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
    console.warn('[Spellguard] No agents could be discovered');
    return [];
  }

  console.log(
    `[Spellguard] Discovered ${resolvedAgents.length} agents: ${resolvedAgents.map((a) => a.name).join(', ')}`,
  );

  try {
    return await collectAgentResponsesWithRetry(resolvedAgents, prompt);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Policy/rate-limit blocks must propagate — never bypass Verifier enforcement.
    // Exception: fail-closed errors (policy data unavailable) are transient
    // infrastructure issues, not actual policy violations — allow fallback.
    const isFailClosed = msg.includes('policy data unavailable');
    if (isPolicyOrRateLimitError(msg) && !isFailClosed) throw error;

    // Non-policy routing failures: fall back to direct LLM with an explicit
    // warning so the caller (and logs) can see that routing was attempted
    // but failed. This preserves user-facing availability at the cost of
    // skipping Verifier-mediated audit logging for this request.
    console.warn(
      `[Spellguard] Agent routing unavailable, falling back to direct LLM: ${msg}`,
    );
    return [];
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
    experimental_providerMetadata: undefined,
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
 * Fails open on network errors (tool executes normally).
 */
// biome-ignore lint/suspicious/noExplicitAny: ai-sdk tool() has complex generics
export function spellguardTool(options: any): any {
  const { execute, name, ...rest } = options;
  if (!execute) return tool(rest);

  const toolName: string = name ?? 'unknown';

  return tool({
    ...rest,
    execute: async (args: unknown, toolOpts: unknown) => {
      try {
        // Input phase
        const inp: ToolCheckResult = await checkToolPolicy(
          'input',
          toolName,
          args,
        );
        if (inp.effect === 'block') return inp.message ?? '[BLOCKED]';
        if (inp.effect === 'redact') return inp.message ?? '[BLOCKED]';
      } catch (e) {
        // Fail open — let the tool execute normally
        console.warn(`[Spellguard] Tool input check failed, continuing: ${e}`);
      }

      const result = await execute(args, toolOpts);

      try {
        // Output phase
        const out: ToolCheckResult = await checkToolPolicy(
          'output',
          toolName,
          args,
          result,
        );
        if (out.effect === 'block') return out.message ?? '[BLOCKED]';
        if (out.effect === 'redact') return out.data ?? null;
      } catch (e) {
        // Fail open — return the original result
        console.warn(`[Spellguard] Tool output check failed, continuing: ${e}`);
      }

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
    const usagePromise = (result as { usage?: Promise<unknown> }).usage;
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
