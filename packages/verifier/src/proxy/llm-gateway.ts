// SPDX-License-Identifier: Apache-2.0

/**
 * LLM gateway — the third mediation leg.
 *
 * An OpenAI-compatible `POST /v1/chat/completions` that puts the Verifier on the
 * hot path of model inference. It runs request policy (the prompt, as an
 * OUTBOUND check) BEFORE forwarding upstream, relays the caller's own per-agent
 * key verbatim to the provider, then runs response policy (the completion, as an
 * INBOUND check) and WITHHOLDS the completion on a deny.
 *
 * Policies are selected by `filterByScope(bindings, 'llm')`, which applies ONE
 * uniform rule to every leg: a binding governs this leg when it is scoped
 * `'llm'`, scoped `'all'`, **or unscoped** (unscoped ≡ `'all'`). An
 * `'all'`/unscoped binding therefore DOES govern model calls. That is
 * deliberate — #470 rejected the opposite ("all" meaning "all except llm")
 * because it made the word lie, made an org-wide binding silently govern
 * nothing on inference, and made a per-agent `'llm'` binding unexpressible for
 * a policy already bound org-wide. The cost is that enabling the gateway
 * extends every existing unscoped binding onto inference, which is how outage
 * #478 happened; the guards against a repeat are explicit catalog scoping
 * (`tests/policy-catalog/tool-policy-scope-guard.test.ts`) and the operator
 * warning `warnImplicitLlmCoverage` emits here. See
 * internal design notes.
 *
 * Both request modes hand the inbound check a COMPLETE completion:
 *   • non-streaming — coerced to `stream:false`, read as JSON.
 *   • `stream:true` (Phase 3a) — the provider streams, we consume the SSE in
 *     full, evaluate, then replay the provider's own events verbatim. The caller
 *     gets real SSE framing (stock SDKs work) with ZERO token leak; the cost is
 *     TTFT. Streaming also uses an IDLE read watchdog instead of the wall-clock
 *     abort, so a long generation completes while a stalled one still fails.
 *
 * Phase 3b adds the delay-buffer mode (bounded leak, real TTFT) and in-stream
 * abort/redact — see internal design notes.
 */

import type { AuditCommitment } from '@spellguard/amp';
import type { Context } from 'hono';

import { hashPayload } from '../crypto/commitment';
import { getAgentPolicies } from '../management/policy-cache';
import { reportBilateralEvent } from '../management/reporter';
import { getSpendGate } from '../management/spend-gate-cache';
import {
  enqueueGatewayUsage,
  recordCompletionSeen,
} from '../management/usage-reporter';
import {
  type IdentityVerdict,
  noteMissingSecret,
  verifyAgentIdentity,
} from '../management/verify-agent-cache';
import { beginDelivery, endDelivery } from '../recycle-guard';
import {
  handleQuarantine,
  resolveResponseLevel,
  shouldQuarantineFromChecks,
} from './effect-handlers';
import { warnImplicitLlmCoverage } from './llm-scope-coverage';
import { evaluatePolicies, filterByScope } from './policy-evaluator';
import type { PolicyCheckResult } from './policy-evaluator';
import type { ResolvedPolicyBinding } from './policy-evaluator-types';
import {
  buildQuarantineReason,
  evaluateResponseDisposition,
} from './policy-helpers';
import { generateMessageId } from './router';
import {
  DEFAULT_BUFFER_CHARS,
  SSE_HEADERS,
  type StreamMode,
  consumeSseCompletion,
  sseReplayStream,
  streamWithPolicy,
} from './sse';

const UPSTREAM_BASE_URL =
  process.env.SPELLGUARD_LLM_UPSTREAM_BASE_URL ??
  'https://openrouter.ai/api/v1';
const FORWARD_TIMEOUT_MS =
  Number(process.env.SPELLGUARD_LLM_FORWARD_TIMEOUT_MS) || 120_000;

interface OpenAiChatMessage {
  role?: string;
  content?: unknown;
}
interface OpenAiChatRequest {
  model?: string;
  messages?: OpenAiChatMessage[];
  tools?: unknown;
  stream?: boolean;
  [k: string]: unknown;
}
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** OpenRouter-authoritative USD (present when the request opts in). */
  cost?: number;
  cost_details?: unknown;
  // NOTE: at runtime OpenRouter/providers send `null` (not just absent) for
  // these sub-fields — the TS `?` is erased, so treat them as number | null.
  prompt_tokens_details?: { cached_tokens?: number | null };
  completion_tokens_details?: { reasoning_tokens?: number | null };
  [k: string]: unknown;
}
interface OpenAiChatCompletion {
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  usage?: OpenAiUsage;
  [k: string]: unknown;
}

