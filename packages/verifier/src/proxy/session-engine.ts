// SPDX-License-Identifier: Apache-2.0

/**
 * The session policy engine: `session-invariant` and `semantic-consistency`
 * (internal design notes).
 *
 * Both judge one tool call against the agent's session ledger, on the tool
 * leg's input phase only. Both evaluate `on.tool` before touching the
 * session, so a call to another tool costs nothing and never fails closed.
 *
 *   session-invariant     The deterministic floor: every constrained
 *                         parameter must be a value some source part states.
 *                         It answers "could this value have come from the
 *                         input at all".
 *   semantic-consistency  Asks the decision model which value the input
 *                         intends, and whether the input carries an
 *                         instruction aimed at the agent. It answers "is
 *                         this the value the input meant".
 *
 * Detections marked `advisory` resolve their check to flag (missing sources
 * under `missing_source: flag`, a low-confidence match, an injection answer
 * between `block_below` and `flag_below`, a truncated state); the rest take
 * the binding's effect. A session or decision model that is
 * not there is handled by the binding's `failBehavior`.
 */

import {
  DECISION_TIMEOUT_WITH_IMAGES_MS,
  DEFAULT_DECISION_TIMEOUT_MS,
  type DecisionAnswer,
  DecisionModelError,
  type DecisionResponse,
  type QuestionSpec,
  getDecisionModel,
} from '../session/decision-model';
import {
  type SessionImageMeta,
  SessionUnreadableError,
} from '../session/session-store';
import type { SessionLeg, SessionPart } from '../session/types';
import { evaluateConduct } from './conduct-engine';
import type {
  PolicyCheckUsage,
  PolicyDetection,
  PolicyEngine,
  PolicyEngineResult,
  PolicyEvalContext,
} from './policy-evaluator-types';
import {
  type ConfigResult,
  type FactSpec,
  type MissingSource,
  type SemanticConsistencyConfig,
  type SessionInvariantConfig,
  type SourcesFrom,
  semanticConsistencyConfig,
  sessionInvariantConfig,
} from './session-config';
import {
  type Candidate,
  candidatesFor,
  counterpartyOf,
  displayValue,
  hiddenLayerDocument,
  parseNumeric,
  sameValue,
  selectHiddenLayers,
  selectSources,
  statedIn,
} from './session-floor';
import {
  AMBIGUOUS_OPTION,
  INJECTION_QUESTION_IDS,
  NONE_OPTION,
  QUESTION_IDS,
  buildQuestions,
  buildState,
  selectDecisionImages,
  stateBudgetChars,
} from './session-questions';

/** Longest evidence object kept on a check, as JSON. */
export const MAX_EVIDENCE_CHARS = 16_384;

type Evidence = Record<string, unknown>;

interface Prepared<C> {
  config: C;
  sources: SessionPart[];
  /** The invisible text layers of the source documents; never sources. */
  hiddenLayers: SessionPart[];
  sourcesEvidence: Evidence;
}

const LEG_NAMES: Record<SessionLeg, string> = {
  document: 'document',
  'message:inbound': 'message',
  'message:outbound': 'reply',
  'tool:input': 'tool call',
  'tool:output': 'tool output',
};

function legsPhrase(legs: readonly SessionLeg[]): string {
  return legs.map((leg) => LEG_NAMES[leg]).join(' or ');
}

function fromPhrase(from: SourcesFrom, counterparty: string | undefined) {
  switch (from.kind) {
    case 'any':
      return '';
    case 'counterparty':
      return counterparty ? ` from ${counterparty}` : ' from the counterparty';
    case 'agent':
      return ` from ${from.agentId}`;
  }
}

function describeFrom(from: SourcesFrom): string {
  return from.kind === 'agent' ? from.agentId : from.kind;
}

function p2(p: number): string {
  return p.toFixed(2);
}

function clamp01(p: number): number {
  return Math.min(1, Math.max(0, p));
}

