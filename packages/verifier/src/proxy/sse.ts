// SPDX-License-Identifier: Apache-2.0

/**
 * SSE plumbing for the LLM gateway's streaming leg (Phase 3a/3b).
 *
 * Three postures, chosen per request by `resolveStreamMode` in `llm-gateway.ts`
 * — see internal design notes for why there is no zero-leak-AND-
 * zero-TTFT option:
 *
 *  • `block-first` (3a, the DEFAULT whenever a blocking policy is bound) —
 *    `consumeSseCompletion` reads the provider stream in full, we evaluate the
 *    assembled completion, then `sseReplayStream` re-emits the provider's own
 *    event bytes VERBATIM (so tool-call deltas, `finish_reason`, usage chunks
 *    and provider-specific fields survive). Zero leak, TTFT = full generation.
 *  • `passthrough` (3b) — no blocking policy is bound, so nothing could ever
 *    withhold; forward events the instant they arrive and evaluate once at the
 *    end so advisory flag/redact policies still record.
 *  • `buffer` (3b, opt-in) — `streamWithPolicy` holds a bounded window behind
 *    the live edge and releases only sentence-complete text that has passed
 *    policy. Leak is bounded by the window; TTFT is near-live.
 *
 * `buffer` SYNTHESIZES content chunks (a provider event can straddle the release
 * boundary, so verbatim replay is impossible there) and therefore never emits
 * tool calls incrementally — they are held and flushed after the final
 * evaluation, which is the design's tool_call buffer-and-scan fallback.
 */

/** Minimal shape of the assembled completion (structurally an OpenAI completion). */
export interface AssembledCompletion {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: unknown };
    finish_reason?: string;
  }>;
  usage?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ConsumedSse {
  /** Provider event payloads, in order, for verbatim replay (no `[DONE]`). */
  rawEvents: string[];
  /** Deltas assembled into a complete, policy-evaluable completion. */
  completion: AssembledCompletion;
  /** True when the provider sent the `[DONE]` sentinel. */
  done: boolean;
}

/** Idle (not wall-clock) read timeout: a long generation is fine, a stalled one is not. */
const DEFAULT_IDLE_MS =
  Number(process.env.SPELLGUARD_LLM_IDLE_TIMEOUT_MS) || 60_000;
/** Hard cap on buffered stream bytes so a runaway response can't exhaust memory. */
const MAX_BUFFER_BYTES =
  Number(process.env.SPELLGUARD_LLM_MAX_STREAM_BYTES) || 8 * 1024 * 1024;

interface ToolCallAcc {
  index: number;
  id?: string;
  type?: string;
  function: { name?: string; arguments: string };
}

/**
 * Read an OpenAI-style SSE body to completion, buffering the raw events and
 * assembling the deltas.
 *
 * Throws on idle timeout (no bytes for `idleMs`) or when the buffered payload
 * exceeds the size cap — both surface to the caller as an upstream failure.
 */
