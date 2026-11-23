// SPDX-License-Identifier: Apache-2.0

/**
 * Config readers for the two session policy types, `session-invariant` and
 * `semantic-consistency` (internal design notes).
 *
 * Hand-written, typed readers rather than a schema library: an unknown key is
 * refused, and the first problem is reported by key so the engine can name it
 * in a `config_invalid` detection. Parsed configs are cached per config
 * object, so a binding's fact patterns compile once.
 */

import {
  DECISION_MODEL_IDS,
  DEFAULT_DECISION_MODEL_ID,
  type DecisionModelId,
} from '../session/decision-model';
import {
  DEFAULT_DOCUMENT_READER_ID,
  DOCUMENT_READER_IDS,
  type DocumentReaderId,
} from '../session/document-extractor';
import {
  SESSION_FACT_KINDS,
  SESSION_LEGS,
  type SessionFactKind,
  type SessionLeg,
} from '../session/types';
import { safeRegex } from './builtin-engine';

/**
 * Whose parts count as sources. `counterparty` is the sender of the first
 * `message:inbound` part in the session; `any` is every producer; any other
 * string names one agent. The filter applies to the legs another agent
 * produces (`message:inbound`, `document`); the agent's own legs pass it.
 */
export type SourcesFrom =
  | { kind: 'any' }
  | { kind: 'counterparty' }
  | { kind: 'agent'; agentId: string };

export interface FactSpec {
  name: string;
  param: string;
  kind: SessionFactKind;
  /** Whole-token pattern for identifier candidates. */
  pattern?: RegExp;
  patternSource?: string;
}

export type MissingSource = 'flag' | 'block' | 'allow';

interface CommonConfig {
  /** Exact tool name, or `*` for every tool. */
  tool: string;
  facts: FactSpec[];
  sources: SessionLeg[];
  sourcesFrom: SourcesFrom;
  missingSource: MissingSource;
}

export interface SessionInvariantConfig extends CommonConfig {
  rule: 'present_in_sources';
}

export interface SemanticConsistencyConfig extends CommonConfig {
  /** A decision-model registry id; `DEFAULT_DECISION_MODEL_ID` when omitted. */
  model: DecisionModelId;
  /**
   * A document-reader registry id (the OCR model for page images);
   * `DEFAULT_DOCUMENT_READER_ID` when omitted. Read at ingest, not when the
   * policy is evaluated: a document is read once, for every policy on the
   * receiving agent's ledger.
   */
  reader: DocumentReaderId;
  checks: { injection: boolean; ambiguity: boolean; faithful: boolean };
  thresholds: { blockBelow: number; flagBelow: number };
}

export type ConfigResult<T> =
  | { ok: true; config: T }
  | { ok: false; key: string; problem: string };

const MAX_FACTS = 16;
/** safeRegex refuses patterns over 256 characters; the anchors add 8. */
const MAX_PATTERN_CHARS = 240;
const FACT_NAME = /^[A-Za-z0-9_]{1,64}$/;
const NOT_YET_SUPPORTED_RULES = new Set(['equals_fact', 'unchanged']);

class ConfigProblem extends Error {
  constructor(
    readonly key: string,
    readonly problem: string,
  ) {
    super(`${key}: ${problem}`);
  }
}