/** No session to judge against: the binding's failBehavior decides. */
export function unavailable(
  ctx: PolicyEvalContext,
  reason: string,
  extra: PolicyDetection[] = [],
): PolicyEngineResult {
  const behavior = ctx.binding.failBehavior ?? 'block';
  const evidence = { appliedSession: false, reason };
  if (behavior === 'block') {
    return {
      detections: [
        ...extra,
        {
          type: 'session_unavailable',
          confidence: 1,
          message: `session unavailable: ${reason}`,
        },
      ],
      evidence,
    };
  }
  if (behavior === 'warn') {
    console.warn(
      `[spellguard] ${ctx.binding.policySlug}: session unavailable (${reason}); judged nothing`,
    );
  }
  return { detections: extra, evidence };
}

/** The decision model did not answer: the binding's failBehavior decides. */
export function decisionUnavailable(
  ctx: PolicyEvalContext,
  reason: string,
  evidence: Evidence,
  extra: PolicyDetection[],
): PolicyEngineResult {
  const behavior = ctx.binding.failBehavior ?? 'block';
  const withReason = { ...evidence, decision: 'unavailable', reason };
  if (behavior === 'block') {
    return {
      detections: [
        ...extra,
        {
          type: 'decision_unavailable',
          confidence: 1,
          message: `decision model unavailable: ${reason}`,
        },
      ],
      evidence: capEvidence(withReason),
    };
  }
  if (behavior === 'warn') {
    console.warn(
      `[spellguard] ${ctx.binding.policySlug}: decision model unavailable (${reason})`,
    );
  }
  return { detections: extra, evidence: capEvidence(withReason) };
}

function missingSourceResult(
  mode: MissingSource,
  phrase: string,
  toolName: string,
  sourcesEvidence: Evidence,
): PolicyEngineResult {
  const evidence = { appliedSession: true, sources: sourcesEvidence };
  if (mode === 'allow') return { detections: [], evidence };
  return {
    detections: [
      {
        type: 'missing_source',
        confidence: 1,
        message: `no ${phrase} in this session to check the ${toolName} call against`,
        ...(mode === 'flag' ? { advisory: true } : {}),
      },
    ],
    evidence,
  };
}

/**
 * The shared first steps. Returns a finished result when there is nothing
 * to judge (another leg, another tool, a bad config, no session, no sources).
 */
async function prepare<
  C extends {
    tool: string;
    sources: SessionLeg[];
    sourcesFrom: SourcesFrom;
    missingSource: MissingSource;
  },
>(
  ctx: PolicyEvalContext,
  read: (config: unknown) => ConfigResult<C>,
): Promise<{ done: PolicyEngineResult } | Prepared<C>> {
  if (!ctx.toolName || ctx.direction !== 'outbound') {
    return { done: { detections: [] } };
  }
  const parsed = read(ctx.binding.config ?? {});
  if (!parsed.ok) {
    return {
      done: {
        detections: [
          {
            type: 'config_invalid',
            confidence: 1,
            message: `invalid ${ctx.binding.policyType} config at ${parsed.key}: ${parsed.problem}`,
          },
        ],
      },
    };
  }
  const config = parsed.config;
  if (config.tool !== '*' && config.tool !== ctx.toolName) {
    return { done: { detections: [] } };
  }
  if (!ctx.session) {
    return {
      done: unavailable(
        ctx,
        ctx.correlationId
          ? 'no session store on this Verifier'
          : 'the call carried no correlation id',
      ),
    };
  }
  let parts: SessionPart[];
  try {
    parts = await ctx.session.parts();
  } catch (err) {
    return {
      done: unavailable(
        ctx,
        err instanceof SessionUnreadableError
          ? 'the session could not be decrypted'
          : 'the session store did not answer',
      ),
    };
  }
  const counterparty = counterpartyOf(parts, ctx.agentId);
  const sources = selectSources(
    parts,
    config.sources,
    config.sourcesFrom,
    ctx.agentId,
  );
  const sourcesEvidence: Evidence = {
    legs: config.sources,
    from: describeFrom(config.sourcesFrom),
    counterparty: counterparty ?? null,
    parts: sources.map((p) => ({
      seq: p.seq,
      leg: p.leg,
      ...(p.label !== undefined ? { label: p.label } : {}),
      from: p.from.agentId,
      digest: p.digest,
    })),
  };
  if (sources.length === 0) {
    return {
      done: missingSourceResult(
        config.missingSource,
        `${legsPhrase(config.sources)}${fromPhrase(config.sourcesFrom, counterparty)}`,
        ctx.toolName,
        sourcesEvidence,
      ),
    };
  }
  const hiddenLayers = selectHiddenLayers(
    parts,
    config.sources,
    config.sourcesFrom,
    ctx.agentId,
  );
  return { config, sources, hiddenLayers, sourcesEvidence };
}

