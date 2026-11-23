// SPDX-License-Identifier: Apache-2.0

/**
 * The `agent-conduct` profile (internal design notes): the
 * owner's description of an agent, and how each kind of output it makes is
 * checked.
 *
 * One reader for both places that read a profile: the Verifier's engine,
 * which reads a binding's config at evaluation, and management's creation
 * and patch schemas, which refuse at save what the engine would refuse. Both
 * call `readAgentConductProfile`, so they refuse the same profiles with the
 * same words. Each caller passes its own regular-expression guard, since the
 * Verifier and management already have one each.
 *
 * Hand-written rather than a schema library: an unknown key is refused, and
 * the first problem is reported by key (`outputs[1].facts`) so a person can
 * find it.
 */

import {
  MAX_EXPRESSION_LENGTH,
  expressionNames,
  parseExpression,
} from './computed-values';
import {
  AGENT_CONDUCT_MODEL_IDS,
  DECISION_MODEL_IDS,
  DEFAULT_DECISION_MODEL_ID,
  DEFAULT_DOCUMENT_READER_ID,
  DOCUMENT_READER_IDS,
  type DecisionModelId,
  type DocumentReaderId,
} from './policy-types';

/** How far the owner trusts a producer of the agent's input. */
export const AGENT_CONDUCT_TRUST_LEVELS = [
  'authoritative',
  'external',
  'untrusted',
] as const;
export type AgentConductTrust = (typeof AGENT_CONDUCT_TRUST_LEVELS)[number];

/**
 * How an output is checked:
 *   exact  its committed values must trace back to the input
 *   judge  the decision model judges what it does
 *   limit  the values it commits to must stay within the owner's limits
 *          (internal design notes)
 *   ignore not checked
 */
export const AGENT_CONDUCT_CHECKS = [
  'exact',
  'judge',
  'limit',
  'ignore',
] as const;
export type AgentConductCheck = (typeof AGENT_CONDUCT_CHECKS)[number];

/** What an enforcing finding on an output does. */
export const AGENT_CONDUCT_EFFECTS = ['flag', 'block'] as const;
export type AgentConductEffect = (typeof AGENT_CONDUCT_EFFECTS)[number];

/** The kinds of value an `exact` check traces. */
export const AGENT_CONDUCT_FACT_KINDS = [
  'identifier',
  'number',
  'money',
] as const;
export type AgentConductFactKind = (typeof AGENT_CONDUCT_FACT_KINDS)[number];

/**
 * The transports the Verifier observes today, each from one leg:
 *   sdk-tool      a tool call through the TS SDK (`/v1/tools/check`)
 *   a2a           a message to another Spellguard agent (`/messages/send`)
 *   reply         the agent's reply to a message it received
 *   a2a-external  a message to an outside A2A agent (`/messages/unilateral`)
 */
export const AGENT_CONDUCT_OBSERVED_CHANNELS = [
  'sdk-tool',
  'a2a',
  'reply',
  'a2a-external',
] as const;

/**
 * Transports the design names that no leg observes yet: plugin tool calls,
 * shell commands and channel messages reach Spellguard through
 * `/v1/mcp/evaluate`, which has no session (design §8, phase 3). A profile
 * that names one is refused, so no check is configured that never runs.
 */
export const AGENT_CONDUCT_UNOBSERVED_CHANNELS = [
  'mcp',
  'shell',
  'slack',
  'teams',
  'discord',
  'email',
] as const;

export const AGENT_CONDUCT_CHANNELS = [
  ...AGENT_CONDUCT_OBSERVED_CHANNELS,
  ...AGENT_CONDUCT_UNOBSERVED_CHANNELS,
] as const;
export type AgentConductChannel = (typeof AGENT_CONDUCT_CHANNELS)[number];

export const AGENT_CONDUCT_LIMITS = {
  roleChars: 2_000,
  sources: 32,
  fromChars: 256,
  relationshipChars: 500,
  outputs: 32,
  meaningChars: 500,
  toolChars: 128,
  targetChars: 256,
  commandChars: 256,
  facts: 16,
  factNameChars: 64,
  paramChars: 128,
  /** The guards refuse patterns over 256 characters; the anchors add 8. */
  patternChars: 240,
  watchFor: 10,
  watchForChars: 300,
  /** A limit check's computed values, and the expression of each. */
  computed: 8,
  expressionChars: MAX_EXPRESSION_LENGTH,
  /** A limit check's limits. */
  limits: 16,
} as const;

