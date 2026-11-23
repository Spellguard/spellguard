// SPDX-License-Identifier: Apache-2.0

/**
 * Policy Database Policy Engine Unit Tests
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEngineBinding } from './helpers/make-binding';

describe('Policy Database Policy Engines', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── query-injection ─────────────────────────────────────────

  describe('query-injection', () => {
    it('should deny SQL tautology injection', async () => {
      const binding = makeEngineBinding('query-injection', {});

      const results = await evaluatePolicies([binding], "' OR '1'='1");
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny UNION-based injection', async () => {
      const binding = makeEngineBinding('query-injection', {});

      const results = await evaluatePolicies(
        [binding],
        'UNION SELECT * FROM users',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny stacked query injection', async () => {
      const binding = makeEngineBinding('query-injection', {});

      const results = await evaluatePolicies([binding], '; DROP TABLE users--');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny time-based blind injection', async () => {
      const binding = makeEngineBinding('query-injection', {});

      const results = await evaluatePolicies(
        [binding],
        'SELECT * FROM users WHERE id = 1 AND SLEEP(5)',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny xp_cmdshell execution', async () => {
      const binding = makeEngineBinding('query-injection', {});

      const results = await evaluatePolicies(
        [binding],
        "xp_cmdshell('whoami')",
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit safe parameterized-style queries', async () => {
      const binding = makeEngineBinding('query-injection', {});

      const results = await evaluatePolicies(
        [binding],
        "SELECT id, name FROM products WHERE category = 'books'",
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it.each([
      {
        name: 'Slack image dimensions',
        content: 'Image dimensions: 1440x1000',
        decision: 'permit',
      },
      {
        name: 'database error code',
        content: 'Database request failed with error code 0xDEADBEEF',
        decision: 'permit',
      },
      {
        name: 'legitimate SELECT hex literal',
        content: 'SELECT 0x1234 FROM users',
        decision: 'permit',
      },
      {
        name: 'direct EXEC hex payload',
        content: 'ExEc (0x73656c656374202a2046524f4d207573657273)',
        decision: 'deny',
      },
      {
        name: 'direct EXECUTE hex payload',
        content: 'eXeCuTe ( 0x73656c656374202a2046524f4d207573657273 )',
        decision: 'deny',
      },
      {
        name: 'UNION hex attack after benign dimensions',
        content: 'Image dimensions: 1440x1000 UNION SELECT 0x736563726574',
        decision: 'deny',
      },
    ])('should $decision $name', async ({ content, decision }) => {
      const binding = makeEngineBinding('query-injection', {});

      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe(decision);
      if (decision === 'permit') {
        expect(results[0].detections).toHaveLength(0);
      } else {
        expect(results[0].detections.length).toBeGreaterThan(0);
      }
    });

    it('should deny custom injection patterns when configured', async () => {
      const binding = makeEngineBinding('query-injection', {
        extraPatterns: ['LOAD_FILE\\s*\\('],
      });

      const results = await evaluatePolicies(
        [binding],
        "SELECT LOAD_FILE('/etc/passwd')",
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });
  });

  // ─── query-injection: comment-escape patterns must stay LOCAL ────
  //
  // Regression guard. The comment-escape patterns used to be unbounded
  // (`/'[^']*--/` and `/(?:--|#|\/\*)\s*$/`), so ANY apostrophe anywhere before
  // ANY `--` anywhere in the content matched. That blocked 100% of Spellguard's
  // own agent-chat fan-outs: the client's context scaffolding says
  // "…the user's query." and then delimits each peer reply with
  // `--- Response from <agent> ---` (packages/client/ts/src/ai.ts:123,133).
  // A SQL line comment is EXACTLY `--`; `---` is a markdown rule.

  describe('query-injection — comment escapes are local, not document-wide', () => {
    const attacks: Array<[string, string]> = [
      ['classic quote-comment escape', "admin'--"],
      ['tautology with trailing comment', "' OR '1'='1' --"],
      ['no-space tautology comment', "' OR 1=1--"],
      [
        'garak stacked insert with trailing comment',
        "' INSERT INTO Customer (FirstName, LastName, Email) VALUES ('garak', 'pwnd', 'garak.pwnd@example.com'); --",
      ],
      [
        'UNION with trailing comment',
        "1' UNION SELECT username, password FROM users--",
      ],
      ['block-comment escape', "value' /*"],
      ['hash-comment escape', "x' #"],
    ];

    for (const [label, payload] of attacks) {
      it(`still DENIES ${label}`, async () => {
        const binding = makeEngineBinding('query-injection', {});
        const results = await evaluatePolicies([binding], payload);
        expect(results[0].decision).toBe('deny');
      });
    }

    const benign: Array<[string, string]> = [
      [
        "the client's own peer-response scaffolding (the actual outage)",
        "You have received responses from other agents. Use this information along with your own data to provide a comprehensive answer to the user's query.\n\n--- Response from agent-b ---\nI am Agent B, a confidential data analysis specialist.\n--- End response from agent-b ---",
      ],
      [
        'markdown horizontal rule after an apostrophe',
        "Here's the summary.\n\n---\n\nNext section",
      ],
      ['em-dash-style triple hyphen in prose', "It's a great day --- truly"],
      [
        'document ending in a markdown rule',
        '# Heading\n\nSome prose that ends with a rule\n\n---',
      ],
    ];

    for (const [label, payload] of benign) {
      it(`PERMITS ${label}`, async () => {
        const binding = makeEngineBinding('query-injection', {});
        const results = await evaluatePolicies([binding], payload);
        expect(results[0].decision).toBe('permit');
        expect(results[0].detections).toHaveLength(0);
      });
    }
  });

  // ─── ddl-block ───────────────────────────────────────────────

  describe('ddl-block', () => {
    it('should deny DROP TABLE statements', async () => {
      const binding = makeEngineBinding('ddl-block', {});

      const results = await evaluatePolicies([binding], 'DROP TABLE users');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny ALTER TABLE statements', async () => {
      const binding = makeEngineBinding('ddl-block', {});

      const results = await evaluatePolicies(
        [binding],
        'ALTER TABLE users ADD COLUMN x INT',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny TRUNCATE TABLE statements', async () => {
      const binding = makeEngineBinding('ddl-block', {});

      const results = await evaluatePolicies([binding], 'TRUNCATE TABLE logs');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny CREATE TABLE statements by default', async () => {
      const binding = makeEngineBinding('ddl-block', {});

      const results = await evaluatePolicies(
        [binding],
        'CREATE TABLE temp (id INT)',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit CREATE when explicitly allowed via allowedDdl', async () => {
      const binding = makeEngineBinding('ddl-block', {
        allowedDdl: ['CREATE'],
      });

      const results = await evaluatePolicies(
        [binding],
        'CREATE TABLE temp (id INT)',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit SELECT statements', async () => {
      const binding = makeEngineBinding('ddl-block', {});

      const results = await evaluatePolicies([binding], 'SELECT * FROM users');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── write-block ─────────────────────────────────────────────

  describe('write-block', () => {
    it('should deny INSERT statements', async () => {
      const binding = makeEngineBinding('write-block', {});

      const results = await evaluatePolicies(
        [binding],
        "INSERT INTO users VALUES (1, 'test')",
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny UPDATE statements', async () => {
      const binding = makeEngineBinding('write-block', {});

      const results = await evaluatePolicies(
        [binding],
        "UPDATE users SET name='x' WHERE id=1",
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny DELETE statements', async () => {
      const binding = makeEngineBinding('write-block', {});

      const results = await evaluatePolicies(
        [binding],
        'DELETE FROM sessions WHERE expired=true',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit SELECT (read-only) statements', async () => {
      const binding = makeEngineBinding('write-block', {});

      const results = await evaluatePolicies([binding], 'SELECT * FROM users');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny MERGE statements', async () => {
      const binding = makeEngineBinding('write-block', {});

      const results = await evaluatePolicies(
        [binding],
        'MERGE INTO target USING source',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });
  });
});