/**
 * Coerce a provider token count into a REQUIRED non-negative integer (default 0).
 * Guards the usage-ingest contract: providers return `null` / floats for token
 * fields, which the management route's `z.number().int().nonnegative()` rejects
 * with a 422 (silently re-queuing every flush — caught live on staging
 * 2026-07-19 via /internal/llm-usage-stats).
 */
export const reqCount = (x: unknown): number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0;

/**
 * Coerce an OPTIONAL provider token count: a non-negative integer, or `undefined`
 * when absent/null/invalid. NEVER `null` — the route field is `.optional()`
 * (accepts undefined or int, NOT null), and JSON.stringify keeps null but drops
 * undefined.
 */
export const optCount = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0
    ? Math.trunc(x)
    : undefined;

/** Effects that can WITHHOLD a completion (i.e. that make leak matter). */
const BLOCKING_EFFECTS = new Set(['block', 'quarantine', 'rate_limit']);

/**
 * Choose how a streamed completion is policed (Phase 3b).
 *
 * Safety rule: **zero-leak is the default; live streaming is opt-in.**
 *
 * The opt-in is a single **per-agent** switch (`agents.streaming_posture =
 * 'live'`), not a per-policy flag. Per-policy opt-in was the original design
 * (§5.3) but proved unreachable in practice: a real org carries ~9 blocking
 * org-wide bindings, every one would have to opt in, and a single hold-out
 * reverted the whole agent to zero-leak — so the fast path could never turn on.
 * Whether to accept a bounded leak for latency is an agent-level product
 * judgement anyway. A per-binding `config.streaming:'buffer'` is still honoured
 * as a narrower override for callers that want it.
 *
 * - No blocking inbound binding → `passthrough`. Nothing could ever withhold
 *   this response, so holding tokens back would buy nothing; stream live and
 *   evaluate at the end so advisory flag/redact policies still record.
 * - `tools` present with a blocking binding → `block-first`. Tool-call
 *   arguments stream as PARTIAL JSON and cannot be policed incrementally
 *   (§5.3(b)), so the honest fallback is buffer-and-scan the whole response.
 * - Agent posture `'live'` (or every blocking binding opting in) → `buffer`.
 * - Otherwise → `block-first`.
 */
export function resolveStreamMode(
  inbound: ResolvedPolicyBinding[],
  opts?: { hasTools?: boolean; posture?: string },
): { mode: StreamMode; bufferChars: number } {
  const blocking = inbound.filter((b) => BLOCKING_EFFECTS.has(b.effect));
  if (blocking.length === 0) {
    return { mode: 'passthrough', bufferChars: 0 };
  }
  // Tool calls can't be policed mid-flight, so they beat even an explicit
  // 'live' posture — the agent opted into a bounded leak, not into unpoliced
  // tool arguments.
  if (opts?.hasTools) return { mode: 'block-first', bufferChars: 0 };

  const windows: number[] = [];
  let everyBindingOptedIn = true;
  for (const b of blocking) {
    const cfg = (b.config ?? {}) as Record<string, unknown>;
    if (cfg.streaming !== 'buffer') {
      everyBindingOptedIn = false;
      continue;
    }
    const n = Number(cfg.bufferChars);
    windows.push(Number.isFinite(n) && n > 0 ? n : DEFAULT_BUFFER_CHARS);
  }

  if (opts?.posture === 'live' || everyBindingOptedIn) {
    return {
      mode: 'buffer',
      bufferChars:
        windows.length > 0 ? Math.max(...windows) : DEFAULT_BUFFER_CHARS,
    };
  }
  return { mode: 'block-first', bufferChars: 0 };
}

/** LLM-gateway identity-binding mode. `off` when unmanaged (local/OSS). */
export type IdentityMode = 'off' | 'observe' | 'enforce';