function fail(key: string, problem: string): never {
  throw new ConfigProblem(key, problem);
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
  if (typeof value !== 'string' || value.length === 0) {
    fail(key, 'must be a non-empty string');
  }
  if (value.length > max) fail(key, `must be at most ${max} characters`);
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(key, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function readTool(value: unknown): string {
  if (!isRecord(value)) fail('on', 'must be an object with a tool');
  onlyKeys(value, ['tool'], 'on');
  return readString(value.tool, 'on.tool', 128);
}

function readFacts(value: unknown, options: { semantic: boolean }): FactSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('facts', 'must be a non-empty array');
  }
  if (value.length > MAX_FACTS) {
    fail('facts', `must have at most ${MAX_FACTS} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const fact = readFact(entry, `facts[${i}]`, options);
    if (seen.has(fact.name)) {
      fail(`facts[${i}].name`, `duplicate fact "${fact.name}"`);
    }
    seen.add(fact.name);
    return fact;
  });
}

/**
 * An identifier fact's pattern. It judges one whole token, so it is wrapped
 * in anchors whatever its author wrote, and ignores case because identifiers
 * compare case-folded. safeRegex refuses invalid and catastrophic patterns.
 */
function readPattern(value: unknown, path: string): RegExp {
  const source = readString(value, path, MAX_PATTERN_CHARS);
  const pattern = safeRegex(`^(?:${source})$`, 'iu');
  if (!pattern) fail(path, 'is not a safe regular expression');
  return pattern;
}

function readFact(
  entry: unknown,
  path: string,
  options: { semantic: boolean },
): FactSpec {
  if (!isRecord(entry)) fail(path, 'must be an object');
  onlyKeys(entry, ['name', 'param', 'kind', 'pattern'], path);
  const name = readString(entry.name, `${path}.name`, 64);
  if (!FACT_NAME.test(name)) {
    fail(`${path}.name`, 'must be letters, digits and underscores');
  }
  const param = readString(entry.param, `${path}.param`, 128);
  const kind = readEnum(entry.kind, `${path}.kind`, SESSION_FACT_KINDS);
  const fact: FactSpec = { name, param, kind };
  if (entry.pattern !== undefined) {
    if (kind !== 'identifier') {
      fail(`${path}.pattern`, 'applies to identifier facts only');
    }
    fact.pattern = readPattern(entry.pattern, `${path}.pattern`);
    fact.patternSource = entry.pattern as string;
  }
  if (options.semantic && kind === 'text') {
    fail(
      `${path}.kind`,
      'text facts are checked by session-invariant only (the semantic check needs candidate values)',
    );
  }
  if (options.semantic && kind === 'identifier' && !fact.pattern) {
    fail(
      `${path}.pattern`,
      'is required for an identifier fact in semantic-consistency',
    );
  }
  return fact;
}

function readSources(value: unknown): SessionLeg[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('sources', 'must be a non-empty array of legs');
  }
  const legs = value.map((leg, i) =>
    readEnum(leg, `sources[${i}]`, SESSION_LEGS),
  );
  if (new Set(legs).size !== legs.length) {
    fail('sources', 'must not repeat a leg');
  }
  return legs;
}

function readSourcesFrom(value: unknown): SourcesFrom {
  if (value === undefined || value === 'any') return { kind: 'any' };
  if (value === 'counterparty') return { kind: 'counterparty' };
  return { kind: 'agent', agentId: readString(value, 'sources_from', 256) };
}

function readMissingSource(value: unknown): MissingSource {
  if (value === undefined) return 'flag';
  return readEnum(value, 'missing_source', ['flag', 'block', 'allow'] as const);
}

function readProbability(value: unknown, key: string, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
    fail(key, 'must be a number from 0 to 1');
  }
  return value;
}

function readBoolean(value: unknown, key: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') fail(key, 'must be true or false');
  return value;
}

function readCommon(
  config: Record<string, unknown>,
  semantic: boolean,
): CommonConfig {
  return {
    tool: readTool(config.on),
    facts: readFacts(config.facts, { semantic }),
    sources: readSources(config.sources),
    sourcesFrom: readSourcesFrom(config.sources_from),
    missingSource: readMissingSource(config.missing_source),
  };
}

function parse<T>(
  config: unknown,
  read: (config: Record<string, unknown>) => T,
): ConfigResult<T> {
  try {
    if (!isRecord(config)) fail('config', 'must be an object');
    return { ok: true, config: read(config) };
  } catch (err) {
    if (err instanceof ConfigProblem) {
      return { ok: false, key: err.key, problem: err.problem };
    }
    throw err;
  }
}

const INVARIANT_KEYS = [
  'on',
  'facts',
  'sources',
  'sources_from',
  'rule',
  'missing_source',
] as const;

const SEMANTIC_KEYS = [
  'model',
  'reader',
  'on',
  'facts',
  'sources',
  'sources_from',
  'checks',
  'thresholds',
  'missing_source',
] as const;

export function readSessionInvariantConfig(
  config: unknown,
): ConfigResult<SessionInvariantConfig> {
  return parse(config, (c) => {
    onlyKeys(c, INVARIANT_KEYS, '');
    const common = readCommon(c, false);
    const rule = c.rule ?? 'present_in_sources';
    if (typeof rule === 'string' && NOT_YET_SUPPORTED_RULES.has(rule)) {
      fail('rule', `"${rule}" is not supported yet; use present_in_sources`);
    }
    if (rule !== 'present_in_sources') {
      fail('rule', 'must be present_in_sources');
    }
    return { ...common, rule };
  });
}

export function readSemanticConsistencyConfig(
  config: unknown,
): ConfigResult<SemanticConsistencyConfig> {
  return parse(config, (c) => {
    onlyKeys(c, SEMANTIC_KEYS, '');
    const model =
      c.model === undefined
        ? DEFAULT_DECISION_MODEL_ID
        : readEnum(c.model, 'model', DECISION_MODEL_IDS);
    const reader =
      c.reader === undefined
        ? DEFAULT_DOCUMENT_READER_ID
        : readEnum(c.reader, 'reader', DOCUMENT_READER_IDS);
    const common = readCommon(c, true);
    const checksValue = c.checks ?? {};
    if (!isRecord(checksValue)) fail('checks', 'must be an object');
    onlyKeys(checksValue, ['injection', 'ambiguity', 'faithful'], 'checks');
    const thresholdsValue = c.thresholds ?? {};
    if (!isRecord(thresholdsValue)) fail('thresholds', 'must be an object');
    onlyKeys(thresholdsValue, ['block_below', 'flag_below'], 'thresholds');
    const blockBelow = readProbability(
      thresholdsValue.block_below,
      'thresholds.block_below',
      0.5,
    );
    const flagBelow = readProbability(
      thresholdsValue.flag_below,
      'thresholds.flag_below',
      0.85,
    );
    if (blockBelow > flagBelow) {
      fail('thresholds', 'block_below must not exceed flag_below');
    }
    return {
      ...common,
      model,
      reader,
      checks: {
        injection: readBoolean(checksValue.injection, 'checks.injection'),
        ambiguity: readBoolean(checksValue.ambiguity, 'checks.ambiguity'),
        faithful: readBoolean(checksValue.faithful, 'checks.faithful'),
      },
      thresholds: { blockBelow, flagBelow },
    };
  });
}

const invariantCache = new WeakMap<
  object,
  ConfigResult<SessionInvariantConfig>
>();
const semanticCache = new WeakMap<
  object,
  ConfigResult<SemanticConsistencyConfig>
>();

function cached<T>(
  cache: WeakMap<object, ConfigResult<T>>,
  config: unknown,
  read: (config: unknown) => ConfigResult<T>,
): ConfigResult<T> {
  if (!isRecord(config)) return read(config);
  let result = cache.get(config);
  if (!result) {
    result = read(config);
    cache.set(config, result);
  }
  return result;
}

export function sessionInvariantConfig(
  config: unknown,
): ConfigResult<SessionInvariantConfig> {
  return cached(invariantCache, config, readSessionInvariantConfig);
}

export function semanticConsistencyConfig(
  config: unknown,
): ConfigResult<SemanticConsistencyConfig> {
  return cached(semanticCache, config, readSemanticConsistencyConfig);
}