/** The default thresholds, as for `semantic-consistency`. */
export const AGENT_CONDUCT_DEFAULT_THRESHOLDS = {
  blockBelow: 0.5,
  flagBelow: 0.85,
} as const;

/**
 * The refusals a person is most likely to meet, worded so they can act on
 * them. Shared by the Verifier's reader and management's schema.
 */
export const AGENT_CONDUCT_PROBLEMS = {
  roleRequired:
    'is required: describe in plain words what the agent is for and what it may do',
  roleTooLong: `must be at most ${AGENT_CONDUCT_LIMITS.roleChars} characters`,
  modelNotOffered: (id: string) =>
    `"${id}" is not offered for agent-conduct; use clef. Clef Flash let attacks through and flagged honest messages when measured`,
  factsRequired:
    'is required for an exact check: list the values that must trace back to what the agent received',
  limitFactsRequired:
    'is required for a limit check: list the numbers the limits read, such as the quantity and the unit price',
  limitFactsAreNumbers:
    'must be number or money for a limit check: a limit reads numbers',
  factsOnlyForExact: 'apply to exact and limit checks only',
  limitsRequired:
    'is required for a limit check: name each value to limit and its min or max, for example { "order_total": { "max": 50000 } }',
  onlyForLimit: 'applies to limit checks only',
  unsafePattern: 'is not a safe regular expression',
  trust: `must be one of ${AGENT_CONDUCT_TRUST_LEVELS.join(', ')}`,
  unobservedChannel: (channel: string) =>
    `"${channel}" is not observed yet: agent-conduct sees outputs on ${AGENT_CONDUCT_OBSERVED_CHANNELS.join(', ')}. A Slack or email tool the agent calls through the SDK is matched by its tool name`,
  unobservedCommand:
    'is not observed yet: shell commands reach Spellguard only through plugins, which agent-conduct does not see yet',
} as const;

export interface AgentConductFact {
  name: string;
  /**
   * The tool parameter that holds the value. When the output has no such
   * parameter (a message, or a tool whose value sits in free text), the
   * value is read from the output's text.
   */
  param?: string;
  kind: AgentConductFactKind;
  /** Whole-token pattern, anchored and case-insensitive. */
  pattern?: RegExp;
  patternSource?: string;
}

export type AgentConductMatch =
  | '*'
  | {
      tool?: string;
      channel?: AgentConductChannel;
      target?: string;
      /** Not observed yet (phase 3); kept so a fixture can name it. */
      commandContains?: string;
    };

/** A bound on one value a limit check reads or computes. */
export interface AgentConductLimit {
  min?: number;
  max?: number;
}

export interface AgentConductOutputRule {
  match: AgentConductMatch;
  meaning?: string;
  check: AgentConductCheck;
  facts: AgentConductFact[];
  /**
   * A limit check's computed values, by name: arithmetic over its facts
   * (`quantity * unit_price`). Absent on other checks.
   */
  computed?: Record<string, string>;
  /** A limit check's bounds, on facts or computed values. Absent on others. */
  limits?: Record<string, AgentConductLimit>;
  /** The effect, defaults applied: block for exact and limit, flag for judge. */
  effect: AgentConductEffect;
}

export interface AgentConductSource {
  from: string;
  relationship: string;
  trust: AgentConductTrust;
}

export interface AgentConductProfile {
  model: DecisionModelId;
  reader: DocumentReaderId;
  role: string;
  sources: AgentConductSource[];
  outputs: AgentConductOutputRule[];
  watchFor: string[];
  thresholds: { blockBelow: number; flagBelow: number };
}

export type AgentConductReadResult =
  | { ok: true; profile: AgentConductProfile }
  | { ok: false; key: string; problem: string };

/**
 * Compiles a fact pattern the way the caller's engine will (anchored,
 * case-insensitive), or returns undefined when the pattern is unsafe.
 */
export type PatternCompiler = (source: string) => RegExp | undefined;

/** The keys a profile may carry. */
export const AGENT_CONDUCT_KEYS = [
  'model',
  'reader',
  'role',
  'sources',
  'outputs',
  'watch_for',
  'thresholds',
] as const;

