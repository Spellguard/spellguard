// SPDX-License-Identifier: Apache-2.0

/**
 * The `agent-conduct` engine (internal design notes):
 * judge one output the agent makes, whatever its transport, against what
 * the agent received in the conversation and what its owner says each kind
 * of output means.
 *
 * It runs on every leg that observes an output (`ctx.output`, built by the
 * leg: a tool call's input phase, an A2A send, a reply, an external A2A
 * send) and on no other. The owner's `outputs[]` are matched in order, the
 * first match wins, and an output that matches nothing is judged with effect
 * flag. Each output is checked one of three ways:
 *
 *   exact   its committed values must trace back to the input: the floor
 *           (a source states the value) and the decision model's reading of
 *           which value the input intends. For outputs that commit the
 *           company. Fails closed.
 *   judge   the decision model answers fixed questions about what the output
 *           does, given the owner's description and the input.
 *   limit   the values the output commits to must stay within the owner's
 *           limits (internal design notes): read from its
 *           parameters, or chosen by the decision model among the numbers
 *           its text states; the totals and the comparison are code. Reads
 *           the output only, never the session. Fails closed.
 *   ignore  not checked.
 *
 * Findings are enforcing or notes. An enforcing finding takes the output's
 * effect; a note is recorded on the check's evidence (and so on the audit
 * row) and never changes its decision: it is not a detection. The effect
 * rule (design §4): an output whose effect is `flag` lowers the check to
 * flag; one whose effect is `block` keeps the binding's effect. A binding
 * with effect `flag` therefore observes only.
 *
 * Reuses the provenance engines' floor, decision-model client, answer
 * reader and failure handling (session-engine.ts, session-floor.ts).
 */

import { computeValues } from '@spellguard/amp';
import type { AgentOutput } from '../session/agent-output';
import {
  DECISION_TIMEOUT_WITH_IMAGES_MS,
  DEFAULT_DECISION_TIMEOUT_MS,
  DecisionModelError,
  type DecisionResponse,
  type QuestionSpec,
  getDecisionModel,
} from '../session/decision-model';
import {
  type SessionImageMeta,
  SessionUnreadableError,
} from '../session/session-store';
import { COUNTERPARTY_LEGS, type SessionPart } from '../session/types';
import {
  type AgentConductFact,
  type AgentConductOutputRule,
  type AgentConductProfile,
  agentConductConfig,
} from './conduct-config';
import {
  CONDUCT_QUESTION_IDS,
  INTENDED_TERMS,
  LIMIT_QUESTIONS,
  type OutputFunction,
  buildConductState,
  buildLimitState,
  committedNumberQuestion,
  faithfulQuestion,
  intendedIdentifierQuestion,
  intendedNumberQuestion,
  judgeQuestions,
  trustOf,
  valueCriteria,
} from './conduct-questions';
import type {
  PolicyCheckUsage,
  PolicyDetection,
  PolicyEngineResult,
  PolicyEvalContext,
} from './policy-evaluator-types';
import type { FactSpec } from './session-config';
import {
  type NormalizedAnswers,
  capEvidence,
  decisionImages,
  decisionReason,
  decisionUnavailable,
  decisionUsage,
  hiddenTextDetection,
  paramProblem,
  readAnswers,
  responseEvidence,
  unavailable,
} from './session-engine';
import {
  type Candidate,
  candidatesFor,
  displayValue,
  parseNumeric,
  sameValue,
  statedIn,
} from './session-floor';
import {
  AMBIGUOUS_OPTION,
  INJECTION_QUESTIONS,
  INJECTION_QUESTION_IDS,
  NONE_OPTION,
  stateBudgetChars,
} from './session-questions';

type Evidence = Record<string, unknown>;

/** Longest output text kept on the evidence. */
export const MAX_OUTPUT_EVIDENCE_CHARS = 2_000;

/** A finding is enforcing (takes the output's effect) or a note. */
export interface Finding {
  type: string;
  level: 'enforcing' | 'note';
  message: string;
  confidence: number;
  question?: string;
  p?: number;
}

/** The entry an output matched, or the default for one that matched none. */
export interface MatchedOutput {
  /** Position in `outputs[]`; -1 for the default. */
  index: number;
  rule: AgentConductOutputRule;
}

/** The rule for an output that matches no entry: judged, effect flag. */
export const UNMATCHED_RULE: AgentConductOutputRule = {
  match: '*',
  check: 'judge',
  facts: [],
  effect: 'flag',
};

function p2(p: number): string {
  return p.toFixed(2);
}

/** Whether one entry's `match` covers the output: every key it names. */
function matches(
  match: AgentConductOutputRule['match'],
  output: AgentOutput,
): boolean {
  if (match === '*') return true;
  const checks = [
    match.tool === undefined ||
      (output.kind === 'tool' && output.target === match.tool),
    match.channel === undefined || output.channel === match.channel,
    match.target === undefined || output.target === match.target,
    match.commandContains === undefined ||
      (output.kind === 'command' &&
        output.text.includes(match.commandContains)),
  ];
  return checks.every(Boolean);
}

/** `outputs[]` in order, first match wins (design §4). */
export function matchOutput(
  profile: Pick<AgentConductProfile, 'outputs'>,
  output: AgentOutput,
): MatchedOutput {
  const index = profile.outputs.findIndex((rule) =>
    matches(rule.match, output),
  );
  return index === -1
    ? { index: -1, rule: UNMATCHED_RULE }
    : { index, rule: profile.outputs[index] };
}

