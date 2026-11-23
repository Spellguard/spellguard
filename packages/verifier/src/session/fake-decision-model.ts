// SPDX-License-Identifier: Apache-2.0

/**
 * A deterministic decision model for tests: answers are scripted per
 * question id, so an engine test states exactly what "the model said" and
 * asserts what the engine did with it.
 *
 * It honours the caller's timeout, can be told to fail or to be slow, and
 * keeps every request it was sent so a test can assert on the state and the
 * question bank the engine built.
 */

import {
  type DecisionAnswer,
  type DecisionModelClient,
  DecisionModelError,
  type DecisionRequest,
  type DecisionResponse,
  type QuestionSpec,
  withDecisionTimeout,
} from './decision-model';

export type ScriptedAnswer =
  | DecisionAnswer
  | ((request: DecisionRequest, questionId: string) => DecisionAnswer);

export interface FakeDecisionModelOptions {
  /** Question id → the answer (or a function of the request). */
  answers?: Record<string, ScriptedAnswer>;
  /** Answer for an unscripted question. Default `neutralAnswer`. */
  fallback?: (questionId: string, spec: QuestionSpec) => DecisionAnswer;
  /** Fail on an unscripted question instead of using the fallback. */
  strict?: boolean;
  /** Delay before answering, to exercise timeouts. */
  latencyMs?: number;
  /** Throw this instead of answering. */
  failWith?: Error;
  /** Reported as `usage.inputTokens`. Default: state characters / 4. */
  inputTokens?: number;
  /** Reported as `truncated`. */
  truncated?: boolean;
}

/**
 * Says nothing either way: every predicate improbable, every option equally
 * likely (the first key chosen), score zero.
 */
export function neutralAnswer(
  _questionId: string,
  spec: QuestionSpec,
): DecisionAnswer {
  switch (spec.type) {
    case 'noul':
      return { probability: 0 };
    case 'choice': {
      const keys = Object.keys(spec.criteria);
      const p = keys.length > 0 ? 1 / keys.length : 0;
      return {
        choice: keys[0],
        probability: p,
        probabilities: Object.fromEntries(keys.map((k) => [k, p])),
      };
    }
    case 'score':
      return { score: 0 };
  }
}

export class FakeDecisionModel implements DecisionModelClient {
  /** Every request received, in order (deep copies). */
  readonly requests: DecisionRequest[] = [];

  constructor(private readonly options: FakeDecisionModelOptions = {}) {}

  async decide(
    request: DecisionRequest,
    { timeoutMs }: { timeoutMs: number },
  ): Promise<DecisionResponse> {
    this.requests.push(structuredClone(request));
    return withDecisionTimeout(async (signal) => {
      if (this.options.latencyMs) await delay(this.options.latencyMs, signal);
      if (this.options.failWith) throw this.options.failWith;
      const stateChars =
        typeof request.state === 'string'
          ? request.state.length
          : JSON.stringify(request.state).length;
      return {
        model: request.model,
        answers: this.answer(request),
        usage: {
          inputTokens: this.options.inputTokens ?? Math.ceil(stateChars / 4),
        },
        ...(this.options.truncated !== undefined
          ? { truncated: this.options.truncated }
          : {}),
      };
    }, timeoutMs);
  }

  private answer(request: DecisionRequest): Record<string, DecisionAnswer> {
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, spec] of Object.entries(request.questions)) {
      const scripted = this.options.answers?.[id];
      if (scripted) {
        answers[id] = structuredClone(
          typeof scripted === 'function' ? scripted(request, id) : scripted,
        );
      } else if (this.options.strict) {
        throw new DecisionModelError(
          'malformed',
          `no scripted answer for question "${id}"`,
        );
      } else {
        answers[id] = (this.options.fallback ?? neutralAnswer)(id, spec);
      }
    }
    return answers;
  }
}

/** Wait `ms`, or until `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