/**
 * A parameter the sources do not state but a document's invisible text
 * layer does: the value came from text a person looking at the page cannot
 * see (#1573). Enforcing, in both policies.
 */
export function hiddenTextDetection(
  fact: FactSpec,
  value: unknown,
  sources: readonly SessionPart[],
  hiddenLayers: readonly SessionPart[],
): { detection: PolicyDetection; seq: number } | undefined {
  if (hiddenLayers.length === 0 || statedIn(fact, value, sources)) {
    return undefined;
  }
  const hidden = statedIn(fact, value, hiddenLayers);
  if (!hidden) return undefined;
  return {
    seq: hidden.seq,
    detection: {
      type: 'hidden_text_value',
      confidence: 1,
      message: `${fact.name} ${displayValue(fact, value)} appears only in the invisible text layer of ${hiddenLayerDocument(hidden)}; the page a person sees does not say it`,
    },
  };
}

/** A parameter the fact cannot be checked on, as a detection. */
export function paramProblem(
  fact: FactSpec,
  value: unknown,
  toolName: string,
): PolicyDetection | undefined {
  if (value === undefined || value === null) {
    return {
      type: 'param_missing',
      confidence: 1,
      message: `${fact.name}: parameter "${fact.param}" is missing from the ${toolName} call`,
    };
  }
  const usable =
    fact.kind === 'number' || fact.kind === 'money'
      ? parseNumeric(value) !== null
      : typeof value === 'string' || typeof value === 'number';
  if (!usable) {
    return {
      type: 'param_invalid',
      confidence: 1,
      message: `${fact.name}: parameter "${fact.param}" is not a ${fact.kind === 'identifier' || fact.kind === 'text' ? 'string' : 'number'}`,
    };
  }
  return undefined;
}

function candidateList(candidates: readonly Candidate[]): string {
  return candidates.length > 0
    ? candidates.map((c) => c.raw).join(', ')
    : 'none';
}

// ── session-invariant ─────────────────────────────────────────────

async function evaluateInvariant(
  ctx: PolicyEvalContext,
): Promise<PolicyEngineResult> {
  const prepared = await prepare(ctx, sessionInvariantConfig);
  if ('done' in prepared) return prepared.done;
  const { config, sources, hiddenLayers, sourcesEvidence } = prepared;
  const toolName = ctx.toolName as string;
  const counterparty = sourcesEvidence.counterparty as string | null;
  const phrase = `${legsPhrase(config.sources)}${fromPhrase(config.sourcesFrom, counterparty ?? undefined)}`;

  const detections: PolicyDetection[] = [];
  const facts: Evidence[] = [];
  for (const fact of config.facts) {
    const value = ctx.toolParams?.[fact.param];
    const candidates = candidatesFor(fact, sources, value);
    const problem = paramProblem(fact, value, toolName);
    if (problem) {
      detections.push(problem);
      facts.push({ name: fact.name, param: fact.param, problem: problem.type });
      continue;
    }
    const where = statedIn(fact, value, sources);
    const hidden = where
      ? undefined
      : hiddenTextDetection(fact, value, sources, hiddenLayers);
    facts.push({
      name: fact.name,
      param: fact.param,
      value: displayValue(fact, value),
      stated: where !== undefined,
      ...(where ? { statedIn: where.seq } : {}),
      ...(hidden ? { statedOnlyInHiddenLayer: hidden.seq } : {}),
      candidates: candidates.map((c) => c.raw),
    });
    if (hidden) {
      detections.push(hidden.detection);
    } else if (!where) {
      detections.push({
        type: 'invariant_violation',
        confidence: 1,
        message: `${fact.name}: ${displayValue(fact, value)} is not stated by any received ${phrase} (candidates: ${candidateList(candidates)})`,
      });
    }
  }
  return {
    detections,
    evidence: capEvidence({
      appliedSession: true,
      rule: config.rule,
      sources: sourcesEvidence,
      facts,
    }),
  };
}