/**
 * Resolve the identity-binding mode. Disabled (`off`) when `MANAGEMENT_URL` is
 * unset (ungoverned local/OSS, matching the policy/spend passthrough). Otherwise
 * the DEFAULT is `enforce` (reject anything but a valid pair) — a managed gateway
 * is secure-by-default. `SPELLGUARD_LLM_IDENTITY_MODE` can select `observe`
 * (verify + count, never reject) for the initial rollout of a NEW caller class,
 * or `off`; remove the override once the caller reliably sends a valid secret.
 */
export function resolveIdentityMode(): IdentityMode {
  if (!process.env.MANAGEMENT_URL) return 'off';
  const m = process.env.SPELLGUARD_LLM_IDENTITY_MODE;
  if (m === 'observe') return 'observe';
  if (m === 'off') return 'off';
  return 'enforce'; // secure-by-default
}

/**
 * Pure decision: given the mode + verdict, should the gateway reject and with
 * what status? Only `enforce` rejects; `unreachable` (management error /
 * rate-limited) is a DENY — identity binding FAILS CLOSED.
 */
export function identityDecision(
  mode: IdentityMode,
  verdict: IdentityVerdict,
): { reject: boolean; status: 401 | 403; reason: string } {
  const deny =
    verdict === 'missing'
      ? { status: 401 as const, reason: 'Missing X-Spellguard-Agent-Secret' }
      : verdict === 'invalid'
        ? {
            status: 403 as const,
            reason: 'Agent secret does not match X-Spellguard-Agent-Id',
          }
        : {
            status: 403 as const,
            reason: 'Agent identity could not be verified',
          };
  return { reject: mode === 'enforce' && verdict !== 'valid', ...deny };
}

/**
 * Check the agent-secret binding (`X-Spellguard-Agent-Id` plus
 * `X-Spellguard-Agent-Secret`) for one request. Returns the rejection to
 * answer with when the caller fails it in enforce mode, or null to proceed.
 * In observe mode it verifies + counts but never rejects (safe rollout);
 * `off` (unmanaged) skips. Shared by every route that takes an agent secret,
 * so the binding is checked one way; each route words its own error body.
 */
export async function checkAgentSecret(
  c: Context,
  agentId: string,
  mode: IdentityMode,
  logTag: string,
): Promise<{ status: 401 | 403; reason: string } | null> {
  if (mode === 'off') return null;
  const secret = c.req.header('X-Spellguard-Agent-Secret');
  let verdict: IdentityVerdict;
  if (!secret) {
    noteMissingSecret();
    verdict = 'missing';
  } else {
    verdict = await verifyAgentIdentity(agentId, secret);
  }
  if (verdict !== 'valid') {
    console.warn(
      `[${logTag}] identity ${verdict} for agent ${agentId} (mode=${mode})`,
    );
  }
  const decision = identityDecision(mode, verdict);
  return decision.reject
    ? { status: decision.status, reason: decision.reason }
    : null;
}

/** The gateway's identity check, answered in the OpenAI error shape. */
async function enforceIdentity(
  c: Context,
  agentId: string,
): Promise<Response | null> {
  const rejection = await checkAgentSecret(
    c,
    agentId,
    resolveIdentityMode(),
    'llm-gateway',
  );
  if (!rejection) return null;
  return c.json(
    openAiError(rejection.reason, 'authentication_error'),
    rejection.status,
  );
}

/**
 * Flatten an OpenAI chat request into ONE string for the regex/keyword engines.
 * Multimodal `content` arrays and tool schemas are JSON-stringified so injection
 * / exfiltration payloads hidden in structured parts are still seen.
 *
 * IMPORTANT: deliberately NO `role:` prefix. Prefixing each message with
 * `user:` / `system:` / `assistant:` makes EVERY prompt look like a chat-format
 * (role-marker) injection to the injection engine — a real detector on the 'llm'
 * leg — which then false-positives on all traffic (caught live on staging
 * 2026-07-16). The raw content is what the content-based engines
 * (injection / secrets / toxicity) need; role markers that appear inside the
 * ACTUAL message content are still (correctly) flagged as injection.
 */
export function synthesizePromptContent(body: OpenAiChatRequest): string {
  const parts: string[] = [];
  for (const m of body.messages ?? []) {
    const content =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (content) parts.push(content);
  }
  if (body.tools !== undefined) {
    parts.push(JSON.stringify(body.tools));
  }
  return parts.join('\n');
}

