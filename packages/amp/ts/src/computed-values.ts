// SPDX-License-Identifier: Apache-2.0

/**
 * Computed values for policies that limit what an action is worth
 * (internal design notes): `order_total = quantity *
 * unit_price`, then a limit on `order_total`. An expression is numbers, fact
 * names, `+ - * /` and parentheses, parsed into a tree and evaluated here,
 * never by `eval`. Anything this can't compute (a missing or non-numeric
 * fact, division by zero, a non-finite result, a malformed expression) is an
 * error the caller treats as a violated limit: a limit fails closed.
 *
 * Shared by the Verifier's engines, which evaluate expressions, and the
 * readers that refuse a bad one when a policy is saved (agent-conduct.ts),
 * so both parse with the same grammar.
 */

/** Expressions longer than this are refused, as are deeper nestings. */
export const MAX_EXPRESSION_LENGTH = 256;
const MAX_DEPTH = 32;

export type ComputedResult =
  | { ok: true; value: number; text: string }
  | { ok: false; reason: string };

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}/;
const NUMBER = /^\d+(?:\.\d+)?/;

function tokenize(expression: string): Token[] | string {
  const tokens: Token[] = [];
  let rest = expression;
  while (rest.length > 0) {
    const ch = rest[0];
    if (ch === ' ' || ch === '\t') {
      rest = rest.slice(1);
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push({
        kind: 'op',
        value: ch as '+' | '-' | '*' | '/' | '(' | ')',
      });
      rest = rest.slice(1);
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      rest = rest.slice(number[0].length);
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ kind: 'name', value: name[0] });
      rest = rest.slice(name[0].length);
      continue;
    }
    return `unexpected "${ch}"`;
  }
  return tokens;
}

/** A parsed expression: evaluated against facts, and printed with their values. */
export type Expression = Node;
type Node =
  | { kind: 'number'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'negate'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.sum(0);
    if (this.index < this.tokens.length) throw new Error('unexpected input');
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token?.kind === 'op' && token.value === value;
  }

  private sum(depth: number): Node {
    let node = this.product(depth);
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.index++] as { value: '+' | '-' }).value;
      node = { kind: 'binary', op, left: node, right: this.product(depth) };
    }
    return node;
  }

  private product(depth: number): Node {
    let node = this.unary(depth);
    while (this.isOp('*') || this.isOp('/')) {
      const op = (this.tokens[this.index++] as { value: '*' | '/' }).value;
      node = { kind: 'binary', op, left: node, right: this.unary(depth) };
    }
    return node;
  }

  private unary(depth: number): Node {
    if (depth > MAX_DEPTH) throw new Error('too deeply nested');
    if (this.isOp('-')) {
      this.index++;
      return { kind: 'negate', operand: this.unary(depth + 1) };
    }
    const token = this.tokens[this.index++];
    if (!token) throw new Error('ends early');
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'name') return { kind: 'name', name: token.value };
    if (token.value === '(') {
      const node = this.sum(depth + 1);
      if (!this.isOp(')')) throw new Error('missing ")"');
      this.index++;
      return node;
    }
    throw new Error(`unexpected "${token.value}"`);
  }
}

/** Parse an expression, or say why it can't be. */
export function parseExpression(expression: string): Node | string {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return 'is empty';
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return `is longer than ${MAX_EXPRESSION_LENGTH} characters`;
  }
  const tokens = tokenize(expression);
  if (typeof tokens === 'string') return tokens;
  try {
    return new Parser(tokens).parse();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The fact names an expression reads, in order of first use. */
export function expressionNames(node: Expression): string[] {
  const names: string[] = [];
  const visit = (n: Node): void => {
    switch (n.kind) {
      case 'name':
        if (!names.includes(n.name)) names.push(n.name);
        return;
      case 'negate':
        visit(n.operand);
        return;
      case 'binary':
        visit(n.left);
        visit(n.right);
        return;
      case 'number':
        return;
    }
  };
  visit(node);
  return names;
}

function format(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(6)));
}

const OPERATORS: Record<
  '+' | '-' | '*' | '/',
  { apply: (a: number, b: number) => number; symbol: string }
> = {
  '+': { apply: (a, b) => a + b, symbol: '+' },
  '-': { apply: (a, b) => a - b, symbol: '-' },
  '*': { apply: (a, b) => a * b, symbol: '×' },
  '/': { apply: (a, b) => a / b, symbol: '÷' },
};

function evaluate(
  node: Node,
  facts: Readonly<Record<string, unknown>>,
): { value: number; text: string } {
  switch (node.kind) {
    case 'number':
      return { value: node.value, text: format(node.value) };
    case 'name': {
      const value = Object.hasOwn(facts, node.name)
        ? facts[node.name]
        : undefined;
      if (value === undefined) throw new Error(`"${node.name}" is missing`);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`"${node.name}" is not a number`);
      }
      return { value, text: `${node.name} ${format(value)}` };
    }
    case 'negate': {
      const operand = evaluate(node.operand, facts);
      return { value: -operand.value, text: `-${operand.text}` };
    }
    case 'binary': {
      const left = evaluate(node.left, facts);
      const right = evaluate(node.right, facts);
      if (node.op === '/' && right.value === 0) {
        throw new Error('divides by zero');
      }
      const { apply, symbol } = OPERATORS[node.op];
      return {
        value: apply(left.value, right.value),
        text: `${left.text} ${symbol} ${right.text}`,
      };
    }
  }
}

/**
 * Compute one value from named facts. `text` shows the working for a
 * detection message: `quantity 120 × unit_price 544`.
 */
export function computeValue(
  expression: string,
  facts: Readonly<Record<string, unknown>>,
): ComputedResult {
  const node = parseExpression(expression);
  if (typeof node === 'string') {
    return { ok: false, reason: `its expression ${node}` };
  }
  try {
    const { value, text } = evaluate(node, facts);
    if (!Number.isFinite(value)) {
      return { ok: false, reason: 'the result is not a finite number' };
    }
    return { ok: true, value, text };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Every computed value a policy declares (`{ name: expression }`), from the
 * same facts. A declaration that isn't an object of strings yields one
 * failed entry per bad name, so nothing is silently skipped.
 */
export function computeValues(
  declarations: unknown,
  facts: Readonly<Record<string, unknown>>,
): Map<string, ComputedResult> {
  const results = new Map<string, ComputedResult>();
  if (
    typeof declarations !== 'object' ||
    declarations === null ||
    Array.isArray(declarations)
  ) {
    return results;
  }
  for (const [name, expression] of Object.entries(declarations)) {
    results.set(
      name,
      typeof expression === 'string'
        ? computeValue(expression, facts)
        : { ok: false, reason: 'its expression is not a string' },
    );
  }
  return results;
}