// ── semantic-consistency ──────────────────────────────────────────

export interface NormalizedAnswers {
  choice: Map<string, { choice: string; p: number }>;
  noul: Map<string, number>;
}

/** Read the answers the engine needs, or throw `malformed`. */
export function readAnswers(
  response: DecisionResponse,
  questions: Record<string, QuestionSpec>,
): NormalizedAnswers {
  const out: NormalizedAnswers = { choice: new Map(), noul: new Map() };
  for (const [id, spec] of Object.entries(questions)) {
    const answer: DecisionAnswer | undefined = response.answers?.[id];
    if (!answer) {
      throw new DecisionModelError('malformed', `no answer for ${id}`);
    }
    if (spec.type === 'choice') {
      if (
        typeof answer.choice !== 'string' ||
        !Object.hasOwn(spec.criteria, answer.choice)
      ) {
        throw new DecisionModelError(
          'malformed',
          `answer for ${id} is not one of its options`,
        );
      }
      const p =
        answer.probabilities?.[answer.choice] ?? answer.probability ?? 0;
      out.choice.set(id, { choice: answer.choice, p: clamp01(p) });
    } else if (spec.type === 'noul') {
      if (typeof answer.probability !== 'number') {
        throw new DecisionModelError(
          'malformed',
          `answer for ${id} has no probability`,
        );
      }
      out.noul.set(id, clamp01(answer.probability));
    }
  }
  return out;
}

export function decisionReason(err: unknown): string {
  if (err instanceof DecisionModelError) return err.code;
  return 'transport';
}

/**
 * Each fact's parameter and candidates. A fact whose parameter is unusable,
 * or whose input states no candidate, is decided here and asked nothing.
 */
function gatherFacts(
  ctx: PolicyEvalContext,
  config: SemanticConsistencyConfig,
  sources: readonly SessionPart[],
  hiddenLayers: readonly SessionPart[],
): {
  detections: PolicyDetection[];
  candidates: Map<string, Candidate[]>;
  facts: Evidence[];
} {
  const toolName = ctx.toolName as string;
  const detections: PolicyDetection[] = [];
  const candidates = new Map<string, Candidate[]>();
  const facts: Evidence[] = [];
  for (const fact of config.facts) {
    const value = ctx.toolParams?.[fact.param];
    const problem = paramProblem(fact, value, toolName);
    if (problem) {
      detections.push(problem);
      facts.push({ name: fact.name, param: fact.param, problem: problem.type });
      continue;
    }
    const found = candidatesFor(fact, sources, value);
    const hidden = hiddenTextDetection(fact, value, sources, hiddenLayers);
    facts.push({
      name: fact.name,
      param: fact.param,
      value: displayValue(fact, value),
      ...(hidden ? { statedOnlyInHiddenLayer: hidden.seq } : {}),
      candidates: found.map((c) => c.raw),
    });
    if (hidden) detections.push(hidden.detection);
    if (found.length === 0) {
      detections.push({
        type: 'ambiguous_source',
        confidence: 1,
        message: `${fact.name}: the input states no candidate ${fact.name}`,
      });
      continue;
    }
    candidates.set(fact.name, found);
  }
  return { detections, candidates, facts };
}