class ProfileProblem extends Error {
  constructor(
    readonly key: string,
    readonly problem: string,
  ) {
    super(`${key}: ${problem}`);
  }
}

function fail(key: string, problem: string): never {
  throw new ProfileProblem(key, problem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(path ? `${path}.${key}` : key, 'unknown key');
    }
  }
}

function readString(value: unknown, key: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(key, 'must be a non-empty string');
  }
  if (value.length > max) fail(key, `must be at most ${max} characters`);
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  problem = `must be one of ${allowed.join(', ')}`,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(key, problem);
  }
  return value as T;
}

function readArray(value: unknown, key: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(key, 'must be an array');
  if (value.length > max) fail(key, `must have at most ${max} entries`);
  return value;
}

function readProbability(value: unknown, key: string, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
    fail(key, 'must be a number from 0 to 1');
  }
  return value;
}

function readModel(value: unknown): DecisionModelId {
  if (value === undefined) return DEFAULT_DECISION_MODEL_ID;
  if (
    typeof value === 'string' &&
    (DECISION_MODEL_IDS as readonly string[]).includes(value) &&
    !(AGENT_CONDUCT_MODEL_IDS as readonly string[]).includes(value)
  ) {
    fail('model', AGENT_CONDUCT_PROBLEMS.modelNotOffered(value));
  }
  return readEnum(value, 'model', AGENT_CONDUCT_MODEL_IDS);
}

function readRole(value: unknown): string {
  if (value === undefined || value === null) {
    fail('role', AGENT_CONDUCT_PROBLEMS.roleRequired);
  }
  if (typeof value !== 'string') fail('role', 'must be a string');
  if (value.trim().length === 0) {
    fail('role', AGENT_CONDUCT_PROBLEMS.roleRequired);
  }
  if (value.length > AGENT_CONDUCT_LIMITS.roleChars) {
    fail('role', AGENT_CONDUCT_PROBLEMS.roleTooLong);
  }
  return value;
}

function readSources(value: unknown): AgentConductSource[] {
  if (value === undefined) return [];
  const seen = new Set<string>();
  return readArray(value, 'sources', AGENT_CONDUCT_LIMITS.sources).map(
    (entry, i) => {
      const path = `sources[${i}]`;
      if (!isRecord(entry)) fail(path, 'must be an object');
      onlyKeys(entry, ['from', 'relationship', 'trust'], path);
      const from = readString(
        entry.from,
        `${path}.from`,
        AGENT_CONDUCT_LIMITS.fromChars,
      );
      if (seen.has(from)) fail(`${path}.from`, `duplicate source "${from}"`);
      seen.add(from);
      return {
        from,
        relationship: readString(
          entry.relationship,
          `${path}.relationship`,
          AGENT_CONDUCT_LIMITS.relationshipChars,
        ),
        trust: readEnum(
          entry.trust,
          `${path}.trust`,
          AGENT_CONDUCT_TRUST_LEVELS,
          AGENT_CONDUCT_PROBLEMS.trust,
        ),
      };
    },
  );
}

const FACT_NAME = /^[A-Za-z0-9_]{1,64}$/;

function readFact(
  entry: unknown,
  path: string,
  compile: PatternCompiler,
): AgentConductFact {
  if (!isRecord(entry)) fail(path, 'must be an object');
  onlyKeys(entry, ['name', 'param', 'kind', 'pattern'], path);
  const name = readString(
    entry.name,
    `${path}.name`,
    AGENT_CONDUCT_LIMITS.factNameChars,
  );
  if (!FACT_NAME.test(name)) {
    fail(`${path}.name`, 'must be letters, digits and underscores');
  }
  const kind = readEnum(entry.kind, `${path}.kind`, AGENT_CONDUCT_FACT_KINDS);
  const fact: AgentConductFact = { name, kind };
  if (entry.param !== undefined) {
    fact.param = readString(
      entry.param,
      `${path}.param`,
      AGENT_CONDUCT_LIMITS.paramChars,
    );
  }
  if (entry.pattern !== undefined) {
    if (kind !== 'identifier') {
      fail(`${path}.pattern`, 'applies to identifier facts only');
    }
    const source = readString(
      entry.pattern,
      `${path}.pattern`,
      AGENT_CONDUCT_LIMITS.patternChars,
    );
    const pattern = compile(source);
    if (!pattern) fail(`${path}.pattern`, AGENT_CONDUCT_PROBLEMS.unsafePattern);
    fact.pattern = pattern;
    fact.patternSource = source;
  } else if (kind === 'identifier') {
    fail(
      `${path}.pattern`,
      'is required for an identifier fact: the identifier is read from the output by this pattern',
    );
  }
  return fact;
}

