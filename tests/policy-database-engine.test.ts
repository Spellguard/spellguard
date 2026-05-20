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
