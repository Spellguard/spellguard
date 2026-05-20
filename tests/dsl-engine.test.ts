// SPDX-License-Identifier: Apache-2.0

/**
 * DSL Engine Unit Tests
 *
 * Tests the Rego/DSL policy engine: deny rule evaluation, built-in functions,
 * iteration, negation, error handling, and fail behavior.
 */

import { describe, expect, it } from 'vitest';
import { DslEngine } from '../packages/verifier/src/proxy/dsl-engine';
import type { PolicyEvalContext } from '../packages/verifier/src/proxy/policy-evaluator-types';
import { makeEngineBinding } from './helpers/make-binding';

const engine = new DslEngine();

function makeCtx(
  source: string,
  overrides: Partial<PolicyEvalContext> = {},
): PolicyEvalContext {
  return {
    content: 'test message',
    binding: makeEngineBinding('dsl', {}, { dslSource: source }),
    identity: [],
    ...overrides,
  } as unknown as PolicyEvalContext;
}

describe('DslEngine', () => {
  // ─── Basic ──────────────────────────────────────────────────────────────

  it('returns no detections for empty source', () => {
    const ctx = makeCtx('');
    expect(engine.evaluate(ctx)).toEqual([]);
  });

  it('returns no detections for whitespace-only source', () => {
    const ctx = makeCtx('   \n\n  ');
    expect(engine.evaluate(ctx)).toEqual([]);
  });

  it('returns no detections when no deny rules fire', () => {
    const source = `
package spellguard

deny[msg] {
  contains(input.message, "forbidden")
  msg := "Forbidden"
}
`;
    const ctx = makeCtx(source, { content: 'hello world' });
    expect(engine.evaluate(ctx)).toEqual([]);
  });

  // ─── contains ───────────────────────────────────────────────────────────

  it('fires deny rule with contains()', () => {
    const source = `
package spellguard

deny[msg] {
  contains(input.message, "drop table")
  msg := "SQL injection attempt detected"
}
`;
    const ctx = makeCtx(source, { content: 'please drop table users' });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].type).toBe('dsl');
    expect(detections[0].confidence).toBe(1.0);
    expect(detections[0].message).toBe('SQL injection attempt detected');
  });

  it('does not fire when contains() does not match', () => {
    const source = `
deny[msg] {
  contains(input.message, "drop table")
  msg := "SQL injection"
}
`;
    const ctx = makeCtx(source, { content: 'SELECT * FROM users' });
    expect(engine.evaluate(ctx)).toHaveLength(0);
  });

  // ─── lower() wrapping — case insensitive ─────────────────────────────────

  it('fires case-insensitively with lower()', () => {
    const source = `
deny[msg] {
  contains(lower(input.message), "drop table")
  msg := "SQL injection"
}
`;
    const ctx = makeCtx(source, { content: 'PLEASE DROP TABLE users' });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].message).toBe('SQL injection');
  });

  // ─── re_match ───────────────────────────────────────────────────────────

  it('fires with re_match()', () => {
    const source = `
deny[msg] {
  re_match("\\\\d{4}-\\\\d{4}", input.message)
  msg := "Looks like a card number pattern"
}
`;
    const ctx = makeCtx(source, { content: 'my number is 1234-5678' });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].message).toBe('Looks like a card number pattern');
  });

  it('does not fire re_match() when no match', () => {
    const source = `
deny[msg] {
  re_match("\\\\d{4}-\\\\d{4}", input.message)
  msg := "Card pattern"
}
`;
    const ctx = makeCtx(source, { content: 'no numbers here' });
    expect(engine.evaluate(ctx)).toHaveLength(0);
  });

  // ─── count + identity ────────────────────────────────────────────────────

  it('fires when count(input.identity) == 0 and identity is empty', () => {
    const source = `
deny[msg] {
  count(input.identity) == 0
  msg := "No verified identity"
}
`;
    const ctx = makeCtx(source, { identity: [] });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].message).toBe('No verified identity');
  });

  it('does not fire when identity is present', () => {
    const source = `
deny[msg] {
  count(input.identity) == 0
  msg := "No verified identity"
}
`;
    const ctx = makeCtx(source, {
      identity: [{ provider: 'aws', subject: 'arn:aws:iam::123:role/MyRole' }],
    });
    expect(engine.evaluate(ctx)).toHaveLength(0);
  });

  // ─── Field access + some + wildcard iteration ────────────────────────────

  it('fires with some id := input.identity[_] when provider is wrong', () => {
    const source = `
deny[msg] {
  some id
  id := input.identity[_]
  id.provider != "aws"
  msg := "Non-AWS identity"
}
`;
    const ctx = makeCtx(source, {
      identity: [{ provider: 'azure', subject: 'some-object-id' }],
    });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].message).toBe('Non-AWS identity');
  });

  it('does not fire when provider matches allowlist', () => {
    const source = `
deny[msg] {
  some id
  id := input.identity[_]
  id.provider != "aws"
  msg := "Non-AWS identity"
}
`;
    const ctx = makeCtx(source, {
      identity: [{ provider: 'aws', subject: 'arn:aws:iam::123:role/MyRole' }],
    });
    expect(engine.evaluate(ctx)).toHaveLength(0);
  });

  // ─── not negation ────────────────────────────────────────────────────────

  it('fires when not contains() is true (message does NOT contain word)', () => {
    const source = `
deny[msg] {
  not contains(input.message, "authorized")
  msg := "Message does not contain authorization"
}
`;
    const ctx = makeCtx(source, { content: 'please do something dangerous' });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].message).toBe(
      'Message does not contain authorization',
    );
  });

  it('does not fire when not contains() is false (message DOES contain word)', () => {
    const source = `
deny[msg] {
  not contains(input.message, "authorized")
  msg := "Not authorized"
}
`;
    const ctx = makeCtx(source, { content: 'this is authorized content' });
    expect(engine.evaluate(ctx)).toHaveLength(0);
  });

  // ─── Multiple deny rules — OR logic ──────────────────────────────────────

  it('fires for multiple matching deny rules (OR semantics)', () => {
    const source = `
deny[msg] {
  contains(input.message, "hack")
  msg := "Hack detected"
}

deny[msg] {
  contains(input.message, "exploit")
  msg := "Exploit detected"
}
`;
    const ctx = makeCtx(source, { content: 'hack and exploit' });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(2);
  });

  it('fires only the matching deny rule when only one matches', () => {
    const source = `
deny[msg] {
  contains(input.message, "hack")
  msg := "Hack detected"
}

deny[msg] {
  contains(input.message, "exploit")
  msg := "Exploit detected"
}
`;
    const ctx = makeCtx(source, { content: 'just a hack' });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].message).toBe('Hack detected');
  });

  // ─── AND logic within one rule ───────────────────────────────────────────

  it('requires all conditions to be true within one rule (AND semantics)', () => {
    const source = `
deny[msg] {
  contains(input.message, "hack")
  contains(input.message, "system")
  msg := "System hack"
}
`;
    // Only "hack" present — rule should not fire
    const ctx1 = makeCtx(source, { content: 'hack something' });
    expect(engine.evaluate(ctx1)).toHaveLength(0);

    // Both present — rule should fire
    const ctx2 = makeCtx(source, { content: 'hack the system' });
    expect(engine.evaluate(ctx2)).toHaveLength(1);
  });

  // ─── msg := assignment captured ─────────────────────────────────────────

  it('captures msg from assignment', () => {
    const source = `
deny[msg] {
  contains(input.message, "bad")
  msg := "Custom violation message"
}
`;
    const ctx = makeCtx(source, { content: 'bad content here' });
    const detections = engine.evaluate(ctx);
    expect(detections[0].message).toBe('Custom violation message');
  });

  it('uses default message when no msg := present', () => {
    const source = `
deny[msg] {
  contains(input.message, "bad")
}
`;
    const ctx = makeCtx(source, { content: 'bad content' });
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].message).toBe('Policy violation');
  });

  // ─── Error handling ──────────────────────────────────────────────────────

  it('handles malformed Rego source gracefully without crashing', () => {
    const source = 'this is not valid rego {{{{';
    const ctx = makeCtx(source);
    expect(() => engine.evaluate(ctx)).not.toThrow();
  });

  it('returns no detections on malformed source with failBehavior=allow', () => {
    // A condition with unclosed paren will throw during evaluation
    const source = `
deny[msg] {
  contains(input.message
  msg := "error"
}
`;
    const binding = makeEngineBinding(
      'dsl',
      {},
      {
        dslSource: source,
        failBehavior: 'allow',
      },
    );
    const ctxAllow: PolicyEvalContext = {
      content: 'bad',
      binding,
      identity: [],
    } as unknown as PolicyEvalContext;
    expect(engine.evaluate(ctxAllow)).toHaveLength(0);
  });

  it('emits a detection on evaluation error with failBehavior=block', () => {
    // A condition with unclosed paren will throw during evaluation
    const source = `
deny[msg] {
  contains(input.message
  msg := "error"
}
`;
    const binding = makeEngineBinding(
      'dsl',
      {},
      {
        dslSource: source,
        failBehavior: 'block',
      },
    );
    const ctx: PolicyEvalContext = {
      content: 'bad',
      binding,
      identity: [],
    } as unknown as PolicyEvalContext;
    const detections = engine.evaluate(ctx);
    expect(detections).toHaveLength(1);
    expect(detections[0].type).toBe('dsl');
    expect(detections[0].message).toMatch(/Policy evaluation error/);
  });
});