function readFacts(
  value: unknown,
  path: string,
  compile: PatternCompiler,
  required: string = AGENT_CONDUCT_PROBLEMS.factsRequired,
): AgentConductFact[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, required);
  }
  if (value.length > AGENT_CONDUCT_LIMITS.facts) {
    fail(path, `must have at most ${AGENT_CONDUCT_LIMITS.facts} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const fact = readFact(entry, `${path}[${i}]`, compile);
    if (seen.has(fact.name)) {
      fail(`${path}[${i}].name`, `duplicate fact "${fact.name}"`);
    }
    seen.add(fact.name);
    return fact;
  });
}

function readMatch(value: unknown, path: string): AgentConductMatch {
  if (value === '*') return '*';
  if (!isRecord(value)) {
    fail(path, 'must be "*" or an object with tool, channel or target');
  }
  onlyKeys(value, ['tool', 'channel', 'target', 'command_contains'], path);
  const match: Exclude<AgentConductMatch, '*'> = {};
  if (value.tool !== undefined) {
    match.tool = readString(
      value.tool,
      `${path}.tool`,
      AGENT_CONDUCT_LIMITS.toolChars,
    );
  }
  if (value.channel !== undefined) {
    match.channel = readEnum(
      value.channel,
      `${path}.channel`,
      AGENT_CONDUCT_CHANNELS,
    );
  }
  if (value.target !== undefined) {
    match.target = readString(
      value.target,
      `${path}.target`,
      AGENT_CONDUCT_LIMITS.targetChars,
    );
  }
  if (value.command_contains !== undefined) {
    match.commandContains = readString(
      value.command_contains,
      `${path}.command_contains`,
      AGENT_CONDUCT_LIMITS.commandChars,
    );
  }
  if (Object.keys(match).length === 0) {
    fail(path, 'must name at least one of tool, channel or target');
  }
  if (
    match.tool !== undefined &&
    match.channel !== undefined &&
    match.channel !== 'sdk-tool' &&
    match.channel !== 'mcp'
  ) {
    fail(
      `${path}.channel`,
      `a tool call's channel is sdk-tool, so "${match.channel}" never matches a tool`,
    );
  }
  return match;
}

/**
 * A limit check's computed values: each a name that is not a fact's, and an
 * expression over the facts only.
 */
function readComputed(
  value: unknown,
  path: string,
  facts: readonly AgentConductFact[],
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    fail(path, 'must be an object of names and expressions');
  }
  const entries = Object.entries(value);
  if (entries.length > AGENT_CONDUCT_LIMITS.computed) {
    fail(path, `must have at most ${AGENT_CONDUCT_LIMITS.computed} entries`);
  }
  const factNames = facts.map((f) => f.name);
  const computed: Record<string, string> = {};
  for (const [name, expression] of entries) {
    const key = `${path}.${name}`;
    if (!FACT_NAME.test(name)) {
      fail(key, 'must be named with letters, digits and underscores');
    }
    if (factNames.includes(name)) {
      fail(key, `"${name}" is already a fact`);
    }
    const source = readString(
      expression,
      key,
      AGENT_CONDUCT_LIMITS.expressionChars,
    );
    const parsed = parseExpression(source);
    if (typeof parsed === 'string') {
      fail(key, `is not an expression: it ${parsed}`);
    }
    for (const used of expressionNames(parsed)) {
      if (!factNames.includes(used)) {
        fail(key, `uses "${used}", which is not one of this output's facts`);
      }
    }
    computed[name] = source;
  }
  return computed;
}

function readBound(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(key, 'must be a number');
  }
  return value;
}