export async function consumeSseCompletion(
  body: ReadableStream<Uint8Array>,
  opts?: { idleMs?: number; maxBytes?: number },
): Promise<ConsumedSse> {
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const maxBytes = opts?.maxBytes ?? MAX_BUFFER_BYTES;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const rawEvents: string[] = [];

  let pending = ''; // incomplete SSE frame carried across reads
  let bytes = 0;
  let done = false;

  // Assembly state
  let content = '';
  const toolCalls = new Map<number, ToolCallAcc>();
  let usage: Record<string, unknown> | undefined;
  let finishReason: string | undefined;
  let id: string | undefined;
  let model: string | undefined;

  const handlePayload = (payload: string): void => {
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    rawEvents.push(payload);
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // non-JSON keep-alive/comment — replayed verbatim, not assembled
    }
    if (typeof chunk.id === 'string') id ??= chunk.id;
    if (typeof chunk.model === 'string') model ??= chunk.model;
    if (chunk.usage && typeof chunk.usage === 'object') {
      usage = chunk.usage as Record<string, unknown>;
    }
    const choice = (
      chunk.choices as Array<Record<string, unknown>> | undefined
    )?.[0];
    if (!choice) return;
    if (typeof choice.finish_reason === 'string')
      finishReason = choice.finish_reason;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) return;
    if (typeof delta.content === 'string') content += delta.content;
    const deltaCalls = delta.tool_calls as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(deltaCalls)) {
      for (const tc of deltaCalls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const acc = toolCalls.get(idx) ?? {
          index: idx,
          function: { arguments: '' },
        };
        if (typeof tc.id === 'string') acc.id = tc.id;
        if (typeof tc.type === 'string') acc.type = tc.type;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn.name === 'string') acc.function.name = fn.name;
          // Arguments stream as PARTIAL JSON fragments — concatenate, never parse
          // incrementally (design §5.3(b): tool_calls degrade to buffer-and-scan).
          if (typeof fn.arguments === 'string')
            acc.function.arguments += fn.arguments;
        }
        toolCalls.set(idx, acc);
      }
    }
  };

  try {
    while (true) {
      const read = await withIdleTimeout(reader.read(), idleMs);
      if (read.done) break;
      bytes += read.value?.byteLength ?? 0;
      if (bytes > maxBytes) {
        throw new Error(`stream exceeded ${maxBytes} bytes`);
      }
      pending += decoder.decode(read.value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep = pending.indexOf('\n\n');
      while (sep !== -1) {
        const frame = pending.slice(0, sep);
        pending = pending.slice(sep + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.startsWith('data:')
            ? line.slice(5).trim()
            : null;
          if (trimmed !== null && trimmed.length > 0) handlePayload(trimmed);
        }
        sep = pending.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  const assembledToolCalls = [...toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .map((t) => ({
      id: t.id,
      type: t.type ?? 'function',
      function: { name: t.function.name, arguments: t.function.arguments },
    }));

  return {
    rawEvents,
    done,
    completion: {
      id,
      model,
      choices: [
        {
          message: {
            content,
            ...(assembledToolCalls.length > 0
              ? { tool_calls: assembledToolCalls }
              : {}),
          },
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage } : {}),
    },
  };
}

/** Reject if the underlying read produces nothing for `idleMs`. */
function withIdleTimeout<T>(p: Promise<T>, idleMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`upstream idle for ${idleMs}ms`)),
      idleMs,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Re-emit buffered provider events as a well-formed SSE stream, terminated with
 * the `[DONE]` sentinel the OpenAI SDKs expect.
 */
export function sseReplayStream(
  rawEvents: string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of rawEvents) {
        controller.enqueue(encoder.encode(`data: ${ev}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/** Headers for an SSE response (no buffering by intermediaries). */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3b — live streaming with policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a streamed completion is policed.
 *
 * - `passthrough` — no BLOCKING inbound policy is bound, so nothing could ever
 *   withhold this response. Emit provider events the instant they arrive (best
 *   possible TTFT, zero added risk) and evaluate once at the end so advisory
 *   flag/redact policies still record their detections.
 * - `buffer` — hold a bounded window behind the live edge, evaluate at sentence
 *   boundaries, and release only text that has passed policy. Leak is bounded by
 *   the window; TTFT is near-live. OPT-IN per policy.
 * - `block-first` — accumulate everything, evaluate, then emit (Phase 3a). Zero
 *   leak, TTFT = full generation. The DEFAULT whenever a blocking policy is
 *   bound and hasn't opted into buffering.
 */
export type StreamMode = 'passthrough' | 'buffer' | 'block-first';

/** Default characters held behind the live edge in `buffer` mode. */
export const DEFAULT_BUFFER_CHARS =
  Number(process.env.SPELLGUARD_LLM_BUFFER_CHARS) || 240;
/**
 * Whole-stream wall-clock ceiling (3c). The idle watchdog catches a *stalled*
 * stream, but a stream that trickles forever would hold `beginDelivery()` open
 * and block the verifier's RSS self-recycle indefinitely (recycle-guard only
 * recycles when no delivery is in flight). This bounds that hold.
 */
const MAX_STREAM_MS =
  Number(process.env.SPELLGUARD_LLM_MAX_STREAM_MS) || 15 * 60_000;

/** Release only on a sentence-ish boundary so we never cut mid-word. */
const BOUNDARY = /[.!?\n](?=\s|$)/g;

/** Evaluate at most this often (chars of new releasable text) to bound CPU. */
const MIN_EVAL_STRIDE = 40;

export interface StreamPolicyVerdict {
  blocked: boolean;
  policyName?: string;
}

export interface StreamWithPolicyOpts {
  upstream: ReadableStream<Uint8Array>;
  mode: Exclude<StreamMode, 'block-first'>;
  /** Evaluate text seen so far. Called with FULL accumulated text (rolling context). */
  evaluate: (text: string) => Promise<StreamPolicyVerdict>;
  /** Invoked once with the assembled completion (metering + audit), even if blocked. */
  onComplete?: (completion: AssembledCompletion, blocked: boolean) => void;
  bufferChars?: number;
  idleMs?: number;
  maxBytes?: number;
  maxDurationMs?: number;
}

/** Find the last release-safe boundary at or before `limit`. */
function lastBoundary(text: string, limit: number): number {
  if (limit <= 0) return 0;
  const slice = text.slice(0, limit);
  BOUNDARY.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null = BOUNDARY.exec(slice);
  while (m !== null) {
    last = m.index + 1;
    m = BOUNDARY.exec(slice);
  }
  return last;
}

function contentChunk(
  id: string | undefined,
  model: string | undefined,
  text: string,
): string {
  return JSON.stringify({
    id: id ?? 'spellguard-stream',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model ?? 'unknown',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
}

/** An OpenAI-shaped mid-stream error frame (what SDKs surface as a stream error). */
export function sseErrorEvent(message: string, code: string): string {
  return JSON.stringify({
    error: { message, type: 'invalid_request_error', code },
  });
}

/**
 * Stream a provider response to the caller while policing it live.
 *
 * `buffer` mode synthesizes CONTENT chunks (it cannot replay events verbatim —
 * a provider event may straddle the release boundary). Tool calls are therefore
 * never emitted incrementally: they are accumulated and flushed only after the
 * final evaluation, which is exactly the design's "tool_call buffer-and-scan"
 * fallback (§5.3(b)) — partial JSON arguments cannot be policed mid-flight.
 */
export function streamWithPolicy(
  opts: StreamWithPolicyOpts,
): ReadableStream<Uint8Array> {
  const {
    upstream,
    mode,
    evaluate,
    onComplete,
    bufferChars = DEFAULT_BUFFER_CHARS,
    idleMs = DEFAULT_IDLE_MS,
    maxBytes = MAX_BUFFER_BYTES,
    maxDurationMs = MAX_STREAM_MS,
  } = opts;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      const startedAt = Date.now();

      let pending = '';
      let bytes = 0;
      let text = '';
      let released = 0;
      let lastEvalAt = 0;
      let blockedBy: string | undefined;
      let id: string | undefined;
      let model: string | undefined;
      let usage: Record<string, unknown> | undefined;
      let finishReason: string | undefined;
      const heldToolCalls: string[] = []; // raw events carrying tool_call deltas

      const emit = (payload: string) =>
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));

      const finish = (): void => {
        emit('[DONE]');
        controller.close();
      };

      try {
        pump: while (true) {
          if (Date.now() - startedAt > maxDurationMs) {
            throw new Error(`stream exceeded ${maxDurationMs}ms`);
          }
          const read = await withIdleTimeout(reader.read(), idleMs);
          if (read.done) break;
          bytes += read.value?.byteLength ?? 0;
          if (bytes > maxBytes)
            throw new Error(`stream exceeded ${maxBytes} bytes`);
          pending += decoder.decode(read.value, { stream: true });

          let sep = pending.indexOf('\n\n');
          while (sep !== -1) {
            const frame = pending.slice(0, sep);
            pending = pending.slice(sep + 2);
            sep = pending.indexOf('\n\n');

            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload.length === 0 || payload === '[DONE]') continue;

              let parsed: Record<string, unknown> | null = null;
              try {
                parsed = JSON.parse(payload);
              } catch {
                /* keep-alive */
              }

              if (mode === 'passthrough') {
                // Nothing can withhold — forward the provider's own bytes now.
                emit(payload);
              }

              if (!parsed) continue;
              if (typeof parsed.id === 'string') id ??= parsed.id;
              if (typeof parsed.model === 'string') model ??= parsed.model;
              if (parsed.usage && typeof parsed.usage === 'object') {
                usage = parsed.usage as Record<string, unknown>;
              }
              const choice = (
                parsed.choices as Array<Record<string, unknown>> | undefined
              )?.[0];
              if (!choice) continue;
              if (typeof choice.finish_reason === 'string') {
                finishReason = choice.finish_reason;
              }
              const delta = choice.delta as Record<string, unknown> | undefined;
              if (!delta) continue;
              if (typeof delta.content === 'string') text += delta.content;
              if (Array.isArray(delta.tool_calls) && mode === 'buffer') {
                // Buffer-and-scan: never released until the final evaluation.
                heldToolCalls.push(payload);
              }
            }

            if (mode !== 'buffer') continue;

            // Release everything that is (a) behind the buffer window and
            // (b) on a sentence boundary — after policy has cleared it.
            const safeEnd = Math.max(0, text.length - bufferChars);
            const boundary = lastBoundary(text, safeEnd);
            if (
              boundary > released &&
              boundary - lastEvalAt >= MIN_EVAL_STRIDE
            ) {
              lastEvalAt = boundary;
              const verdict = await evaluate(text.slice(0, boundary));
              if (verdict.blocked) {
                blockedBy = verdict.policyName ?? 'spellguard';
                break pump;
              }
              emit(contentChunk(id, model, text.slice(released, boundary)));
              released = boundary;
            }
          }
        }

        // Final evaluation over everything, including any held tool calls.
        if (!blockedBy) {
          const verdict = await evaluate(text);
          if (verdict.blocked) blockedBy = verdict.policyName ?? 'spellguard';
        }

        if (blockedBy) {
          // Mid-stream block. Status is already 200, so the only channel left is
          // an error FRAME — SDKs surface it as a stream error.
          emit(
            sseErrorEvent(
              `Response blocked by policy: ${blockedBy}`,
              'spellguard_policy_block',
            ),
          );
        } else if (mode === 'buffer') {
          if (released < text.length) {
            emit(contentChunk(id, model, text.slice(released)));
          }
          for (const tc of heldToolCalls) emit(tc); // buffer-and-scan flush
          emit(
            JSON.stringify({
              id: id ?? 'spellguard-stream',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model ?? 'unknown',
              choices: [
                { index: 0, delta: {}, finish_reason: finishReason ?? 'stop' },
              ],
              ...(usage ? { usage } : {}),
            }),
          );
        }

        onComplete?.(
          {
            id,
            model,
            choices: [
              { message: { content: text }, finish_reason: finishReason },
            ],
            ...(usage ? { usage } : {}),
          },
          !!blockedBy,
        );
        finish();
      } catch (err) {
        // Bytes may already be on the wire, so the only honest signal is an
        // error frame followed by a clean close.
        emit(
          sseErrorEvent(
            `Stream failed: ${err instanceof Error ? err.message : 'unknown'}`,
            'spellguard_stream_error',
          ),
        );
        onComplete?.(
          {
            id,
            model,
            choices: [{ message: { content: text } }],
            ...(usage ? { usage } : {}),
          },
          false,
        );
        finish();
      } finally {
        reader.releaseLock();
        await upstream.cancel().catch(() => {});
      }
    },
  });
}