/**
 * The parts the agent received: messages, documents and tool outputs from
 * anyone but itself. A document's invisible text layer is never shown to the
 * decision model (provenance design §5.6).
 */
export function receivedParts(
  parts: readonly SessionPart[],
  self: string | undefined,
): SessionPart[] {
  return parts.filter((p) => {
    if (p.kind === 'hidden-layer') return false;
    if (p.leg === 'tool:output') return true;
    return COUNTERPARTY_LEGS.has(p.leg) && p.from.agentId !== self;
  });
}

/** The agent's own earlier outputs in the conversation. */
export function earlierParts(parts: readonly SessionPart[]): SessionPart[] {
  return parts.filter(
    (p) => p.leg === 'message:outbound' || p.leg === 'tool:input',
  );
}

/**
 * Whether a received part counts as a source for `exact` (design §4):
 * documents from an external or authoritative producer, messages from an
 * authoritative one only, tool outputs always. An untrusted or unlisted
 * producer never counts, and the agent is never its own source.
 */
function countsAsSource(
  part: SessionPart,
  profile: Pick<AgentConductProfile, 'sources'>,
  self: string | undefined,
): boolean {
  if (part.leg === 'tool:output') return true;
  if (!COUNTERPARTY_LEGS.has(part.leg)) return false;
  if (self !== undefined && part.from.agentId === self) return false;
  const trust = trustOf(profile, part.from.agentId);
  if (part.leg === 'document') {
    return trust === 'external' || trust === 'authoritative';
  }
  return trust === 'authoritative';
}

export function exactSources(
  parts: readonly SessionPart[],
  profile: Pick<AgentConductProfile, 'sources'>,
  self: string | undefined,
): SessionPart[] {
  return parts.filter(
    (p) => p.kind !== 'hidden-layer' && countsAsSource(p, profile, self),
  );
}

function exactHiddenLayers(
  parts: readonly SessionPart[],
  profile: Pick<AgentConductProfile, 'sources'>,
  self: string | undefined,
): SessionPart[] {
  return parts.filter(
    (p) => p.kind === 'hidden-layer' && countsAsSource(p, profile, self),
  );
}

/** The floor and the decision table take the provenance engines' fact. */
function factSpec(fact: AgentConductFact): FactSpec {
  return {
    name: fact.name,
    param: fact.param ?? fact.name,
    kind: fact.kind,
    ...(fact.pattern ? { pattern: fact.pattern } : {}),
    ...(fact.patternSource ? { patternSource: fact.patternSource } : {}),
  };
}

/** The output's text as a part, so the floor's readers list what it states. */
function outputAsPart(output: AgentOutput): SessionPart {
  return {
    seq: 0,
    at: 0,
    leg: 'tool:input',
    kind: 'text',
    from: { agentId: '' },
    text: output.text,
    digest: '',
    truncated: false,
  };
}

function outputEvidence(output: AgentOutput): Evidence {
  const text =
    output.text.length > MAX_OUTPUT_EVIDENCE_CHARS
      ? `${output.text.slice(0, MAX_OUTPUT_EVIDENCE_CHARS)} [cut]`
      : output.text;
  return {
    kind: output.kind,
    channel: output.channel,
    target: output.target,
    leg: output.leg,
    text,
  };
}

function matchedEvidence(matched: MatchedOutput): Evidence {
  const { rule, index } = matched;
  return {
    index,
    match:
      rule.match === '*'
        ? '*'
        : {
            ...(rule.match.tool !== undefined ? { tool: rule.match.tool } : {}),
            ...(rule.match.channel !== undefined
              ? { channel: rule.match.channel }
              : {}),
            ...(rule.match.target !== undefined
              ? { target: rule.match.target }
              : {}),
          },
    ...(rule.meaning !== undefined ? { meaning: rule.meaning } : {}),
    check: rule.check,
    effect: rule.effect,
    ...(index === -1 ? { unmatched: true } : {}),
  };
}

/**
 * The check's result: enforcing findings as detections, notes on the
 * evidence only. The effect: the output's, except that a check whose only
 * enforcing finding is `input_injection` flags (decision of 2026-11-02).
 */
function result(
  ctx: PolicyEvalContext,
  rule: AgentConductOutputRule,
  findings: readonly Finding[],
  evidence: Evidence,
): PolicyEngineResult {
  const enforcing = findings.filter((f) => f.level === 'enforcing');
  const notes = findings.filter((f) => f.level === 'note');
  const flagOnly =
    rule.effect === 'flag' ||
    (enforcing.length > 0 &&
      enforcing.every((f) => f.type === 'input_injection'));
  const detections: PolicyDetection[] = enforcing.map((f) => ({
    type: f.type,
    confidence: f.confidence,
    message: f.message,
  }));
  return {
    detections,
    evidence: capEvidence({
      ...evidence,
      effect: effectEvidence(ctx, rule, flagOnly),
      findings: findings.map(findingEvidence),
      notes: notes.map(findingEvidence),
    }),
    ...(flagOnly ? { effect: 'flag' as const } : {}),
  };
}

function findingEvidence(f: Finding): Evidence {
  return {
    type: f.type,
    level: f.level,
    message: f.message,
    ...(f.question !== undefined ? { question: f.question } : {}),
    ...(f.p !== undefined ? { p: f.p } : {}),
  };
}

