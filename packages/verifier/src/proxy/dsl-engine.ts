// SPDX-License-Identifier: Apache-2.0

/**
 * DSL (Rego subset) policy engine.
 *
 * Evaluates a restricted subset of Rego policy source against the current
 * message context. Designed to be safe for use inside sandboxed runtimes —
 * no eval() or new Function() calls are used.
 */

import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// ─── Tokenizer ─────────────────────────────────────────────────────────────

type TokenKind =
  | 'ident'
  | 'string'
  | 'number'
  | 'bool'
  | 'null'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'dot'
  | 'assign'
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'bang'
  | 'underscore'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    // Skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // Skip comments
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // String literal
    if (ch === '"') {
      i++;
      let str = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          i++;
          const esc = source[i];
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === 'r') str += '\r';
          else str += esc;
        } else {
          str += source[i];
        }
        i++;
      }
      i++; // closing quote
      tokens.push({ kind: 'string', value: str });
      continue;
    }

    // Numbers
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '-' &&
        i + 1 < source.length &&
        source[i + 1] >= '0' &&
        source[i + 1] <= '9')
    ) {
      let num = ch;
      i++;
      while (
        i < source.length &&
        ((source[i] >= '0' && source[i] <= '9') || source[i] === '.')
      ) {
        num += source[i++];
      }
      tokens.push({ kind: 'number', value: num });
      continue;
    }

    // Two-char operators
    if (ch === ':' && source[i + 1] === '=') {
      tokens.push({ kind: 'assign', value: ':=' });
      i += 2;
      continue;
    }
    if (ch === '=' && source[i + 1] === '=') {
      tokens.push({ kind: 'eq', value: '==' });
      i += 2;
      continue;
    }
    if (ch === '!' && source[i + 1] === '=') {
      tokens.push({ kind: 'neq', value: '!=' });
      i += 2;
      continue;
    }
    if (ch === '<' && source[i + 1] === '=') {
      tokens.push({ kind: 'lte', value: '<=' });
      i += 2;
      continue;
    }
    if (ch === '>' && source[i + 1] === '=') {
      tokens.push({ kind: 'gte', value: '>=' });
      i += 2;
      continue;
    }

    // Single-char operators and punctuation
    if (ch === '<') {
      tokens.push({ kind: 'lt', value: '<' });
      i++;
      continue;
    }
    if (ch === '>') {
      tokens.push({ kind: 'gt', value: '>' });
      i++;
      continue;
    }
    if (ch === '!') {
      tokens.push({ kind: 'bang', value: '!' });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: '(' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ')' });
      i++;
      continue;
    }
    if (ch === '[') {
      tokens.push({ kind: 'lbracket', value: '[' });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ kind: 'rbracket', value: ']' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', value: ',' });
      i++;
      continue;
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot', value: '.' });
      i++;
      continue;
    }

    // Underscore (wildcard)
    if (ch === '_') {
      // Check it's just an underscore (not part of an ident)
      const next = source[i + 1];
      if (
        !next ||
        (!(next >= 'a' && next <= 'z') &&
          !(next >= 'A' && next <= 'Z') &&
          !(next >= '0' && next <= '9') &&
          next !== '_')
      ) {
        tokens.push({ kind: 'underscore', value: '_' });
        i++;
        continue;
      }
    }

    // Identifiers / keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let id = '';
      while (
        i < source.length &&
        ((source[i] >= 'a' && source[i] <= 'z') ||
          (source[i] >= 'A' && source[i] <= 'Z') ||
          (source[i] >= '0' && source[i] <= '9') ||
          source[i] === '_' ||
          source[i] === '-')
      ) {
        id += source[i++];
      }
      if (id === 'true') tokens.push({ kind: 'bool', value: 'true' });
      else if (id === 'false') tokens.push({ kind: 'bool', value: 'false' });
      else if (id === 'null') tokens.push({ kind: 'null', value: 'null' });
      else tokens.push({ kind: 'ident', value: id });
      continue;
    }

    // Skip unknown characters (e.g. braces handled at rule extraction level)
    i++;
  }

  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ─── Expression evaluator ───────────────────────────────────────────────────

interface EvalEnv {
  input: Record<string, unknown>;
  vars: Map<string, unknown>;
}

class TokenStream {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'eof', value: '' };
  }

  peekAt(offset: number): Token {
    return this.tokens[this.pos + offset] ?? { kind: 'eof', value: '' };
  }

  consume(): Token {
    return this.tokens[this.pos++] ?? { kind: 'eof', value: '' };
  }

  expect(kind: TokenKind): Token {
    const t = this.consume();
    if (t.kind !== kind) {
      throw new Error(`Expected ${kind}, got ${t.kind} ("${t.value}")`);
    }
    return t;
  }

  is(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }
}