/** A limit check's bounds: each on a fact or a computed value. */
function readLimits(
  value: unknown,
  path: string,
  names: readonly string[],
): Record<string, AgentConductLimit> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    fail(path, AGENT_CONDUCT_PROBLEMS.limitsRequired);
  }
  const entries = Object.entries(value);
  if (entries.length > AGENT_CONDUCT_LIMITS.limits) {
    fail(path, `must have at most ${AGENT_CONDUCT_LIMITS.limits} entries`);
  }
  const limits: Record<string, AgentConductLimit> = {};
  for (const [name, bound] of entries) {
    const key = `${path}.${name}`;
    if (!names.includes(name)) {
      fail(
        key,
        `"${name}" is not one of this output's facts or computed values`,
      );
    }
    limits[name] = readLimit(bound, key);
  }
  return limits;
}

/** One bound: a min, a max or both, the min not over the max. */
function readLimit(bound: unknown, key: string): AgentConductLimit {
  if (!isRecord(bound)) fail(key, 'must be an object with a min or a max');
  onlyKeys(bound, ['min', 'max'], key);
  const min = readBound(bound.min, `${key}.min`);
  const max = readBound(bound.max, `${key}.max`);
  if (min === undefined && max === undefined) {
    fail(key, 'must have a min or a max');
  }
  if (min !== undefined && max !== undefined && min > max) {
    fail(key, 'min must not exceed max');
  }
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

/** A limit check's facts, computed values and limits. */
function readLimitCheck(
  entry: Record<string, unknown>,
  path: string,
  compile: PatternCompiler,
): Pick<AgentConductOutputRule, 'facts' | 'computed' | 'limits'> {
  const facts = readFacts(
    entry.facts,
    `${path}.facts`,
    compile,
    AGENT_CONDUCT_PROBLEMS.limitFactsRequired,
  );
  for (const [i, fact] of facts.entries()) {
    if (fact.kind === 'identifier') {
      fail(
        `${path}.facts[${i}].kind`,
        AGENT_CONDUCT_PROBLEMS.limitFactsAreNumbers,
      );
    }
  }
  const computed = readComputed(entry.computed, `${path}.computed`, facts);
  const limits = readLimits(entry.limits, `${path}.limits`, [
    ...facts.map((f) => f.name),
    ...Object.keys(computed),
  ]);
  return { facts, computed, limits };
}

/**
 * The fields a check reads: facts for exact; facts, computed values and
 * limits for limit; none for judge and ignore.
 */
function readCheckFields(
  entry: Record<string, unknown>,
  path: string,
  check: AgentConductCheck,
  compile: PatternCompiler,
): Pick<AgentConductOutputRule, 'facts' | 'computed' | 'limits'> {
  if (check === 'limit') return readLimitCheck(entry, path, compile);
  for (const key of ['computed', 'limits'] as const) {
    if (entry[key] !== undefined) {
      fail(`${path}.${key}`, AGENT_CONDUCT_PROBLEMS.onlyForLimit);
    }
  }
  if (check === 'exact') {
    return { facts: readFacts(entry.facts, `${path}.facts`, compile) };
  }
  if (entry.facts !== undefined) {
    fail(`${path}.facts`, AGENT_CONDUCT_PROBLEMS.factsOnlyForExact);
  }
  return { facts: [] };
}

function readOutput(
  entry: unknown,
  path: string,
  compile: PatternCompiler,
): AgentConductOutputRule {
  if (!isRecord(entry)) fail(path, 'must be an object');
  onlyKeys(
    entry,
    ['match', 'meaning', 'check', 'facts', 'computed', 'limits', 'effect'],
    path,
  );
  if (entry.match === undefined) fail(`${path}.match`, 'is required');
  const match = readMatch(entry.match, `${path}.match`);
  const check = readEnum(entry.check, `${path}.check`, AGENT_CONDUCT_CHECKS);
  const rule: AgentConductOutputRule = {
    match,
    check,
    facts: [],
    effect: check === 'judge' || check === 'ignore' ? 'flag' : 'block',
  };
  if (entry.meaning !== undefined) {
    rule.meaning = readString(
      entry.meaning,
      `${path}.meaning`,
      AGENT_CONDUCT_LIMITS.meaningChars,
    );
  }
  Object.assign(rule, readCheckFields(entry, path, check, compile));
  if (entry.effect !== undefined) {
    if (check === 'ignore') {
      fail(`${path}.effect`, 'an ignored output has no effect');
    }
    rule.effect = readEnum(
      entry.effect,
      `${path}.effect`,
      AGENT_CONDUCT_EFFECTS,
    );
  }
  return rule;
}

function readWatchFor(value: unknown): string[] {
  if (value === undefined) return [];
  return readArray(value, 'watch_for', AGENT_CONDUCT_LIMITS.watchFor).map(
    (entry, i) =>
      readString(entry, `watch_for[${i}]`, AGENT_CONDUCT_LIMITS.watchForChars),
  );
}

function readThresholds(value: unknown): AgentConductProfile['thresholds'] {
  const thresholds = value ?? {};
  if (!isRecord(thresholds)) fail('thresholds', 'must be an object');
  onlyKeys(thresholds, ['block_below', 'flag_below'], 'thresholds');
  const blockBelow = readProbability(
    thresholds.block_below,
    'thresholds.block_below',
    AGENT_CONDUCT_DEFAULT_THRESHOLDS.blockBelow,
  );
  const flagBelow = readProbability(
    thresholds.flag_below,
    'thresholds.flag_below',
    AGENT_CONDUCT_DEFAULT_THRESHOLDS.flagBelow,
  );
  if (blockBelow > flagBelow) {
    fail('thresholds', 'block_below must not exceed flag_below');
  }
  return { blockBelow, flagBelow };
}

function readStructure(
  config: Record<string, unknown>,
  compile: PatternCompiler,
): AgentConductProfile {
  onlyKeys(config, AGENT_CONDUCT_KEYS, '');
  const model = readModel(config.model);
  const reader =
    config.reader === undefined
      ? DEFAULT_DOCUMENT_READER_ID
      : readEnum(config.reader, 'reader', DOCUMENT_READER_IDS);
  const role = readRole(config.role);
  const sources = readSources(config.sources);
  const outputs =
    config.outputs === undefined
      ? []
      : readArray(config.outputs, 'outputs', AGENT_CONDUCT_LIMITS.outputs).map(
          (entry, i) => readOutput(entry, `outputs[${i}]`, compile),
        );
  return {
    model,
    reader,
    role,
    sources,
    outputs,
    watchFor: readWatchFor(config.watch_for),
    thresholds: readThresholds(config.thresholds),
  };
}

/** A match no leg observes yet, by key, or undefined. */
function unobservedMatch(
  outputs: readonly AgentConductOutputRule[],
): { key: string; problem: string } | undefined {
  for (const [i, rule] of outputs.entries()) {
    if (rule.match === '*') continue;
    if (rule.match.commandContains !== undefined) {
      return {
        key: `outputs[${i}].match.command_contains`,
        problem: AGENT_CONDUCT_PROBLEMS.unobservedCommand,
      };
    }
    const channel = rule.match.channel;
    if (
      channel !== undefined &&
      !(AGENT_CONDUCT_OBSERVED_CHANNELS as readonly string[]).includes(channel)
    ) {
      return {
        key: `outputs[${i}].match.channel`,
        problem: AGENT_CONDUCT_PROBLEMS.unobservedChannel(channel),
      };
    }
  }
  return undefined;
}

function parse(
  config: unknown,
  read: (config: Record<string, unknown>) => AgentConductProfile,
): AgentConductReadResult {
  try {
    if (!isRecord(config)) fail('config', 'must be an object');
    return { ok: true, profile: read(config) };
  } catch (err) {
    if (err instanceof ProfileProblem) {
      return { ok: false, key: err.key, problem: err.problem };
    }
    throw err;
  }
}

/**
 * The profile's structure, including transports no leg observes yet. Only
 * the measurement fixtures read a profile this way (their cases model the
 * phase 3 legs); every policy goes through `readAgentConductProfile`.
 */
export function readAgentConductStructure(
  config: unknown,
  compile: PatternCompiler,
): AgentConductReadResult {
  return parse(config, (c) => readStructure(c, compile));
}

/**
 * A profile as a policy may carry it: its structure, and only transports a
 * leg observes today.
 */
export function readAgentConductProfile(
  config: unknown,
  compile: PatternCompiler,
): AgentConductReadResult {
  return parse(config, (c) => {
    const profile = readStructure(c, compile);
    const unobserved = unobservedMatch(profile.outputs);
    if (unobserved) fail(unobserved.key, unobserved.problem);
    return profile;
  });
}