function effectEvidence(
  ctx: PolicyEvalContext,
  rule: AgentConductOutputRule,
  flagOnly: boolean,
): Evidence {
  return {
    output: rule.effect,
    binding: ctx.binding.effect,
    applied: flagOnly ? 'flag' : ctx.binding.effect,
  };
}

/**
 * A failure before the model answered (no session, no model, a refused
 * call): the binding's failBehavior decides, and a detection takes the
 * output's effect.
 */
function failed(
  ctx: PolicyEvalContext,
  rule: AgentConductOutputRule,
  failure: PolicyEngineResult,
  evidence: Evidence,
): PolicyEngineResult {
  const flagOnly = rule.effect === 'flag';
  return {
    detections: failure.detections,
    evidence: capEvidence({
      ...evidence,
      ...(failure.evidence ?? {}),
      effect: effectEvidence(ctx, rule, flagOnly),
    }),
    ...(flagOnly && failure.detections.length > 0
      ? { effect: 'flag' as const }
      : {}),
  };
}

export async function evaluateConduct(
  ctx: PolicyEvalContext,
): Promise<PolicyEngineResult> {
  const output = ctx.output;
  // A leg that makes no output (an inbound message, a tool's result, a
  // plugin leg not observed yet) is not this policy's.
  if (!output) return { detections: [] };
  const parsed = agentConductConfig(ctx.binding.config ?? {});
  if (!parsed.ok) {
    return {
      detections: [
        {
          type: 'config_invalid',
          confidence: 1,
          message: `invalid agent-conduct config at ${parsed.key}: ${parsed.problem}`,
        },
      ],
    };
  }
  return judgeOutput(ctx, parsed.profile, output);
}

/**
 * Judge one output against a profile. Exported for the measurement
 * fixtures, which replay recorded answers through it.
 */
export async function judgeOutput(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  output: AgentOutput,
): Promise<PolicyEngineResult> {
  const matched = matchOutput(profile, output);
  const { rule } = matched;
  const evidence: Evidence = {
    check: rule.check,
    output: outputEvidence(output),
    matched: matchedEvidence(matched),
  };
  if (rule.check === 'ignore') {
    return { detections: [], evidence: { appliedSession: false, ...evidence } };
  }
  if (rule.check === 'limit') {
    // A limit reads the output alone: no session, so none is required.
    return evaluateLimit(ctx, profile, rule, output, {
      appliedSession: false,
      ...evidence,
    });
  }
  if (!ctx.session) {
    return failed(
      ctx,
      rule,
      unavailable(
        ctx,
        ctx.correlationId
          ? 'no session store on this Verifier'
          : 'the output carried no correlation id',
      ),
      evidence,
    );
  }
  let parts: SessionPart[];
  try {
    parts = await ctx.session.parts();
  } catch (err) {
    return failed(
      ctx,
      rule,
      unavailable(
        ctx,
        err instanceof SessionUnreadableError
          ? 'the session could not be decrypted'
          : 'the session store did not answer',
      ),
      evidence,
    );
  }
  evidence.appliedSession = true;
  return rule.check === 'exact'
    ? evaluateExact(ctx, profile, rule, output, parts, evidence)
    : evaluateJudge(ctx, profile, rule, output, parts, evidence);
}

// ── Asking the model ───────────────────────────────────────────────

interface Asked {
  answers: NormalizedAnswers;
  response: DecisionResponse;
  /** What the call used, for provider cost tracking; absent without counts. */
  usage?: PolicyCheckUsage;
}

/** A result with the call's usage, so usage recording retains it. */
function withUsage(
  done: PolicyEngineResult,
  usage: PolicyCheckUsage | undefined,
): PolicyEngineResult {
  return usage ? { ...done, usage } : done;
}

/**
 * Build the state and ask. Returns the answers, or a finished result when
 * the call could not be made or answered (failBehavior decides).
 */