/**
 * Retrieve a value from the environment by dot-path with optional array index.
 * Handles: `input.message`, `input.identity[0]`, `id.provider`, etc.
 */
function resolvePath(
  parts: Array<{ key: string; index?: number | '_' }>,
  env: EvalEnv,
): unknown {
  if (parts.length === 0) return undefined;

  let value: unknown;
  const first = parts[0];

  if (first.key === 'input') {
    value = env.input;
  } else if (env.vars.has(first.key)) {
    value = env.vars.get(first.key);
  } else {
    return undefined;
  }

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object' && !Array.isArray(value)) {
      value = (value as Record<string, unknown>)[part.key];
    } else {
      return undefined;
    }
    if (part.index !== undefined) {
      if (Array.isArray(value)) {
        if (part.index === '_') {
          // Wildcard — return the array itself for iteration
          // handled at condition level
          return value;
        }
        value = (value as unknown[])[part.index as number];
      } else {
        return undefined;
      }
    }
  }

  return value;
}

/**
 * Parse a primary expression from the token stream.
 * Returns the computed value.
 */
function parseExpr(ts: TokenStream, env: EvalEnv): unknown {
  const t = ts.peek();

  // String literal
  if (t.kind === 'string') {
    ts.consume();
    return t.value;
  }

  // Number literal
  if (t.kind === 'number') {
    ts.consume();
    return Number(t.value);
  }

  // Bool literal
  if (t.kind === 'bool') {
    ts.consume();
    return t.value === 'true';
  }

  // Null literal
  if (t.kind === 'null') {
    ts.consume();
    return null;
  }

  // Identifier — could be a built-in call, a variable, or path
  if (t.kind === 'ident') {
    const name = t.value;

    // `not` negation keyword
    if (name === 'not') {
      ts.consume();
      const inner = parseExpr(ts, env);
      return !toBool(inner);
    }

    ts.consume();

    // Check if it's a built-in function call
    if (ts.is('lparen')) {
      return parseBuiltinCall(name, ts, env);
    }

    // Otherwise it's a path (could be dotted, could have array index)
    const parts: Array<{ key: string; index?: number | '_' }> = [{ key: name }];

    while (ts.is('dot')) {
      ts.consume(); // consume '.'
      if (ts.is('ident')) {
        const field = ts.consume().value;
        const part: { key: string; index?: number | '_' } = { key: field };

        // Check for array index
        if (ts.is('lbracket')) {
          ts.consume(); // '['
          if (ts.is('number')) {
            part.index = Number(ts.consume().value);
          } else if (ts.is('underscore')) {
            part.index = '_';
            ts.consume();
          } else if (ts.is('ident')) {
            // Could be a variable name used as index — treat as wildcard
            ts.consume();
            part.index = '_';
          }
          if (ts.is('rbracket')) ts.consume(); // ']'
        }

        parts.push(part);
      }
    }

    // Also handle array index on the identifier itself
    if (ts.is('lbracket') && parts.length === 1) {
      ts.consume(); // '['
      if (ts.is('number')) {
        parts[0].index = Number(ts.consume().value);
      } else if (ts.is('underscore')) {
        parts[0].index = '_';
        ts.consume();
      } else if (ts.is('ident')) {
        ts.consume();
        parts[0].index = '_';
      }
      if (ts.is('rbracket')) ts.consume();
    }

    return resolvePath(parts, env);
  }

  return undefined;
}

/**
 * Parse a built-in function call: name(arg1, arg2, ...)
 */
function parseBuiltinCall(
  name: string,
  ts: TokenStream,
  env: EvalEnv,
): unknown {
  ts.expect('lparen');
  const args: unknown[] = [];

  while (!ts.is('rparen') && !ts.is('eof')) {
    args.push(parseExpr(ts, env));
    if (ts.is('comma')) ts.consume();
  }
  ts.expect('rparen');

  return applyBuiltin(name, args);
}

