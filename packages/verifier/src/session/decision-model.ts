// SPDX-License-Identifier: Apache-2.0

/**
 * The decision-model client: ask a model a set of typed questions about a
 * state and get calibrated answers back.
 *
 * The question shapes follow Cloudflare's Clef decision models
 * (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`), which the Cloudflare
 * Verifier calls through Workers AI. The transport is behind this interface
 * so another provider can be added without touching the engine that asks.
 *
 * A runtime without a client passes none, and `semantic-consistency` and
 * `agent-conduct` act on their binding's `failBehavior`.
 *
 * Design of record: internal design notes.
 */

import { DECISION_MODEL_IDS, type DecisionModelId } from '@spellguard/amp';

// The decision-model registry is the shared policy registry's
// (`@spellguard/amp` policy-types.ts `DECISION_MODELS`): one list for the
// Verifier, the policy creation schema and the dashboard. Each entry names
// its provider and the provider's model name (`modelRef`); a client serves
// the entries of its provider. Adding a provider is one registry entry and
// one `DecisionModelClient`, picked by `provider`.
export {
  AGENT_CONDUCT_MODEL_IDS,
  DECISION_MODEL_IDS,
  DECISION_MODELS,
  DEFAULT_DECISION_MODEL_ID,
  decisionModelIdsFor,
  getDecisionModel,
} from '@spellguard/amp';
export type {
  DecisionModel,
  DecisionModelId,
  DecisionModelProvider,
} from '@spellguard/amp';

export function isDecisionModelId(value: unknown): value is DecisionModelId {
  return (
    typeof value === 'string' &&
    (DECISION_MODEL_IDS as readonly string[]).includes(value)
  );
}

/**
 * One question.
 *
 *   noul: a yes/no predicate; the answer is the probability that it holds.
 *   choice: pick one of the named options; the answer is the choice and a
 *     probability per option.
 *   score: rate against criteria; the answer is a score.
 */
export type QuestionSpec =
  | { type: 'noul'; instructions: string }
  | {
      type: 'choice';
      instructions: string;
      /** Option key → what the option means. */
      criteria: Record<string, string>;
    }
  | { type: 'score'; instructions: string; criteria: string[] };

/**
 * Page images to send beside the state: references to images the session
 * keeps, never the images themselves, so the Verifier's own object does not
 * hold them. The client loads them where it calls the model.
 */
export interface DecisionImages {
  /** The session that keeps them. */
  sessionKey: string;
  refs: Array<{ partSeq: number; page: number; ordinal: number }>;
}

export interface DecisionRequest {
  model: DecisionModelId;
  state: string | object;
  /** Question id → question. Ids are stable; the audit row records them. */
  questions: Record<string, QuestionSpec>;
  /** Only for a model whose registry entry takes images (`maxImages`). */
  images?: DecisionImages;
}

export interface DecisionAnswer {
  /** noul: probability the predicate holds. choice: the chosen option's. */
  probability?: number;
  /** choice: the chosen option key. */
  choice?: string;
  /** choice: probability per option key. */
  probabilities?: Record<string, number>;
  /** choice and score: the provider's own confidence in the answer. */
  confidence?: number;
  /** score. */
  score?: number;
}

export interface DecisionResponse {
  /** The model that answered, as the provider names it. */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** True when the provider reports it cut the state to fit its context. */
  truncated?: boolean;
  /**
   * The images the call carried, when the request asked for some. `error`
   * says why fewer were sent: the model then decided on the text alone.
   */
  images?: { sent: number; error?: string };
}

export interface DecisionModelClient {
  decide(
    request: DecisionRequest,
    options: { timeoutMs: number },
  ): Promise<DecisionResponse>;
}

/** The engine's default per-call budget. */
export const DEFAULT_DECISION_TIMEOUT_MS = 8_000;

/**
 * The budget for a call that carries page images: loading and unsealing
 * them, then a model reading up to four (measured 2026-10-29: clef-flash
 * with four images answered in 7.0 to 8.4 s).
 */
export const DECISION_TIMEOUT_WITH_IMAGES_MS = 15_000;

export type DecisionModelErrorCode =
  /** No answer inside the budget. */
  | 'timeout'
  /** The provider call failed. */
  | 'transport'
  /** The state and questions do not fit the model's context window. */
  | 'context_exceeded'
  /** The provider answered with something that is not a decision. */
  | 'malformed'
  /** The client does not serve the requested model. */
  | 'unsupported_model';

export class DecisionModelError extends Error {
  constructor(
    readonly code: DecisionModelErrorCode,
    message: string,
    /**
     * The provider's token counts when the model did answer (a `malformed`
     * answer is still paid for), so the check can report what it spent.
     */
    readonly usage?: DecisionResponse['usage'],
  ) {
    super(message);
    this.name = 'DecisionModelError';
  }
}

/**
 * Run `work` with a deadline. The signal aborts at the deadline so a
 * transport that honours it stops early; the returned promise rejects with
 * `DecisionModelError('timeout')` either way.
 */
export async function withDecisionTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject BEFORE aborting: a transport that settles when its signal
      // aborts would otherwise settle first and win the race, and a late
      // answer would pass for an answer inside the budget.
      reject(
        new DecisionModelError(
          'timeout',
          `decision model did not answer within ${timeoutMs} ms`,
        ),
      );
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
