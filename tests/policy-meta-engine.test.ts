// SPDX-License-Identifier: Apache-2.0

/**
 * Policy Meta Policy Engine Unit Tests
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEngineBinding } from './helpers/make-binding';

describe('Policy Meta Policy Engines', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── invocation-rate-limit ───────────────────────────────────

  describe('invocation-rate-limit', () => {
    it('should permit the first invocation under the limit', async () => {
      const binding = makeEngineBinding(
        'invocation-rate-limit',
        { maxCalls: 2, windowSeconds: 60 },
        { policyId: 'rate-limit-test-1' },
      );

      const results = await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-1',
      });
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit an invocation exactly at the limit', async () => {
      const binding = makeEngineBinding(
        'invocation-rate-limit',
        { maxCalls: 2, windowSeconds: 60 },
        { policyId: 'rate-limit-test-2' },
      );

      // First call
      await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-2',
      });
      // Second call (at limit)
      const results = await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-2',
      });
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny the invocation that exceeds the limit', async () => {
      const binding = makeEngineBinding(
        'invocation-rate-limit',
        { maxCalls: 2, windowSeconds: 60 },
        { policyId: 'rate-limit-test-3' },
      );

      // First two calls (within limit)
      await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-3',
      });
      await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-3',
      });
      // Third call (over limit)
      const results = await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-3',
      });
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should maintain separate rate limit buckets per agentId', async () => {
      const binding = makeEngineBinding(
        'invocation-rate-limit',
        { maxCalls: 1, windowSeconds: 60 },
        { policyId: 'rate-limit-test-4' },
      );

      // Exhaust agent-A's quota
      await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-A',
      });
      const agentADenied = await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-A',
      });
      expect(agentADenied[0].decision).toBe('deny');

      // Agent-B should still be permitted (different bucket)
      const agentBResults = await evaluatePolicies([binding], 'call tool', {
        agentId: 'agent-rate-B',
      });
      expect(agentBResults[0].decision).toBe('permit');
    });
  });

  // ─── irreversible-gate ───────────────────────────────────────

  describe('irreversible-gate', () => {
    it('should deny glob-matched irreversible tool invocations', async () => {
      const binding = makeEngineBinding('irreversible-gate', {
        irreversibleTools: ['delete_*'],
      });

      const results = await evaluatePolicies(
        [binding],
        'delete_file /workspace/data.csv',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny exact-match irreversible tool invocations', async () => {
      const binding = makeEngineBinding('irreversible-gate', {
        irreversibleTools: ['delete_*', 'send_email'],
      });

      const results = await evaluatePolicies(
        [binding],
        'send_email to alice@example.com',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit non-irreversible tool invocations', async () => {
      const binding = makeEngineBinding('irreversible-gate', {
        irreversibleTools: ['delete_*', 'send_email'],
      });

      const results = await evaluatePolicies(
        [binding],
        'read_file /data/report.csv',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny built-in irreversible patterns when irreversibleTools is empty', async () => {
      const binding = makeEngineBinding('irreversible-gate', {
        irreversibleTools: [],
      });

      const results = await evaluatePolicies(
        [binding],
        'delete file and send email to user',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny delete operations matched by glob pattern', async () => {
      const binding = makeEngineBinding('irreversible-gate', {
        irreversibleTools: ['delete_*'],
      });

      const results = await evaluatePolicies([binding], 'delete file');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });
  });

  // ─── output-size-limit ───────────────────────────────────────

  describe('output-size-limit', () => {
    it('should permit content within the default limit', async () => {
      const binding = makeEngineBinding('output-size-limit', {});

      const content = 'a'.repeat(1000);
      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny content 1 byte over a custom limit', async () => {
      const maxBytes = 200;
      const binding = makeEngineBinding('output-size-limit', { maxBytes });

      const content = 'a'.repeat(maxBytes + 1);
      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny content over a custom maxBytes of 100', async () => {
      const binding = makeEngineBinding('output-size-limit', {
        maxBytes: 100,
      });

      const content = 'a'.repeat(101);
      const results = await evaluatePolicies([binding], content);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit empty content', async () => {
      const binding = makeEngineBinding('output-size-limit', {});

      const results = await evaluatePolicies([binding], '');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── data-flow-taint ─────────────────────────────────────────

  describe('data-flow-taint', () => {
    it('should deny privileged write following an untrusted fetch', async () => {
      const binding = makeEngineBinding('data-flow-taint', {});

      const results = await evaluatePolicies(
        [binding],
        'write_file /output.csv',
        {
          recentMessages: [
            {
              content: 'fetch_url https://evil.com',
              timestamp: Date.now() - 5000,
            },
          ],
        },
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit privileged write with no prior untrusted fetch', async () => {
      const binding = makeEngineBinding('data-flow-taint', {});

      const results = await evaluatePolicies(
        [binding],
        'write_file /output.csv',
        {
          recentMessages: [],
        },
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit non-privileged operations regardless of taint history', async () => {
      const binding = makeEngineBinding('data-flow-taint', {});

      const results = await evaluatePolicies([binding], 'read_file /data.txt', {
        recentMessages: [
          {
            content: 'fetch_url https://evil.com',
            timestamp: Date.now() - 5000,
          },
        ],
      });
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });
});