/** The per-fact decision table (design §6.2). */
function factDetection(
  fact: FactSpec,
  value: unknown,
  answer: { choice: string; p: number },
  thresholds: SemanticConsistencyConfig['thresholds'],
): PolicyDetection | undefined {
  const { choice, p } = answer;
  if (choice === NONE_OPTION || choice === AMBIGUOUS_OPTION) {
    return {
      type: 'ambiguous_source',
      confidence: p,
      message: `${fact.name}: the input does not identify the intended ${fact.name} (model chose "${choice}", p=${p2(p)})`,
    };
  }
  if (!sameValue(fact, choice, value)) {
    return {
      type: 'semantic_mismatch',
      confidence: p,
      message: `${fact.name}: input intends ${displayIntended(fact, choice)} (p=${p2(p)}); action used ${displayIntended(fact, value)}`,
    };
  }
  if (p >= thresholds.flagBelow) return undefined;
  return {
    type: 'low_confidence',
    confidence: p,
    message: `${fact.name}: the input supports ${displayIntended(fact, value)} only with p=${p2(p)}`,
    ...(p >= thresholds.blockBelow ? { advisory: true } : {}),
  };
}

/** The injection predicates and the faithful check. */
function predicateDetections(
  config: SemanticConsistencyConfig,
  answers: NormalizedAnswers,
  toolName: string,
): PolicyDetection[] {
  const out: PolicyDetection[] = [];
  const { blockBelow, flagBelow } = config.thresholds;
  if (config.checks.injection) {
    for (const id of INJECTION_QUESTION_IDS) {
      const p = answers.noul.get(id);
      // At or above flag_below the detection takes the binding's effect;
      // between block_below and flag_below it is the same detection, advisory.
      if (p === undefined || p < blockBelow) continue;
      out.push({
        type: 'injection_suspected',
        confidence: p,
        message: `injection suspected: ${id} (p=${p2(p)})`,
        ...(p < flagBelow ? { advisory: true } : {}),
      });
    }
  }
  const faithful = config.checks.faithful
    ? answers.noul.get(QUESTION_IDS.faithful)
    : undefined;
  if (faithful !== undefined && faithful < blockBelow) {
    out.push({
      type: 'unfaithful_action',
      confidence: 1 - faithful,
      message: `the ${toolName} call is not a faithful execution of the input (faithful p=${p2(faithful)})`,
    });
  }
  return out;
}

/** What the model reported about the call, for the evidence. */
export function responseEvidence(
  response: DecisionResponse,
  latencyMs: number,
): Evidence {
  return {
    model: response.model,
    latencyMs,
    ...(response.usage?.inputTokens !== undefined
      ? { inputTokens: response.usage.inputTokens }
      : {}),
    ...(response.usage?.outputTokens !== undefined
      ? { outputTokens: response.usage.outputTokens }
      : {}),
    answers: response.answers,
  };
}