function applyBuiltin(name: string, args: unknown[]): unknown {
  switch (name) {
    case 'contains': {
      const [str, sub] = args;
      if (typeof str !== 'string' || typeof sub !== 'string') return false;
      return str.includes(sub);
    }
    case 'startswith': {
      const [str, sub] = args;
      if (typeof str !== 'string' || typeof sub !== 'string') return false;
      return str.startsWith(sub);
    }
    case 'endswith': {
      const [str, sub] = args;
      if (typeof str !== 'string' || typeof sub !== 'string') return false;
      return str.endsWith(sub);
    }
    case 'lower': {
      const [str] = args;
      if (typeof str !== 'string') return '';
      return str.toLowerCase();
    }
    case 'upper': {
      const [str] = args;
      if (typeof str !== 'string') return '';
      return str.toUpperCase();
    }
    case 're_match': {
      const [pattern, str] = args;
      if (typeof pattern !== 'string' || typeof str !== 'string') return false;
      if (pattern.length > 512) return false;
      // Reject patterns with nested quantifiers that cause catastrophic backtracking
      if (/(\+|\*|\})\)?(\+|\*|\{)/.test(pattern)) return false;
      try {
        return new RegExp(pattern).test(str);
      } catch {
        return false;
      }
    }
    case 'count': {
      const [coll] = args;
      if (typeof coll === 'string') return coll.length;
      if (Array.isArray(coll)) return coll.length;
      if (coll !== null && typeof coll === 'object')
        return Object.keys(coll as object).length;
      return 0;
    }
    case 'concat': {
      const [sep, arr] = args;
      if (!Array.isArray(arr)) return '';
      const separator = typeof sep === 'string' ? sep : String(sep ?? '');
      return arr.map((x) => String(x ?? '')).join(separator);
    }
    case 'trim': {
      const [str] = args;
      if (typeof str !== 'string') return str;
      return str.trim();
    }
    case 'trim_space': {
      const [str] = args;
      if (typeof str !== 'string') return str;
      return str.trim();
    }
    case 'split': {
      const [str, sep] = args;
      if (typeof str !== 'string' || typeof sep !== 'string') return [];
      return str.split(sep);
    }
    default:
      return undefined;
  }
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// ─── Condition evaluation ───────────────────────────────────────────────────

/**
 * Compare two values with the given operator token kind.
 */
function applyComparison(op: TokenKind, lhs: unknown, rhs: unknown): boolean {
  switch (op) {
    case 'eq':
      return lhs === rhs;
    case 'neq':
      return lhs !== rhs;
    case 'lt':
      return (lhs as number) < (rhs as number);
    case 'lte':
      return (lhs as number) <= (rhs as number);
    case 'gt':
      return (lhs as number) > (rhs as number);
    case 'gte':
      return (lhs as number) >= (rhs as number);
    default:
      return false;
  }
}

const COMPARISON_OPS: Set<TokenKind> = new Set([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
]);

function evalCondition(
  line: string,
  env: EvalEnv,
): { matched: boolean; msg?: string } {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return { matched: true }; // blank / comment lines are no-ops
  }

  const tokens = tokenize(trimmed);
  const ts = new TokenStream(tokens);

  // `some x` — variable declaration, no-op
  if (ts.peek().kind === 'ident' && ts.peek().value === 'some') {
    ts.consume();
    if (ts.is('ident')) {
      env.vars.set(ts.consume().value, undefined);
    }
    return { matched: true };
  }

  // Assignment: `ident := expr`
  // Look-ahead: ident followed by assign token
  if (ts.peek().kind === 'ident' && ts.peekAt(1).kind === 'assign') {
    const varName = ts.consume().value;
    ts.consume(); // ':='
    const value = parseExpr(ts, env);
    env.vars.set(varName, value);
    if (varName === 'msg' && typeof value === 'string') {
      return { matched: true, msg: value };
    }
    return { matched: true };
  }

  // Parse as expression, then optionally a comparison operator + rhs
  const lhs = parseExpr(ts, env);

  if (COMPARISON_OPS.has(ts.peek().kind)) {
    const op = ts.consume().kind;
    const rhs = parseExpr(ts, env);
    return { matched: applyComparison(op, lhs, rhs) };
  }

  // No comparison — treat as boolean expression
  return { matched: toBool(lhs) };
}

// ─── Deny rule extraction ────────────────────────────────────────────────────

interface DenyRule {
  /** Raw lines of the rule body (between { }) */
  bodyLines: string[];
}

/**
 * Count braces in a line, skipping characters inside string literals and
 * after `#` comments so that e.g. `msg := "missing {field}"` does not
 * change the depth counter.
 */
function countBraces(line: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '#') break; // rest of line is a comment
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }

  return depth;
}

/**
 * Extract all `deny[msg] { ... }` rule bodies from the Rego source.
 * Handles multi-line bodies. Ignores `package`, `import`, and `default` lines.
 */
function extractDenyRules(source: string): DenyRule[] {
  const rules: DenyRule[] = [];
  const lines = source.split('\n');

  let inDenyRule = false;
  let depth = 0;
  let bodyLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inDenyRule) {
      // Match `deny[...] {` — start of a deny rule
      if (/^deny\s*\[/.test(trimmed)) {
        inDenyRule = true;
        depth = 0;
        bodyLines = [];
        depth = countBraces(trimmed);
        // If the rule is entirely on one line (depth == 0), extract body
        if (depth === 0) {
          // Single-line rule: deny[msg] { condition }
          const bodyMatch = trimmed.match(/\{(.*)}/);
          if (bodyMatch) {
            bodyLines = bodyMatch[1]
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean);
          }
          rules.push({ bodyLines });
          inDenyRule = false;
        }
      }
    } else {
      // We're inside a deny rule body
      depth += countBraces(trimmed);

      if (depth <= 0) {
        // End of rule body — strip trailing '}'
        const bodyLine = trimmed.endsWith('}')
          ? trimmed.slice(0, -1).trim()
          : trimmed;
        if (bodyLine) bodyLines.push(bodyLine);
        rules.push({ bodyLines });
        inDenyRule = false;
        bodyLines = [];
        depth = 0;
      } else {
        bodyLines.push(trimmed);
      }
    }
  }

  return rules;
}