async function ask(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  rule: AgentConductOutputRule,
  output: AgentOutput,
  parts: readonly SessionPart[],
  imageSources: readonly SessionPart[],
  questions: Record<string, QuestionSpec>,
  evidence: Evidence,
): Promise<Asked | { done: PolicyEngineResult }> {
  evidence.requestedModel = profile.model;
  evidence.questions = questions;
  if (!ctx.decisionModel) {
    return {
      done: failed(
        ctx,
        rule,
        decisionUnavailable(ctx, 'no decision model on this Verifier', {}, []),
        evidence,
      ),
    };
  }
  const entry = getDecisionModel(profile.model);
  const imageFacts = rule.facts.map(factSpec);
  const { images, note: imagesNote } = await decisionImages(
    ctx,
    imageFacts,
    imageSources,
    entry?.maxImages ?? 0,
    output.params,
  );
  const { state, truncated, overBudget } = buildConductState({
    profile,
    rule,
    received: receivedParts(parts, ctx.agentId),
    earlier: earlierParts(parts),
    output,
    budgetChars: stateBudgetChars(entry, images.length),
  });
  Object.assign(evidence, {
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
  if (overBudget) {
    return { done: overBudgetResult(ctx, profile, rule, evidence) };
  }
  return askModel(ctx, profile, rule, { state, images }, questions, evidence);
}

/** The owner's text and the output alone are over the model's budget. */
function overBudgetResult(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  rule: AgentConductOutputRule,
  evidence: Evidence,
): PolicyEngineResult {
  return failed(
    ctx,
    rule,
    decisionUnavailable(
      ctx,
      `the owner's description and the output are longer than ${profile.model} can judge in one call`,
      {},
      [],
    ),
    evidence,
  );
}

/**
 * Ask the model about a built state. Returns the answers, or a finished
 * result when the call could not be made or answered (failBehavior decides).
 */
async function askModel(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  rule: AgentConductOutputRule,
  input: { state: string; images: readonly SessionImageMeta[] },
  questions: Record<string, QuestionSpec>,
  evidence: Evidence,
): Promise<Asked | { done: PolicyEngineResult }> {
  const decisionModel = ctx.decisionModel;
  if (!decisionModel) {
    return {
      done: failed(
        ctx,
        rule,
        decisionUnavailable(ctx, 'no decision model on this Verifier', {}, []),
        evidence,
      ),
    };
  }
  const { state, images } = input;
  const started = Date.now();
  let response: DecisionResponse | undefined;
  let answers: NormalizedAnswers;
  try {
    response = await decisionModel.decide(
      {
        model: profile.model,
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
    // A model that answered with something unreadable was still paid for:
    // the counts come with the response, or with the client's error.
    const counts =
      response?.usage ??
      (err instanceof DecisionModelError ? err.usage : undefined);
    const spent = counts
      ? decisionUsage(profile.model, {
          model: profile.model,
          answers: {},
          usage: counts,
        })
      : undefined;
    return {
      done: withUsage(
        failed(
          ctx,
          rule,
          decisionUnavailable(ctx, decisionReason(err), {}, []),
          evidence,
        ),
        spent,
      ),
    };
  }
  Object.assign(evidence, responseEvidence(response, Date.now() - started));
  if (response.images?.error) {
    evidence.imagesNote = `the page images were not sent (${response.images.error}); the model decided on the text alone`;
  }
  return {
    answers,
    response,
    usage: decisionUsage(profile.model, response),
  };
}

/** A probability answer in the band between the thresholds is a note. */
function band(
  p: number,
  thresholds: AgentConductProfile['thresholds'],
): 'enforcing' | 'note' {
  return p < thresholds.blockBelow ? 'enforcing' : 'note';
}

/** The highest injection answer and its question, or undefined. */
function strongestInjection(
  answers: NormalizedAnswers,
): { id: string; p: number } | undefined {
  let best: { id: string; p: number } | undefined;
  for (const id of INJECTION_QUESTION_IDS) {
    const p = answers.noul.get(id);
    if (p !== undefined && (!best || p > best.p)) best = { id, p };
  }
  return best;
}

// ── exact ──────────────────────────────────────────────────────────

/** How each fact's committed value is read from the output. */
interface Committed {
  fact: AgentConductFact;
  spec: FactSpec;
  /** Read without the model: a parameter, or identifiers by pattern. */
  values?: unknown[];
  /** Read by the model: the choice question's id. */
  question?: string;
  /** Read from a structured parameter. */
  structured: boolean;
}

function displayCommitted(fact: FactSpec, value: unknown): string {
  if (fact.kind === 'number' || fact.kind === 'money') {
    const n = parseNumeric(value);
    if (n !== null) return String(n);
  }
  return String(value);
}

/** What the exact check asks, and what it decided before asking. */
interface ExactPlan {
  findings: Finding[];
  committed: Committed[];
  candidates: Map<string, Candidate[]>;
  questions: Record<string, QuestionSpec>;
  facts: Evidence[];
}

const enforcing = (type: string, message: string): Finding => ({
  type,
  level: 'enforcing',
  confidence: 1,
  message,
});

/**
 * How one fact's committed value is read: a structured parameter, the
 * identifiers its pattern finds in the text, or a choice question over the
 * numbers the text states. Undefined, with a finding, when there is none.
 */
function readCommitted(
  fact: AgentConductFact,
  spec: FactSpec,
  output: AgentOutput,
  plan: ExactPlan,
  factEv: Evidence,
): { committed: Committed; keep?: unknown } | undefined {
  if (output.kind === 'tool' && output.params && fact.param !== undefined) {
    const value = output.params[fact.param];
    const problem = paramProblem(spec, value, output.target);
    if (problem) {
      plan.findings.push(
        enforcing(problem.type, problem.message ?? problem.type),
      );
      factEv.problem = problem.type;
      return undefined;
    }
    factEv.committed = [displayValue(spec, value)];
    return {
      committed: { fact, spec, values: [value], structured: true },
      keep: value,
    };
  }
  const stated = candidatesFor(spec, [outputAsPart(output)]);
  if (stated.length === 0) {
    plan.findings.push(
      enforcing(
        'param_missing',
        `${fact.name}: the output states no ${fact.name}`,
      ),
    );
    factEv.problem = 'param_missing';
    return undefined;
  }
  if (fact.kind === 'identifier') {
    const values = stated.map((c) => c.raw);
    factEv.committed = values;
    return {
      committed: { fact, spec, values, structured: false },
      keep: values[0],
    };
  }
  const id = CONDUCT_QUESTION_IDS.committed(fact.name);
  plan.questions[id] = {
    type: 'choice',
    instructions: committedNumberQuestion(fact.name),
    criteria: valueCriteria(stated, 'output', {
      [NONE_OPTION]: `the output states no ${fact.name} it commits to or instructs`,
    }),
  };
  factEv.statedInOutput = stated.map((c) => c.raw);
  return { committed: { fact, spec, question: id, structured: false } };
}

/** The exact check's questions (design §5.1), and the facts decided first. */
function planExact(
  rule: AgentConductOutputRule,
  output: AgentOutput,
  sources: readonly SessionPart[],
): ExactPlan {
  const plan: ExactPlan = {
    findings: [],
    committed: [],
    candidates: new Map(),
    questions: {},
    facts: [],
  };
  for (const fact of rule.facts) {
    const spec = factSpec(fact);
    const factEv: Evidence = {
      name: fact.name,
      ...(fact.param !== undefined ? { param: fact.param } : {}),
    };
    plan.facts.push(factEv);
    const read = readCommitted(fact, spec, output, plan, factEv);
    if (!read) continue;
    plan.committed.push(read.committed);
    const found = candidatesFor(spec, sources, read.keep);
    factEv.candidates = found.map((c) => c.raw);
    if (found.length === 0) {
      plan.findings.push(
        enforcing(
          'ambiguous_source',
          `${fact.name}: the input states no candidate ${fact.name}`,
        ),
      );
      continue;
    }
    plan.candidates.set(fact.name, found);
    plan.questions[CONDUCT_QUESTION_IDS.intended(fact.name)] = {
      type: 'choice',
      instructions:
        fact.kind === 'identifier'
          ? intendedIdentifierQuestion(fact.name, output)
          : intendedNumberQuestion(fact.name),
      criteria: valueCriteria(found, 'input', {
        [NONE_OPTION]: 'none of the listed values is the intended one',
        [AMBIGUOUS_OPTION]:
          'the input does not make clear which value is intended',
      }),
    };
  }
  return plan;
}

/**
 * The committed values a model answer reads from text, with its band, or
 * undefined (and a finding) when the output commits to none.
 */
function committedValues(
  c: Committed,
  answers: NormalizedAnswers,
  thresholds: AgentConductProfile['thresholds'],
  findings: Finding[],
): unknown[] | undefined {
  if (!c.question) return c.values ?? [];
  const answer = answers.choice.get(c.question);
  if (!answer) return undefined;
  const { fact } = c;
  if (answer.choice === NONE_OPTION) {
    findings.push({
      type: 'param_missing',
      level: 'enforcing',
      confidence: answer.p,
      message: `${fact.name}: the output commits to no ${fact.name} (p=${p2(answer.p)})`,
      question: c.question,
      p: answer.p,
    });
    return undefined;
  }
  if (answer.p < thresholds.flagBelow) {
    findings.push({
      type: 'low_confidence',
      level: band(answer.p, thresholds),
      confidence: answer.p,
      message: `${fact.name}: the output's committed ${fact.name} reads as ${answer.choice} only with p=${p2(answer.p)}`,
      question: c.question,
      p: answer.p,
    });
  }
  return [answer.choice];
}

/** The floor: every committed value is stated by a source the owner trusts. */
function floorFindings(
  c: Committed,
  values: readonly unknown[],
  plan: ExactPlan,
  sources: readonly SessionPart[],
  hiddenLayers: readonly SessionPart[],
): Finding[] {
  const out: Finding[] = [];
  for (const value of values) {
    if (statedIn(c.spec, value, sources)) continue;
    const hidden = c.structured
      ? hiddenTextDetection(c.spec, value, sources, hiddenLayers)
      : undefined;
    const candidates = (plan.candidates.get(c.fact.name) ?? [])
      .map((x) => x.raw)
      .join(', ');
    out.push(
      hidden
        ? enforcing(
            hidden.detection.type,
            hidden.detection.message ?? hidden.detection.type,
          )
        : enforcing(
            'invariant_violation',
            `${c.fact.name}: ${displayCommitted(c.spec, value)} is not stated by any source the owner trusts for it (candidates: ${candidates || 'none'})`,
          ),
    );
  }
  return out;
}

/** The semantic comparison: the input intends X, the output commits Y. */
function semanticFinding(
  c: Committed,
  values: readonly unknown[],
  answers: NormalizedAnswers,
  thresholds: AgentConductProfile['thresholds'],
): Finding | undefined {
  const { fact, spec } = c;
  const id = CONDUCT_QUESTION_IDS.intended(fact.name);
  const intended = answers.choice.get(id);
  if (!intended) return undefined;
  const at = { question: id, p: intended.p, confidence: intended.p };
  if (intended.choice === NONE_OPTION || intended.choice === AMBIGUOUS_OPTION) {
    return {
      type: 'ambiguous_source',
      level: 'enforcing',
      message: `${fact.name}: the input does not identify the intended ${fact.name} (model chose "${intended.choice}", p=${p2(intended.p)})`,
      ...at,
    };
  }
  if (!values.some((v) => sameValue(spec, intended.choice, v))) {
    return {
      type: 'semantic_mismatch',
      level: 'enforcing',
      message: `${fact.name}: input intends ${displayCommitted(spec, intended.choice)} (p=${p2(intended.p)}); output commits ${values.map((v) => displayCommitted(spec, v)).join(', ')}`,
      ...at,
    };
  }
  if (intended.p >= thresholds.flagBelow) return undefined;
  return {
    type: 'low_confidence',
    level: band(intended.p, thresholds),
    message: `${fact.name}: the input supports ${displayCommitted(spec, intended.choice)} only with p=${p2(intended.p)}`,
    ...at,
  };
}

/**
 * An injection in the input never blocks an exact output by itself. When
 * the output passes, an injection at or above flag_below flags it, and one
 * between the thresholds is a note (decision of 2026-11-02).
 */
function injectionFinding(
  answers: NormalizedAnswers,
  thresholds: AgentConductProfile['thresholds'],
): Finding | undefined {
  const injection = strongestInjection(answers);
  if (!injection || injection.p < thresholds.blockBelow) return undefined;
  return {
    type: 'input_injection',
    level: injection.p >= thresholds.flagBelow ? 'enforcing' : 'note',
    confidence: injection.p,
    message: `The output uses the values the input intends, but the input carries text that tries to direct the agent (${injection.id}, p=${p2(injection.p)}).`,
    question: injection.id,
    p: injection.p,
  };
}

async function evaluateExact(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  rule: AgentConductOutputRule,
  output: AgentOutput,
  parts: readonly SessionPart[],
  evidence: Evidence,
): Promise<PolicyEngineResult> {
  const self = ctx.agentId;
  const sources = exactSources(parts, profile, self);
  const hiddenLayers = exactHiddenLayers(parts, profile, self);
  evidence.sources = sources.map((p) => ({
    seq: p.seq,
    leg: p.leg,
    ...(p.label !== undefined ? { label: p.label } : {}),
    from: p.from.agentId,
    trust: p.leg === 'tool:output' ? 'tool' : trustOf(profile, p.from.agentId),
    digest: p.digest,
  }));
  if (sources.length === 0) {
    return result(
      ctx,
      rule,
      [
        enforcing(
          'missing_source',
          "Nothing in this conversation can vouch for the output's values: no document from a listed source, no message from an authoritative one, and no tool output.",
        ),
      ],
      evidence,
    );
  }

  const plan = planExact(rule, output, sources);
  evidence.facts = plan.facts;
  evidence.intendedTerms = INTENDED_TERMS;
  if (Object.keys(plan.questions).length === 0) {
    // Every fact was decided without the model, and each such decision is
    // enforcing: nothing a model answer could clear.
    return result(ctx, rule, plan.findings, evidence);
  }
  const questions: Record<string, QuestionSpec> = {
    ...plan.questions,
    ...INJECTION_QUESTIONS,
    [CONDUCT_QUESTION_IDS.faithful]: faithfulQuestion(
      rule.facts.map((f) => f.name),
    ),
  };

  const asked = await ask(
    ctx,
    profile,
    rule,
    output,
    parts,
    sources,
    questions,
    evidence,
  );
  if ('done' in asked) return asked.done;
  const { answers, usage } = asked;
  const { thresholds } = profile;

  const findings = [...plan.findings];
  for (const c of plan.committed) {
    const values = committedValues(c, answers, thresholds, findings);
    if (!values) continue;
    findings.push(...floorFindings(c, values, plan, sources, hiddenLayers));
    const semantic = semanticFinding(c, values, answers, thresholds);
    if (semantic) findings.push(semantic);
  }

  const faithful = answers.noul.get(CONDUCT_QUESTION_IDS.faithful);
  if (faithful !== undefined && faithful < thresholds.blockBelow) {
    findings.push({
      type: 'unfaithful_action',
      level: 'enforcing',
      confidence: 1 - faithful,
      message: `the output is not a faithful execution of the input (faithful p=${p2(faithful)})`,
      question: CONDUCT_QUESTION_IDS.faithful,
      p: faithful,
    });
  }

  if (!findings.some((f) => f.level === 'enforcing')) {
    const injection = injectionFinding(answers, thresholds);
    if (injection) findings.push(injection);
  }
  return withUsage(
    result(ctx, rule, enforcingFirstFindings(findings), evidence),
    usage,
  );
}

function enforcingFirstFindings(findings: Finding[]): Finding[] {
  return [
    ...findings.filter((f) => f.level === 'enforcing'),
    ...findings.filter((f) => f.level === 'note'),
  ];
}

// ── limit ──────────────────────────────────────────────────────────

/** How one fact of a limit check is read, decided before asking. */
interface LimitFact {
  fact: AgentConductFact;
  /** Read from a structured parameter, without the model. */
  value?: number;
  /** Read by the model: the choice question's id. */
  question?: string;
  /** Why it can't be read, when that is known before asking. */
  problem?: string;
  /** Whether the value comes from the output's text. */
  fromText: boolean;
}

/** A number as a limit's message shows it. */
function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/**
 * Each fact's reading: a tool call's parameter, or a choice among the
 * numbers the output's text states.
 */
function planLimit(
  rule: AgentConductOutputRule,
  output: AgentOutput,
  questions: Record<string, QuestionSpec>,
): LimitFact[] {
  return rule.facts.map((fact): LimitFact => {
    if (output.kind === 'tool' && output.params && fact.param !== undefined) {
      const raw = output.params[fact.param];
      const value = parseNumeric(raw);
      return value === null
        ? {
            fact,
            fromText: false,
            problem:
              raw === undefined || raw === null
                ? `${fact.name}: parameter "${fact.param}" is missing from the ${output.target} call`
                : `${fact.name}: parameter "${fact.param}" is not a number`,
          }
        : { fact, value, fromText: false };
    }
    const stated = candidatesFor(factSpec(fact), [outputAsPart(output)]);
    if (stated.length === 0) {
      return {
        fact,
        fromText: true,
        problem: `${fact.name}: the output states no ${fact.name}`,
      };
    }
    const id = CONDUCT_QUESTION_IDS.committed(fact.name);
    questions[id] = {
      type: 'choice',
      instructions: committedNumberQuestion(fact.name),
      criteria: valueCriteria(stated, 'output', {
        [NONE_OPTION]: `the output states no ${fact.name} it commits to or instructs`,
      }),
    };
    return { fact, question: id, fromText: true };
  });
}

/** One fact's value from the model's choice, or a finding. */
function chosenValue(
  planned: LimitFact,
  answers: NormalizedAnswers | undefined,
  thresholds: AgentConductProfile['thresholds'],
  findings: Finding[],
): number | undefined {
  const { fact } = planned;
  if (planned.problem !== undefined) {
    findings.push(enforcing('limit_unreadable', planned.problem));
    return undefined;
  }
  if (planned.question === undefined) return planned.value;
  const answer = answers?.choice.get(planned.question);
  const at = { question: planned.question, p: answer?.p };
  if (!answer || answer.choice === NONE_OPTION) {
    findings.push({
      ...enforcing(
        'limit_unreadable',
        `${fact.name}: the output commits to no ${fact.name}${answer ? ` (p=${p2(answer.p)})` : ''}`,
      ),
      ...at,
    });
    return undefined;
  }
  if (answer.p < thresholds.blockBelow) {
    findings.push({
      ...enforcing(
        'limit_unreadable',
        `${fact.name}: the output's ${fact.name} reads as ${answer.choice} only with p=${p2(answer.p)}`,
      ),
      ...at,
    });
    return undefined;
  }
  if (answer.p < thresholds.flagBelow) {
    findings.push({
      type: 'low_confidence',
      level: 'note',
      confidence: answer.p,
      message: `${fact.name}: the output's ${fact.name} reads as ${answer.choice} only with p=${p2(answer.p)}`,
      ...at,
    });
  }
  return parseNumeric(answer.choice) ?? undefined;
}

/** Every limit on the values read and computed, as findings. */
function limitFindings(
  rule: AgentConductOutputRule,
  values: Map<string, { value: number; text: string }>,
): Finding[] {
  const out: Finding[] = [];
  for (const [name, bound] of Object.entries(rule.limits ?? {})) {
    const read = values.get(name);
    if (!read) continue;
    const shown =
      read.text === `${name} ${formatNumber(read.value)}`
        ? read.text
        : `${name} (${read.text} = ${formatNumber(read.value)})`;
    if (bound.max !== undefined && read.value > bound.max) {
      out.push(
        enforcing(
          'limit_exceeded',
          `${shown} is over the limit of ${formatNumber(bound.max)}`,
        ),
      );
    }
    if (bound.min !== undefined && read.value < bound.min) {
      out.push(
        enforcing(
          'limit_exceeded',
          `${shown} is under the minimum of ${formatNumber(bound.min)}`,
        ),
      );
    }
  }
  return out;
}

/**
 * The limit check (internal design notes). The model, when
 * asked, sees only the owner's description and the output, and answers
 * whether the output commits to a transaction and which stated number is
 * each fact. A value the output does not state can't be chosen; the totals
 * and the comparison are code. An output that commits to a transaction but
 * whose values can't be read is blocked, never let through.
 */
async function evaluateLimit(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  rule: AgentConductOutputRule,
  output: AgentOutput,
  evidence: Evidence,
): Promise<PolicyEngineResult> {
  const questions: Record<string, QuestionSpec> = {};
  const planned = planLimit(rule, output, questions);
  const limitEvidence: Evidence = {
    facts: planned.map((f) => ({
      name: f.fact.name,
      read: f.fromText ? 'text' : 'parameter',
      ...(f.value !== undefined ? { value: f.value } : {}),
      ...(f.problem !== undefined ? { problem: f.problem } : {}),
    })),
    computed: rule.computed ?? {},
    limits: rule.limits ?? {},
  };
  evidence.limit = limitEvidence;

  let asked: Asked | undefined;
  if (planned.some((f) => f.fromText)) {
    const reply = await askLimit(
      ctx,
      profile,
      rule,
      output,
      questions,
      evidence,
    );
    if ('done' in reply) return reply.done;
    asked = reply;
    const commits = asked.answers.noul.get(
      CONDUCT_QUESTION_IDS.commitsTransaction,
    );
    limitEvidence.commits = commits;
    if (commits !== undefined && commits < profile.thresholds.blockBelow) {
      // Not a transaction (a question, a report, a step on an order already
      // placed): the limits have nothing to read.
      limitEvidence.applied = false;
      return withUsage(result(ctx, rule, [], evidence), asked.usage);
    }
  }
  limitEvidence.applied = true;
  const findings = applyLimits(
    rule,
    planned,
    asked?.answers,
    profile.thresholds,
    limitEvidence,
  );
  return withUsage(
    result(ctx, rule, enforcingFirstFindings(findings), evidence),
    asked?.usage,
  );
}

/** Ask the gate and the facts read from the output's text. */
async function askLimit(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  rule: AgentConductOutputRule,
  output: AgentOutput,
  questions: Record<string, QuestionSpec>,
  evidence: Evidence,
): Promise<Asked | { done: PolicyEngineResult }> {
  Object.assign(questions, LIMIT_QUESTIONS);
  evidence.requestedModel = profile.model;
  evidence.questions = questions;
  const { state, overBudget } = buildLimitState({
    profile,
    rule,
    output,
    budgetChars: stateBudgetChars(getDecisionModel(profile.model), 0),
  });
  evidence.stateChars = state.length;
  if (overBudget) {
    return { done: overBudgetResult(ctx, profile, rule, evidence) };
  }
  return askModel(
    ctx,
    profile,
    rule,
    { state, images: [] },
    questions,
    evidence,
  );
}

/**
 * Each fact's value, then the computed values, then the limits, as
 * findings. A fact that can't be read leaves every limit unknown, so it is
 * the finding and nothing is computed: the check fails closed.
 */
function applyLimits(
  rule: AgentConductOutputRule,
  planned: readonly LimitFact[],
  answers: NormalizedAnswers | undefined,
  thresholds: AgentConductProfile['thresholds'],
  limitEvidence: Evidence,
): Finding[] {
  const findings: Finding[] = [];
  const facts: Record<string, number> = {};
  for (const f of planned) {
    const value = chosenValue(f, answers, thresholds, findings);
    if (value !== undefined) facts[f.fact.name] = value;
  }
  limitEvidence.values = facts;
  if (findings.some((f) => f.level === 'enforcing')) return findings;

  const values = new Map<string, { value: number; text: string }>(
    Object.entries(facts).map(([name, value]) => [
      name,
      { value, text: `${name} ${formatNumber(value)}` },
    ]),
  );
  const computedEvidence: Evidence = {};
  for (const [name, computed] of computeValues(rule.computed ?? {}, facts)) {
    if (computed.ok) {
      values.set(name, { value: computed.value, text: computed.text });
      computedEvidence[name] = { value: computed.value, text: computed.text };
    } else {
      computedEvidence[name] = { problem: computed.reason };
      findings.push(
        enforcing(
          'limit_unreadable',
          `${name} could not be computed: ${computed.reason}`,
        ),
      );
    }
  }
  limitEvidence.computedValues = computedEvidence;
  findings.push(...limitFindings(rule, values));
  return findings;
}

// ── judge ──────────────────────────────────────────────────────────

const FUNCTION_VERB: Record<OutputFunction, string> = {
  instructs: 'instructs someone to carry out',
  commits: 'commits to',
  reports: 'reports',
  informs: 'reports as done',
  other: 'states',
};

/** The judge's findings and their bands (design §5.2). */
export function judgeFindings(
  answers: NormalizedAnswers,
  thresholds: AgentConductProfile['thresholds'],
): Finding[] {
  const findings: Finding[] = [];
  const fn = (answers.choice.get(CONDUCT_QUESTION_IDS.function)?.choice ??
    'other') as OutputFunction;
  const p = (id: string) => answers.noul.get(id);

  const termsMatch = p(CONDUCT_QUESTION_IDS.termsMatch);
  if (
    (fn === 'instructs' || fn === 'commits' || fn === 'informs') &&
    termsMatch !== undefined &&
    termsMatch < thresholds.flagBelow
  ) {
    findings.push({
      type: 'commits_unintended_terms',
      level: band(termsMatch, thresholds),
      confidence: 1 - termsMatch,
      message: `The output ${FUNCTION_VERB[fn]} order terms the input does not intend (terms_match p=${p2(termsMatch)}).`,
      question: CONDUCT_QUESTION_IDS.termsMatch,
      p: termsMatch,
    });
  }
  const high = (id: string, type: string, sentence: string) => {
    const v = p(id);
    if (v === undefined || v < thresholds.blockBelow) return;
    findings.push({
      type,
      level: v >= thresholds.flagBelow ? 'enforcing' : 'note',
      confidence: v,
      message: `${sentence} (p=${p2(v)}).`,
      question: id,
      p: v,
    });
  };
  high(
    CONDUCT_QUESTION_IDS.presentsUnverified,
    'presents_unverified_value',
    'The output presents a value from an unverified part of the input as if it were agreed',
  );
  high(
    CONDUCT_QUESTION_IDS.followsDocumentInstruction,
    'follows_document_instruction',
    'The output carries out an instruction found inside received content',
  );
  const role = p(CONDUCT_QUESTION_IDS.withinRole);
  if (role !== undefined && role < thresholds.flagBelow) {
    findings.push({
      type: 'outside_role',
      level: band(role, thresholds),
      confidence: 1 - role,
      message: `The output is outside the agent's role as its owner describes it (within_role p=${p2(role)}).`,
      question: CONDUCT_QUESTION_IDS.withinRole,
      p: role,
    });
  }
  const discloses = p(CONDUCT_QUESTION_IDS.disclosesConflict);
  const conflict = answers.noul.get('injection.conflicts_with_quote');
  if (
    discloses !== undefined &&
    discloses < thresholds.blockBelow &&
    conflict !== undefined &&
    conflict >= thresholds.blockBelow
  ) {
    findings.push({
      type: 'silent_conflict',
      level: 'note',
      confidence: 1 - discloses,
      message: `The input states conflicting terms and the output does not mention the conflict (discloses_conflict p=${p2(discloses)}).`,
      question: CONDUCT_QUESTION_IDS.disclosesConflict,
      p: discloses,
    });
  }
  return enforcingFirstFindings(findings);
}

async function evaluateJudge(
  ctx: PolicyEvalContext,
  profile: AgentConductProfile,
  rule: AgentConductOutputRule,
  output: AgentOutput,
  parts: readonly SessionPart[],
  evidence: Evidence,
): Promise<PolicyEngineResult> {
  const received = receivedParts(parts, ctx.agentId);
  const asked = await ask(
    ctx,
    profile,
    rule,
    output,
    parts,
    received,
    judgeQuestions(),
    evidence,
  );
  if ('done' in asked) return asked.done;
  // The input questions are evidence only on a judge output: its own
  // findings cover a misused injection, and an honest heads-up that reports
  // one must not be flagged for it.
  return withUsage(
    result(
      ctx,
      rule,
      judgeFindings(asked.answers, profile.thresholds),
      evidence,
    ),
    asked.usage,
  );
}