async function evaluateSemantic(
  ctx: PolicyEvalContext,
): Promise<PolicyEngineResult> {
  const prepared = await prepare(ctx, semanticConsistencyConfig);
  if ('done' in prepared) return prepared.done;
  const { config, sources, hiddenLayers, sourcesEvidence } = prepared;
  const toolName = ctx.toolName as string;

  const { detections, candidates, facts } = gatherFacts(
    ctx,
    config,
    sources,
    hiddenLayers,
  );
  const evidence: Evidence = {
    appliedSession: true,
    requestedModel: config.model,
    sources: sourcesEvidence,
    facts,
  };
  if (!ctx.decisionModel) {
    return decisionUnavailable(
      ctx,
      'no decision model on this Verifier',
      evidence,
      detections,
    );
  }

  const entry = getDecisionModel(config.model);
  const { images, note: imagesNote } = await decisionImages(
    ctx,
    config.facts,
    sources,
    entry?.maxImages ?? 0,
  );
  const { state, truncated } = buildState({
    sources,
    toolName,
    params: ctx.toolParams,
    budgetChars: stateBudgetChars(entry, images.length),
  });
  const questions = buildQuestions(config, toolName, candidates);
  Object.assign(evidence, {
    questions,
    truncated,
    stateChars: state.length,
    ...(images.length > 0
      ? {
          images: images.map(({ partSeq, page, bytes }) => ({
            partSeq,
            page,
            bytes,
          })),
        }
      : {}),
    ...(imagesNote ? { imagesNote } : {}),
  });
  if (Object.keys(questions).length === 0) {
    return { detections, evidence: capEvidence(evidence) };
  }

  const started = Date.now();
  let response: DecisionResponse | undefined;
  let answers: NormalizedAnswers;
  try {
    response = await ctx.decisionModel.decide(
      {
        model: config.model,
        state,
        questions,
        ...(images.length > 0 && ctx.session
          ? {
              images: {
                sessionKey: ctx.session.key,
                refs: images.map(({ partSeq, page, ordinal }) => ({
                  partSeq,
                  page,
                  ordinal,
                })),
              },
            }
          : {}),
      },
      {
        timeoutMs:
          images.length > 0
            ? DECISION_TIMEOUT_WITH_IMAGES_MS
            : DEFAULT_DECISION_TIMEOUT_MS,
      },
    );
    answers = readAnswers(response, questions);
  } catch (err) {
    const unavailable = decisionUnavailable(
      ctx,
      decisionReason(err),
      evidence,
      detections,
    );
    // A model that answered with something unreadable was still paid for:
    // the counts come with the response, or with the client's error.
    const counts =
      response?.usage ??
      (err instanceof DecisionModelError ? err.usage : undefined);
    const spent = counts
      ? decisionUsage(config.model, {
          model: config.model,
          answers: {},
          usage: counts,
        })
      : undefined;
    return spent ? { ...unavailable, usage: spent } : unavailable;
  }
  Object.assign(evidence, responseEvidence(response, Date.now() - started));
  const usage = decisionUsage(config.model, response);
  if (response.images?.error) {
    evidence.imagesNote = `the page images were not sent (${response.images.error}); the model decided on the text alone`;
  }

  for (const fact of config.facts) {
    const answer = answers.choice.get(QUESTION_IDS.factIntended(fact.name));
    if (!answer) continue;
    const detection = factDetection(
      fact,
      ctx.toolParams?.[fact.param],
      answer,
      config.thresholds,
    );
    if (detection) detections.push(detection);
  }
  detections.push(...predicateDetections(config, answers, toolName));
  if (truncated || response.truncated) {
    detections.push({
      type: 'state_truncated',
      confidence: 1,
      message: `the session's input was cut to fit the decision model (${state.length} characters sent)`,
      advisory: true,
    });
  }
  return {
    detections: enforcingFirst(detections),
    evidence: capEvidence(evidence),
    ...(usage ? { usage } : {}),
  };
}

/**
 * What the call used, for provider cost tracking: the registry id the policy named
 * (the rate card's sku) and the provider's token counts. Nothing when the
 * provider reported no input count, so nothing is recorded for that check.
 */
export function decisionUsage(
  model: string,
  response: DecisionResponse,
): PolicyCheckUsage | undefined {
  const count = (n: number | undefined) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  const inputTokens = count(response.usage?.inputTokens);
  if (inputTokens === undefined) return undefined;
  return {
    model,
    inputTokens,
    outputTokens: count(response.usage?.outputTokens) ?? 0,
  };
}

/**
 * The page images to send beside the state, chosen from the session's kept
 * images. A store that keeps none, or a model that takes none, sends none;
 * images that cannot be listed are noted and the call goes on with text.
 */
export async function decisionImages(
  ctx: PolicyEvalContext,
  facts: readonly FactSpec[],
  sources: readonly SessionPart[],
  maxImages: number,
  params: Record<string, unknown> | undefined = ctx.toolParams,
): Promise<{ images: SessionImageMeta[]; note?: string }> {
  if (maxImages <= 0 || !ctx.session?.images) return { images: [] };
  let kept: SessionImageMeta[];
  try {
    kept = await ctx.session.images();
  } catch (err) {
    return {
      images: [],
      note: `the page images could not be listed (${err instanceof Error ? err.message : String(err)}); the model decided on the text alone`,
    };
  }
  return {
    images: selectDecisionImages({
      images: kept,
      sources,
      facts,
      params,
      maxImages,
    }),
  };
}