/**
 * Flatten an OpenAI completion into ONE string. The assistant text AND the
 * `tool_calls` arguments (where exfiltration hides) are both included.
 *
 * Typed on the shape it actually reads rather than on `OpenAiChatCompletion`,
 * so the SSE reassembler's `AssembledCompletion` (same `choices[].message`,
 * looser `usage`) can be flattened by the streaming leg too.
 */
export function synthesizeCompletionContent(completion: {
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
}): string {
  const message = completion.choices?.[0]?.message;
  if (!message) return '';
  const parts: string[] = [];
  if (typeof message.content === 'string') parts.push(message.content);
  else if (message.content != null) parts.push(JSON.stringify(message.content));
  if (message.tool_calls !== undefined) {
    parts.push(JSON.stringify(modelToolCalls(message.tool_calls)));
  }
  return parts.join('\n');
}

/**
 * The tool calls as the model made them: each call without the provider's
 * own bookkeeping, its `id` and its `index`, which the model does not write.
 * Everything else stays, the name and the arguments included. A Gemini call
 * id is `function-call-` and 18 or 19 digits, and one in ten of those passes
 * the credit-card check: pii-detection refused about 2% of the demo fleet's
 * completions for it (#1866).
 */
function modelToolCalls(toolCalls: unknown): unknown {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map((call) => {
    if (call === null || typeof call !== 'object' || Array.isArray(call)) {
      return call;
    }
    const { id: _id, index: _index, ...made } = call as Record<string, unknown>;
    return made;
  });
}

/**
 * The gateway's single binding-selection chokepoint: warn about the bindings
 * that reach this leg only by being `'all'`/unscoped, then narrow to the leg.
 * Routing every `'llm'` selection through here is what keeps the warning from
 * drifting away from the filter it describes. Evaluation defaults, including
 * the omitted failBehavior default, belong to the shared evaluator.
 */
function selectLlmBindings(
  agentId: string,
  direction: 'inbound' | 'outbound',
  bindings: ResolvedPolicyBinding[],
): ResolvedPolicyBinding[] {
  warnImplicitLlmCoverage(agentId, direction, bindings);
  return filterByScope(bindings, 'llm');
}

