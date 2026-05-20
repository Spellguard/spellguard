// SPDX-License-Identifier: Apache-2.0

/**
 * URL Policy Engine Unit Tests
 *
 * Tests the URL policy engine that controls what URLs agents can send
 * via blocklists, allowlists, and suspicious pattern detection.
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeUrlBinding(
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'url-test',
    level: 'org',
    effect: 'block',
    policyType: 'url',
    policySlug: 'custom-url',
    config,
    ...overrides,
  };
}

describe('URL Policy Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── Blocklist Mode ────────────────────────────────────────

  describe('blocklist mode', () => {
    it('should block URLs from blocklisted domains', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com', 'bad.net'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Check out https://evil.com/phishing',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('evil.com');
    });

    it('should block subdomains of blocklisted domains', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://subdomain.evil.com/page',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should permit URLs not in blocklist', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://good.com/safe',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Allowlist Mode ────────────────────────────────────────

  describe('allowlist mode', () => {
    it('should permit URLs from allowlisted domains', async () => {
      const binding = makeUrlBinding({
        mode: 'allowlist',
        allowedDomains: ['trusted.com', 'safe.org'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://trusted.com/page',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit subdomains of allowlisted domains', async () => {
      const binding = makeUrlBinding({
        mode: 'allowlist',
        allowedDomains: ['trusted.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://api.trusted.com/endpoint',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should block URLs not in allowlist', async () => {
      const binding = makeUrlBinding({
        mode: 'allowlist',
        allowedDomains: ['trusted.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://untrusted.com/page',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('not in allowlist');
    });

    it('should permit all URLs when allowlist is empty', async () => {
      const binding = makeUrlBinding({
        mode: 'allowlist',
        allowedDomains: [],
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://anything.com/page',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Suspicious Patterns ───────────────────────────────────

  describe('suspicious patterns', () => {
    it('should detect IP-based URLs', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit http://192.168.1.1/admin',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('IP-based');
    });

    it('should detect URLs with @ symbol', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://user@evil.com/phish',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('@ symbol');
    });

    it('should detect suspicious TLDs', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://phishing.tk/steal',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('Suspicious TLD');
    });

    it('should not detect suspicious patterns when disabled', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit http://192.168.1.1/admin',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── URL Shorteners ────────────────────────────────────────

  describe('url shorteners', () => {
    it('should block bit.ly when enabled', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockShorteners: true,
      });

      const results = await evaluatePolicies(
        [binding],
        'Click https://bit.ly/abc123',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('shortener');
    });

    it('should block t.co when enabled', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockShorteners: true,
      });

      const results = await evaluatePolicies([binding], 'See https://t.co/xyz');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should block tinyurl.com when enabled', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockShorteners: true,
      });

      const results = await evaluatePolicies(
        [binding],
        'Go to https://tinyurl.com/test',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should permit shorteners when disabled', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockShorteners: false,
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Click https://bit.ly/abc123',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── HTTPS Requirement ─────────────────────────────────────

  describe('https requirement', () => {
    it('should block HTTP URLs when HTTPS required', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        requireHttps: true,
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit http://example.com/page',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('Non-HTTPS');
    });

    it('should permit HTTPS URLs when HTTPS required', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        requireHttps: true,
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit https://example.com/page',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit HTTP URLs when HTTPS not required', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        requireHttps: false,
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit http://example.com/page',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Multiple URLs ─────────────────────────────────────────

  describe('multiple urls', () => {
    it('should detect multiple violations', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
        blockSuspicious: true,
      });

      const content =
        'Visit https://evil.com and http://192.168.1.1 and https://phishing.tk';
      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections.length).toBeGreaterThanOrEqual(3);
    });

    it('should permit clean URLs in mixed content', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
        blockSuspicious: false,
      });

      const content =
        'Visit https://good.com and https://safe.org but not https://evil.com';
      const results = await evaluatePolicies([binding], content);
      // Only evil.com should be flagged
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Custom Label ──────────────────────────────────────────

  describe('custom label', () => {
    it('should use custom label when provided', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
        label: 'unsafe-url',
      });

      const results = await evaluatePolicies(
        [binding],
        'https://evil.com/page',
      );
      expect(results[0].detections[0].type).toBe('unsafe-url');
    });

    it('should default to "url-violation"', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'https://evil.com/page',
      );
      expect(results[0].detections[0].type).toBe('url-violation');
    });
  });

  // ─── No URLs ───────────────────────────────────────────────

  describe('no urls in content', () => {
    it('should permit content without URLs', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'This is just normal text without any links',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── URL Extraction ────────────────────────────────────────

  describe('url extraction', () => {
    it('should extract URLs from markdown', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        '[Click here](https://evil.com/phish)',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should extract URLs from plain text', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit evil.com at https://evil.com for more info',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should extract multiple URLs from text', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: false,
      });

      const content =
        'Visit https://example.com and https://test.org and https://demo.net';
      const results = await evaluatePolicies([binding], content);
      // Should permit all (no blocks configured)
      expect(results[0].decision).toBe('permit');
    });
  });

  // ─── Confidence Levels ─────────────────────────────────────

  describe('confidence levels', () => {
    it('should have 1.0 confidence for explicit violations', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'https://evil.com/page',
      );
      expect(results[0].detections[0].confidence).toBe(1.0);
    });

    it('should have 0.85 confidence for suspicious patterns', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
      });

      const results = await evaluatePolicies(
        [binding],
        'http://192.168.1.1/admin',
      );
      expect(results[0].detections[0].confidence).toBe(0.85);
    });

    it('should have 1.0 confidence for HTTPS violations', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        requireHttps: true,
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'http://example.com/page',
      );
      expect(results[0].detections[0].confidence).toBe(1.0);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle malformed URLs gracefully', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
      });

      const results = await evaluatePolicies(
        [binding],
        'Not a URL: htp://broken or www.notaurl',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should be case-insensitive for domain matching', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockedDomains: ['evil.com'],
      });

      const results = await evaluatePolicies(
        [binding],
        'https://EVIL.COM/page',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should handle empty config gracefully', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
      });

      const results = await evaluatePolicies(
        [binding],
        'https://example.com/page',
      );
      // Default blockSuspicious is true, but example.com is not suspicious
      expect(results[0].decision).toBe('permit');
    });
  });

  // ─── Config-Driven Suspicious TLDs ────────────────────────

  describe('config-driven suspicious TLDs', () => {
    it('uses custom suspiciousTlds from config', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
        suspiciousTlds: ['evil', 'bad'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Check out http://example.evil/malware',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('Suspicious TLD');
    });

    it('does not flag default TLDs when custom list replaces them', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
        suspiciousTlds: ['evil'],
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit http://example.tk/page',
      );
      // .tk is in defaults but NOT in the custom list, so should not detect
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Config-Driven Shortener Domains ──────────────────────

  describe('config-driven shortener domains', () => {
    it('uses custom shortenerDomains from config', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockShorteners: true,
        shortenerDomains: ['short.test'],
        blockSuspicious: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Click http://short.test/abc',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('shortener');
    });
  });

  // ─── Config-Driven IP and Userinfo Blocking ───────────────

  describe('config-driven IP and userinfo blocking', () => {
    it('respects blockIpHosts=false to allow IP URLs', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
        blockIpHosts: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit http://192.168.1.1/admin',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('respects blockUserinfoUrls=false', async () => {
      const binding = makeUrlBinding({
        mode: 'blocklist',
        blockSuspicious: true,
        blockUserinfoUrls: false,
      });

      const results = await evaluatePolicies(
        [binding],
        'Visit http://user@example.com/page',
      );
      // @ URL should not be flagged; example.com has safe TLD so no detection
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Decision Logic ────────────────────────────────────────

  describe('decision logic integration', () => {
    it('should flag (not block) when effect is permit', async () => {
      const binding = makeUrlBinding(
        {
          mode: 'blocklist',
          blockedDomains: ['evil.com'],
        },
        { effect: 'flag' },
      );

      const results = await evaluatePolicies(
        [binding],
        'https://evil.com/page',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      expect(results[0].detections).toHaveLength(1);
    });
  });
});