/**
 * The enforcing detections before the advisory ones, each group in its own
 * order. A blocked tool call answers with its denying check's first
 * detection, which must then be the reason it was blocked, not a flag beside
 * it (a low-confidence match on one fact beside a mismatch on another).
 */
export function enforcingFirst(
  detections: PolicyDetection[],
): PolicyDetection[] {
  return [
    ...detections.filter((d) => !d.advisory),
    ...detections.filter((d) => d.advisory),
  ];
}

/** A value as the semantic messages show it: numbers normalized, ids raw. */
function displayIntended(fact: FactSpec, value: unknown): string {
  if (fact.kind === 'number' || fact.kind === 'money') {
    const n = parseNumeric(value);
    if (n !== null) return String(n);
  }
  return String(value);
}

/**
 * Keep evidence under MAX_EVIDENCE_CHARS: drop the question texts first
 * (the ids and options stay), then the per-option probabilities, then the
 * source part list.
 */
export function capEvidence(evidence: Evidence): Evidence {
  const size = (e: Evidence) => JSON.stringify(e).length;
  if (size(evidence) <= MAX_EVIDENCE_CHARS) return evidence;
  const trimmed: Evidence = { ...evidence, evidenceTrimmed: true };
  if (trimmed.questions && typeof trimmed.questions === 'object') {
    trimmed.questions = Object.fromEntries(
      Object.entries(trimmed.questions as Record<string, QuestionSpec>).map(
        ([id, q]) => [
          id,
          q.type === 'choice'
            ? { type: q.type, options: Object.keys(q.criteria) }
            : { type: q.type },
        ],
      ),
    );
  }
  if (size(trimmed) <= MAX_EVIDENCE_CHARS) return trimmed;
  if (trimmed.answers && typeof trimmed.answers === 'object') {
    trimmed.answers = Object.fromEntries(
      Object.entries(trimmed.answers as Record<string, DecisionAnswer>).map(
        ([id, a]) => [
          id,
          {
            ...(a.choice !== undefined ? { choice: a.choice } : {}),
            ...(a.probability !== undefined
              ? { probability: a.probability }
              : {}),
          },
        ],
      ),
    );
  }
  if (size(trimmed) <= MAX_EVIDENCE_CHARS) return trimmed;
  if (trimmed.sources && typeof trimmed.sources === 'object') {
    const { parts: _parts, ...rest } = trimmed.sources as Evidence;
    trimmed.sources = rest;
  }
  if (size(trimmed) <= MAX_EVIDENCE_CHARS) return trimmed;
  return {
    appliedSession: evidence.appliedSession,
    evidenceTrimmed: true,
  };
}

export class SessionEngine implements PolicyEngine {
  readonly name = 'session';

  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDetection[]> {
    return (await this.evaluateWithEvidence(ctx)).detections;
  }

  async evaluateWithEvidence(
    ctx: PolicyEvalContext,
  ): Promise<PolicyEngineResult> {
    switch (ctx.binding.policyType) {
      case 'session-invariant':
        return evaluateInvariant(ctx);
      case 'semantic-consistency':
        return evaluateSemantic(ctx);
      case 'agent-conduct':
        return evaluateConduct(ctx);
      default:
        return { detections: [] };
    }
  }
}

/** The config readers, for the catalog validation tests. */
export const SESSION_CONFIG_READERS = {
  'session-invariant': sessionInvariantConfig,
  'semantic-consistency': semanticConsistencyConfig,
} as const satisfies Record<
  string,
  (
    config: unknown,
  ) => ConfigResult<SessionInvariantConfig | SemanticConsistencyConfig>
>;