// ─── Iteration support ───────────────────────────────────────────────────────

/**
 * Check if any condition line is a wildcard iteration: `id := input.identity[_]`
 * Returns the variable name and the array it iterates, or null.
 */
function findIterationBinding(
  bodyLines: string[],
  env: EvalEnv,
): { varName: string; array: unknown[] } | null {
  for (const line of bodyLines) {
    const trimmed = line.trim();
    // Match `id := input.something[_]` or `id := varname[_]`
    const iterMatch = trimmed.match(/^(\w+)\s*:=\s*([\w.]+)\[_\]$/);
    if (iterMatch) {
      const varName = iterMatch[1];
      const pathStr = iterMatch[2];
      const pathParts = pathStr.split('.');
      const parts = pathParts.map((p) => ({ key: p }));
      const arr = resolvePath(parts, env);
      if (Array.isArray(arr)) {
        return { varName, array: arr };
      }
    }
  }
  return null;
}

/**
 * Evaluate a deny rule body.
 * Handles wildcard iteration if present.
 * Returns { msg?: string } if the rule fires, null if it does not.
 */
function evalDenyRule(
  rule: DenyRule,
  input: Record<string, unknown>,
): { msg?: string } | null {
  const env: EvalEnv = {
    input,
    vars: new Map(),
  };

  // Check if there's an iteration binding (some id; id := input.identity[_])
  const iter = findIterationBinding(rule.bodyLines, env);

  if (iter) {
    // For each element in the array, evaluate the body
    for (const element of iter.array) {
      const iterEnv: EvalEnv = {
        input,
        vars: new Map(env.vars),
      };
      iterEnv.vars.set(iter.varName, element);

      const result = evalBodyLines(rule.bodyLines, iterEnv, iter.varName);
      if (result !== null) return result;
    }
    return null;
  }

  return evalBodyLines(rule.bodyLines, env, null);
}

/**
 * Evaluate all body lines with AND semantics.
 * Returns { msg?: string } if all conditions match, null otherwise.
 * Skips lines that are iteration declarations when iterVarName is set.
 */
function evalBodyLines(
  bodyLines: string[],
  env: EvalEnv,
  iterVarName: string | null,
): { msg?: string } | null {
  let capturedMsg: string | undefined;

  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Skip the iteration binding line when iterating
    if (iterVarName !== null) {
      const iterPattern = new RegExp(
        `^${iterVarName}\\s*:=\\s*[\\w.]+\\[_\\]$`,
      );
      if (iterPattern.test(trimmed)) continue;
    }

    // Skip `some x` declarations
    if (/^some\s+\w+$/.test(trimmed)) continue;

    const { matched, msg } = evalCondition(trimmed, env);

    if (msg !== undefined) {
      capturedMsg = msg;
    }

    if (!matched) {
      return null; // AND: one false condition = rule doesn't fire
    }
  }

  return { msg: capturedMsg };
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class DslEngine implements PolicyEngine {
  readonly name = 'dsl';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const source = ctx.binding.dslSource;

    if (!source || !source.trim()) {
      return [];
    }

    const input: Record<string, unknown> = {
      message: ctx.content,
      identity: ctx.identity ?? [],
      direction: ctx.direction,
    };

    let rules: DenyRule[];
    try {
      rules = extractDenyRules(source);
    } catch (err) {
      return this.handleError(ctx, err);
    }

    const detections: PolicyDetection[] = [];

    for (const rule of rules) {
      try {
        const result = evalDenyRule(rule, input);
        if (result !== null) {
          detections.push({
            type: 'dsl',
            confidence: 1.0,
            message: result.msg || 'Policy violation',
          });
        }
      } catch (err) {
        const d = this.handleError(ctx, err);
        detections.push(...d);
      }
    }

    return detections;
  }

  private handleError(ctx: PolicyEvalContext, err: unknown): PolicyDetection[] {
    const failBehavior = ctx.binding.failBehavior ?? 'allow';
    if (failBehavior === 'block') {
      const message =
        err instanceof Error
          ? `Policy evaluation error: ${err.message}`
          : 'Policy evaluation error';
      return [{ type: 'dsl', confidence: 1.0, message }];
    }
    return [];
  }
}
