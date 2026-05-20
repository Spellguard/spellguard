// SPDX-License-Identifier: Apache-2.0

/**
 * Policy Memory Policy Engine Unit Tests
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEngineBinding } from './helpers/make-binding';

describe('Policy Memory Policy Engines', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── scope-isolation ─────────────────────────────────────────

  describe('scope-isolation', () => {
    it('should deny access to another agent prefix', async () => {
      const binding = makeEngineBinding('scope-isolation', {
        allowedPrefixes: ['agent_A:'],
      });

      const results = await evaluatePolicies(
        [binding],
        "get_memory('agent_B:profile')",
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit access to own agent prefix', async () => {
      const binding = makeEngineBinding('scope-isolation', {
        allowedPrefixes: ['agent_A:'],
      });

      const results = await evaluatePolicies(
        [binding],
        "get_memory('agent_A:prefs')",
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should still detect cross-agent patterns even with empty allowedPrefixes', async () => {
      const binding = makeEngineBinding('scope-isolation', {
        allowedPrefixes: [],
      });

      const results = await evaluatePolicies(
        [binding],
        'read memory key agent_longid12345:data',
      );
      // Engine detects cross-agent pattern regardless of allowedPrefixes config
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should detect cross-agent memory access patterns', async () => {
      const binding = makeEngineBinding('scope-isolation', {
        allowedPrefixes: ['agent_A:'],
      });

      const results = await evaluatePolicies(
        [binding],
        'read memory key agent_longid12345:data',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });
  });

  // ─── payload-size-limit ──────────────────────────────────────

  describe('payload-size-limit', () => {
    it('should permit content exactly at the limit', async () => {
      const maxBytes = 100;
      const binding = makeEngineBinding('payload-size-limit', { maxBytes });

      const content = 'a'.repeat(maxBytes);
      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny content 1 byte over the limit', async () => {
      const maxBytes = 100;
      const binding = makeEngineBinding('payload-size-limit', { maxBytes });

      const content = 'a'.repeat(maxBytes + 1);
      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit small content against default limit of 10240 bytes', async () => {
      const binding = makeEngineBinding('payload-size-limit', {});

      const content = 'Hello, this is a small payload';
      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny content over a custom maxBytes limit', async () => {
      const binding = makeEngineBinding('payload-size-limit', {
        maxBytes: 100,
      });

      const content = 'a'.repeat(101);
      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });
  });
});