function openAiError(
  message: string,
  type: string,
  code?: string,
): { error: { message: string; type: string; code?: string } } {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

/**
 * Build the audit commitment for one gateway leg.
 *
 * `content` is the flattened prompt (request leg) or completion (response leg)
 * — the SAME string handed to `evaluatePolicies` — and the hash is a real
 * SHA-256 of it, so anyone holding the message can verify the row. Two reasons
 * it must be the content and not a label:
 *
 *  - Management stores `message_hash` as BYTEA via `Buffer.from(hash, 'hex')`,
 *    and Node's hex decoder silently yields an EMPTY buffer for a non-hex
 *    string. The old `llm_req_<id>` literal wrote a zero-length hash on every
 *    gateway audit row (product-findings audit #544 §12b).
 *  - A digest over the leg name and a fresh message id would fix that symptom
 *    while committing to nothing — and a hex-shaped non-commitment is WORSE
 *    than a visible label, because nothing downstream can tell it apart from a
 *    real one. The sibling commitments in `app.ts` hash their content; so does
 *    this one.
 *
 * `/v1/content/evaluate` builds its commitments here too, and passes the
 * caller's request id as `correlationId` so the request and response legs of
 * one HTTP exchange share it.
 */
export function makeCommitment(
  agentId: string,
  content: string,
  correlationId?: string,
): AuditCommitment {
  return {
    messageId: generateMessageId(),
    hash: hashPayload(content),
    sender: agentId,
    recipient: agentId,
    timestamp: Date.now(),
    attestationLevel: 'bilateral',
    ...(correlationId ? { correlationId } : {}),
  };
}

/**
 * `POST /v1/chat/completions` — the LLM-gateway handler.
 */
export async function handleLlmChatCompletions(c: Context): Promise<Response> {
  // 1. Identity (v1): a first-party header injected by the managed fleet SDK.
  //    NOTE the verifier ALB is PUBLIC on :443, so this header is TRUSTED, not
  //    verified — a caller could present another agent's id to have that agent's
  //    policies applied (bounded: they forward their own key and could bypass the
  //    gateway entirely). Binding the id to the presented key / a channel token
  //    is Phase-2 hardening.
  const agentId = c.req.header('X-Spellguard-Agent-Id');
  if (!agentId) {
    return c.json(
      openAiError('Missing X-Spellguard-Agent-Id', 'authentication_error'),
      401,
    );
  }

  // 1b. BIND the id to a credential. The header above is trusted-not-verified on
  //     a PUBLIC ALB, so verify a companion X-Spellguard-Agent-Secret against the
  //     control plane BEFORE loading this agent's policies (enforce = fail-closed
  //     reject; observe = verify + count, never reject).
  const identityReject = await enforceIdentity(c, agentId);
  if (identityReject) return identityReject;

  let reqBody: OpenAiChatRequest;
  try {
    reqBody = await c.req.json();
  } catch {
    return c.json(
      openAiError('Invalid JSON body', 'invalid_request_error'),
      400,
    );
  }

  // 2. Load policies. Fail-closed only when management is configured; pass
  //    through (ungoverned) for local/OSS where MANAGEMENT_URL is unset.
  const cfg = await getAgentPolicies(agentId);
  if (!cfg && process.env.MANAGEMENT_URL) {
    return c.json(openAiError('Policy data unavailable', 'server_error'), 503);
  }

  // Guard the in-flight window so the RSS self-recycle never kills a live
  // (up to 30-120s) generation mid-flight.
  beginDelivery();
  try {
    // 3. PRE-FLIGHT — the prompt leaving the agent is an OUTBOUND check on the
    //    'llm' leg. Denies BEFORE any upstream call, so nothing leaks.
    const promptContent = synthesizePromptContent(reqBody);
    const outboundChecks: PolicyCheckResult[] = cfg
      ? await evaluatePolicies(
          selectLlmBindings(agentId, 'outbound', cfg.outbound),
          promptContent,
          {
            agentId,
            direction: 'outbound',
            agentStatus: cfg.agentStatus,
            identity: cfg.identityContext,
          },
        )
      : [];
    const outLevel = resolveResponseLevel(
      outboundChecks.map((x) => x.responseLevel),
    );
    reportBilateralEvent(
      makeCommitment(agentId, promptContent),
      outLevel,
      outboundChecks,
      'outbound',
      agentId,
      'llm-completion',
      { model: reqBody.model },
    );
    if (shouldQuarantineFromChecks(outboundChecks)) {
      await handleQuarantine(
        agentId,
        buildQuarantineReason(outboundChecks) ||
          'LLM prompt triggered quarantine',
      );
    }
    const outDeny = outboundChecks.find((x) => x.decision === 'deny');
    if (outDeny) {
      // Forward NOTHING upstream. rate_limit → 429, block/quarantine → 403.
      return c.json(
        openAiError(
          `Blocked by policy: ${outDeny.policyName}`,
          'invalid_request_error',
          'spellguard_policy_block',
        ),
        outLevel === 'rate_limit' ? 429 : 403,
      );
    }

    // 3b. SPEND GATE — hard 402 before any upstream call when the agent is over
    //     a hard-enforced dollar budget. Only when management is configured
    //     (matches the ungoverned-passthrough posture above); fails open on a
    //     management error (see spend-gate-cache).
    if (process.env.MANAGEMENT_URL) {
      const gate = await getSpendGate(agentId);
      if (gate?.over) {
        return c.json(
          openAiError(
            `Spend limit exceeded${gate.window ? ` for the ${gate.window} window` : ''}`,
            'insufficient_quota',
            'spellguard_spend_limit',
          ),
          402,
        );
      }
    }

    // 4. FORWARD UPSTREAM — relay the caller's per-agent (spend-capped) key
    //    verbatim; never log or persist it.
    //
    //    Two modes, both of which hand the inbound check a COMPLETE completion:
    //    • non-streaming (default): coerce `stream:false` and read the JSON.
    //    • streaming (`stream:true`, Phase 3a): ask the provider to stream, then
    //      consume the SSE in full and assemble it. The caller still gets real
    //      SSE framing (so stock SDKs work) but ZERO tokens leak before policy
    //      runs. Streaming also gets an IDLE-based read timeout instead of the
    //      wall-clock one, so a long generation completes as long as tokens keep
    //      arriving (design §7 Phase 3 acceptance bar). Phase 3b adds the
    //      delay-buffer mode that trades a bounded leak for real TTFT.
    const wantsStream = reqBody.stream === true;
    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: c.req.header('authorization') ?? '',
        },
        body: JSON.stringify({
          ...reqBody,
          stream: wantsStream,
          // Ask OpenRouter to return authoritative usage.cost on the completion.
          // `stream_options.include_usage` is the OpenAI-compatible spelling that
          // makes the provider emit a final usage-bearing chunk when streaming —
          // without it a streamed call would meter as 0 tokens.
          usage: { include: true },
          ...(wantsStream ? { stream_options: { include_usage: true } } : {}),
        }),
        // Streaming uses a per-read idle watchdog inside consumeSseCompletion;
        // a wall-clock abort here would kill a healthy long generation.
        signal: wantsStream
          ? undefined
          : AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
    } catch (err) {
      return c.json(
        openAiError(
          `Upstream request failed: ${err instanceof Error ? err.message : 'unknown'}`,
          'server_error',
        ),
        502,
      );
    }
    if (!upstream.ok) {
      // Relay the provider's error status + body verbatim (the SDK expects it).
      const errText = await upstream.text();
      return new Response(errText, {
        status: upstream.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    let completion: OpenAiChatCompletion;
    let replayEvents: string[] | null = null;
    if (wantsStream) {
      if (!upstream.body) {
        return c.json(
          openAiError('Upstream returned no stream body', 'server_error'),
          502,
        );
      }

      // 4b. LIVE STREAMING (Phase 3b). `passthrough` when nothing could withhold,
      //     `buffer` when every blocking policy opted in. Both return while bytes
      //     are still flowing, so metering + the inbound audit event move into
      //     onComplete, and the delivery guard is held until the stream ends.
      const inboundBindings: ResolvedPolicyBinding[] = cfg
        ? selectLlmBindings(agentId, 'inbound', cfg.inbound)
        : [];
      const { mode, bufferChars } = resolveStreamMode(inboundBindings, {
        hasTools: reqBody.tools !== undefined,
        posture: cfg?.streamingPosture,
      });

      if (mode !== 'block-first') {
        let lastChecks: PolicyCheckResult[] = [];
        // The handler's own `finally` decrements once on return; take a second
        // reference so the recycle guard still counts this delivery as in-flight
        // while the stream drains (3c — otherwise the verifier could self-recycle
        // mid-stream).
        beginDelivery();
        let released = false;
        const releaseDelivery = (): void => {
          if (!released) {
            released = true;
            endDelivery();
          }
        };

        const body = streamWithPolicy({
          upstream: upstream.body,
          mode,
          bufferChars,
          evaluate: async (text: string) => {
            if (inboundBindings.length === 0) return { blocked: false };
            lastChecks = await evaluatePolicies(inboundBindings, text, {
              agentId,
              direction: 'inbound',
              agentStatus: cfg?.agentStatus,
              identity: cfg?.identityContext,
            });
            const d = evaluateResponseDisposition([], lastChecks);
            return { blocked: d.blocked, policyName: d.policyName };
          },
          onComplete: (assembled, blocked) => {
            try {
              const u = assembled.usage as OpenAiUsage | undefined;
              recordCompletionSeen(!!u);
              if (u) {
                enqueueGatewayUsage(agentId, {
                  model: reqBody.model ?? 'unknown',
                  promptTokens: reqCount(u.prompt_tokens),
                  completionTokens: reqCount(u.completion_tokens),
                  cachedInputTokens: optCount(
                    u.prompt_tokens_details?.cached_tokens,
                  ),
                  reasoningTokens: optCount(
                    u.completion_tokens_details?.reasoning_tokens,
                  ),
                  totalTokens: reqCount(u.total_tokens),
                  costUsd: typeof u.cost === 'number' ? u.cost : null,
                });
              }
              reportBilateralEvent(
                // The commitment covers the completion the caller actually
                // received. In `buffer` mode the policy check saw only the
                // delayed prefix, so the committed content is a superset of
                // the evaluated content — the row proves what was delivered.
                makeCommitment(agentId, synthesizeCompletionContent(assembled)),
                resolveResponseLevel(lastChecks.map((x) => x.responseLevel)),
                lastChecks,
                'inbound',
                agentId,
                'llm-completion',
                { model: reqBody.model, streamMode: mode, blocked },
              );
              if (shouldQuarantineFromChecks(lastChecks)) {
                void handleQuarantine(
                  agentId,
                  buildQuarantineReason(lastChecks) ||
                    'LLM completion triggered quarantine',
                ).catch(() => {});
              }
            } finally {
              releaseDelivery();
            }
          },
        });
        return new Response(body, { status: 200, headers: SSE_HEADERS });
      }

      try {
        const consumed = await consumeSseCompletion(upstream.body);
        completion = consumed.completion as OpenAiChatCompletion;
        replayEvents = consumed.rawEvents;
      } catch (err) {
        // Idle timeout / oversize / malformed stream — nothing has been sent to
        // the caller yet, so a clean error response is still possible.
        return c.json(
          openAiError(
            `Upstream stream failed: ${err instanceof Error ? err.message : 'unknown'}`,
            'server_error',
          ),
          502,
        );
      }
    } else {
      completion = (await upstream.json()) as OpenAiChatCompletion;
    }

    // Meter this call (fire-and-forget): the provider's authoritative token
    // counts + cost. Emitted on the success path REGARDLESS of the inbound
    // withhold below — the tokens were really billed.
    const usage = completion.usage;
    recordCompletionSeen(!!usage);
    if (usage) {
      enqueueGatewayUsage(agentId, {
        model: reqBody.model ?? 'unknown',
        promptTokens: reqCount(usage.prompt_tokens),
        completionTokens: reqCount(usage.completion_tokens),
        cachedInputTokens: optCount(usage.prompt_tokens_details?.cached_tokens),
        reasoningTokens: optCount(
          usage.completion_tokens_details?.reasoning_tokens,
        ),
        totalTokens: reqCount(usage.total_tokens),
        costUsd: typeof usage.cost === 'number' ? usage.cost : null,
      });
    }

    // 5. POST-FLIGHT — the completion returning to the agent is an INBOUND
    //    check on the 'llm' leg.
    const completionContent = synthesizeCompletionContent(completion);
    const inboundChecks: PolicyCheckResult[] = cfg
      ? await evaluatePolicies(
          selectLlmBindings(agentId, 'inbound', cfg.inbound),
          completionContent,
          {
            agentId,
            direction: 'inbound',
            agentStatus: cfg.agentStatus,
            identity: cfg.identityContext,
          },
        )
      : [];
    reportBilateralEvent(
      makeCommitment(agentId, completionContent),
      resolveResponseLevel(inboundChecks.map((x) => x.responseLevel)),
      inboundChecks,
      'inbound',
      agentId,
      'llm-completion',
      { model: reqBody.model },
    );
    if (shouldQuarantineFromChecks(inboundChecks)) {
      await handleQuarantine(
        agentId,
        buildQuarantineReason(inboundChecks) ||
          'LLM completion triggered quarantine',
      );
    }

    // 6. WITHHOLD the completion on a deny (PR #434 primitive). A self-directed
    //    model call has no recipient-outbound peer, so pass [].
    const disposition = evaluateResponseDisposition([], inboundChecks);
    if (disposition.blocked) {
      return c.json(
        openAiError(
          `Response blocked by policy: ${disposition.policyName ?? 'spellguard'}`,
          'invalid_request_error',
          'spellguard_policy_block',
        ),
        disposition.responseLevel === 'rate_limit' ? 429 : 403,
      );
    }

    // redact/flag do NOT withhold; v1 treats them as log-only pass-through
    // (span-rewriting the structured completion body is Phase 3b).

    // Streaming: the completion passed policy, so replay the provider's own
    // buffered events VERBATIM. Re-serializing our assembled view would drop
    // provider-specific fields and flatten tool-call deltas, so we emit the
    // original bytes and let the SDK reassemble exactly as it would have.
    if (replayEvents) {
      return new Response(sseReplayStream(replayEvents), {
        status: 200,
        headers: SSE_HEADERS,
      });
    }

    // If the caller didn't ask for usage, strip the OpenRouter cost accounting
    // we injected so the wire response is unchanged for them (JSON.stringify
    // omits undefined). The standard token `usage` object stays.
    if (reqBody.usage === undefined && completion.usage) {
      completion.usage.cost = undefined;
      completion.usage.cost_details = undefined;
    }
    return c.json(completion);
  } finally {
    endDelivery();
  }
}
