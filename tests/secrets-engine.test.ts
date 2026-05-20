// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Detection Engine Unit Tests
 *
 * Tests the secrets policy engine that detects API keys,
 * tokens, and credentials.
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeSecretsBinding(
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'secrets-test',
    level: 'org',
    effect: 'block',
    policyType: 'secrets',
    policySlug: 'custom-secrets',
    config,
    ...overrides,
  };
}

describe('Secrets Detection Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── AWS Keys ──────────────────────────────────────────────

  describe('aws keys', () => {
    it('should detect AWS access keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['aws'],
      });

      const results = await evaluatePolicies(
        [binding],
        'My key is AKIAIOSFODNN7EXAMPLE',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('aws');
    });

    it('should not detect when aws category disabled', async () => {
      const binding = makeSecretsBinding({
        categories: ['github'],
      });

      const results = await evaluatePolicies(
        [binding],
        'My key is AKIAIOSFODNN7EXAMPLE',
      );
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── GitHub Tokens ─────────────────────────────────────────

  describe('github tokens', () => {
    it('should detect GitHub personal access tokens (ghp_)', async () => {
      const binding = makeSecretsBinding({
        categories: ['github'],
      });

      const results = await evaluatePolicies(
        [binding],
        `token: ghp_${'x'.repeat(36)}`,
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('github');
    });

    it('should detect GitHub OAuth tokens (gho_)', async () => {
      const binding = makeSecretsBinding({
        categories: ['github'],
      });

      const results = await evaluatePolicies(
        [binding],
        `token: gho_${'x'.repeat(36)}`,
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect GitHub user-to-server tokens (ghu_)', async () => {
      const binding = makeSecretsBinding({
        categories: ['github'],
      });

      const results = await evaluatePolicies(
        [binding],
        `token: ghu_${'x'.repeat(36)}`,
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── OpenAI Keys ───────────────────────────────────────────

  describe('openai keys', () => {
    it('should detect OpenAI API keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['openai'],
      });

      const results = await evaluatePolicies(
        [binding],
        `api_key=sk-${'x'.repeat(48)}`,
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('openai');
    });
  });

  // ─── Anthropic Keys ────────────────────────────────────────

  describe('anthropic keys', () => {
    it('should detect Anthropic API keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['anthropic'],
      });

      const results = await evaluatePolicies(
        [binding],
        `key: sk-ant-${'x'.repeat(32)}`,
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('anthropic');
    });

    it('should detect longer Anthropic keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['anthropic'],
      });

      const results = await evaluatePolicies(
        [binding],
        `key: sk-ant-${'x'.repeat(50)}`,
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Stripe Keys ───────────────────────────────────────────

  describe('stripe keys', () => {
    it('should detect Stripe live secret keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['stripe'],
      });

      const results = await evaluatePolicies(
        [binding],
        `key: sk_live_${'x'.repeat(24)}`,
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('stripe');
    });

    it('should detect Stripe live restricted keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['stripe'],
      });

      const results = await evaluatePolicies(
        [binding],
        `key: rk_live_${'x'.repeat(24)}`,
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Private Keys ──────────────────────────────────────────

  describe('private keys', () => {
    it('should detect RSA private keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['privateKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        '-----BEGIN RSA PRIVATE KEY-----',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('privateKey');
    });

    it('should detect EC private keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['privateKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        '-----BEGIN EC PRIVATE KEY-----',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect OpenSSH private keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['privateKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        '-----BEGIN OPENSSH PRIVATE KEY-----',
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect generic private keys', async () => {
      const binding = makeSecretsBinding({
        categories: ['privateKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        '-----BEGIN PRIVATE KEY-----',
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── JWT Tokens ────────────────────────────────────────────

  describe('jwt tokens', () => {
    it('should detect JWT tokens', async () => {
      const binding = makeSecretsBinding({
        categories: ['jwt'],
      });

      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123';
      const results = await evaluatePolicies([binding], `token: ${jwt}`);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('jwt');
    });
  });

  // ─── Slack Tokens ──────────────────────────────────────────

  describe('slack tokens', () => {
    it('should detect Slack bot tokens', async () => {
      const binding = makeSecretsBinding({
        categories: ['slack'],
      });

      const results = await evaluatePolicies(
        [binding],
        `token: xoxb-${'x'.repeat(10)}`,
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('slack');
    });

    it('should detect Slack app tokens', async () => {
      const binding = makeSecretsBinding({
        categories: ['slack'],
      });

      const results = await evaluatePolicies(
        [binding],
        `token: xoxa-${'x'.repeat(10)}`,
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Discord Tokens ────────────────────────────────────────

  describe('discord tokens', () => {
    it('should detect Discord bot tokens', async () => {
      const binding = makeSecretsBinding({
        categories: ['discord'],
      });

      const token = `M${'x'.repeat(23)}.${'y'.repeat(6)}.${'z'.repeat(27)}`;
      const results = await evaluatePolicies([binding], `token: ${token}`);
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('discord');
    });
  });

  // ─── Generic API Keys ──────────────────────────────────────

  describe('generic api keys', () => {
    it('should detect api_key= patterns', async () => {
      const binding = makeSecretsBinding({
        categories: ['genericApiKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        `api_key=${'x'.repeat(32)}`,
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('genericApiKey');
    });

    it('should detect apikey= patterns', async () => {
      const binding = makeSecretsBinding({
        categories: ['genericApiKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        `apikey=${'x'.repeat(32)}`,
      );
      expect(results[0].detections).toHaveLength(1);
    });

    it('should detect secret= patterns', async () => {
      const binding = makeSecretsBinding({
        categories: ['genericApiKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        `secret=${'x'.repeat(32)}`,
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Generic Secrets ───────────────────────────────────────

  describe('generic secrets', () => {
    it('should detect password= patterns', async () => {
      const binding = makeSecretsBinding({
        categories: ['genericSecret'],
      });

      const results = await evaluatePolicies(
        [binding],
        'password=supersecret123',
      );
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('genericSecret');
    });

    it('should not trigger on short passwords (< 8 chars)', async () => {
      const binding = makeSecretsBinding({
        categories: ['genericSecret'],
      });

      const results = await evaluatePolicies([binding], 'password=short');
      // Should not match because pattern requires 8+ chars
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Multiple categories ───────────────────────────────────

  describe('multiple categories', () => {
    it('should detect multiple secret types', async () => {
      const binding = makeSecretsBinding({
        categories: ['aws', 'github'],
      });

      const content = `aws: AKIAIOSFODNN7EXAMPLE, github: ghp_${'x'.repeat(36)}`;
      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections.length).toBeGreaterThanOrEqual(2);
    });

    it('should use all categories by default', async () => {
      const binding = makeSecretsBinding({});

      const results = await evaluatePolicies(
        [binding],
        'My AWS key: AKIAIOSFODNN7EXAMPLE',
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Custom patterns ───────────────────────────────────────

  describe('custom patterns', () => {
    it('should detect custom regex patterns', async () => {
      const binding = makeSecretsBinding({
        categories: [],
        customPatterns: ['\\btoken_[A-Za-z0-9]{32}\\b'],
      });

      const results = await evaluatePolicies(
        [binding],
        `token_${'x'.repeat(32)}`,
      );
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain('custom');
    });

    it('should combine categories with custom patterns', async () => {
      const binding = makeSecretsBinding({
        categories: ['aws'],
        customPatterns: ['\\bcustom_[A-Za-z0-9]{20}\\b'],
      });

      const content = `AKIAIOSFODNN7EXAMPLE and custom_${'x'.repeat(20)}`;
      const results = await evaluatePolicies([binding], content);
      expect(results[0].detections.length).toBeGreaterThanOrEqual(2);
    });

    it('should skip invalid regex patterns', async () => {
      const binding = makeSecretsBinding({
        categories: [],
        customPatterns: ['[invalid(regex', '\\bvalid\\b'],
      });

      const results = await evaluatePolicies(
        [binding],
        'This is valid content',
      );
      expect(results[0].detections).toHaveLength(1);
    });
  });

  // ─── Custom label ──────────────────────────────────────────

  describe('custom label', () => {
    it('should use custom label when provided', async () => {
      const binding = makeSecretsBinding({
        categories: ['aws'],
        label: 'credential-leak',
      });

      const results = await evaluatePolicies([binding], 'AKIAIOSFODNN7EXAMPLE');
      expect(results[0].detections[0].type).toBe('credential-leak');
    });

    it('should default to "secret-detected"', async () => {
      const binding = makeSecretsBinding({
        categories: ['aws'],
      });

      const results = await evaluatePolicies([binding], 'AKIAIOSFODNN7EXAMPLE');
      expect(results[0].detections[0].type).toBe('secret-detected');
    });
  });

  // ─── Clean content ─────────────────────────────────────────

  describe('clean content', () => {
    it('should permit normal conversation', async () => {
      const binding = makeSecretsBinding({
        categories: ['aws', 'github', 'openai'],
      });

      const results = await evaluatePolicies(
        [binding],
        'I need to configure my AWS account and set up GitHub integration.',
      );
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should not false positive on code snippets without actual secrets', async () => {
      const binding = makeSecretsBinding({
        categories: ['genericApiKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        'You should set api_key in the config',
      );
      // Should not match because no actual long secret value
      expect(results[0].decision).toBe('permit');
    });
  });

  // ─── Confidence levels ─────────────────────────────────────

  describe('confidence levels', () => {
    it('should have high confidence (0.95) for known provider patterns', async () => {
      const binding = makeSecretsBinding({
        categories: ['aws'],
      });

      const results = await evaluatePolicies([binding], 'AKIAIOSFODNN7EXAMPLE');
      expect(results[0].detections[0].confidence).toBe(0.95);
    });

    it('should have lower confidence (0.8) for generic patterns', async () => {
      const binding = makeSecretsBinding({
        categories: ['genericApiKey'],
      });

      const results = await evaluatePolicies(
        [binding],
        `api_key=${'x'.repeat(32)}`,
      );
      expect(results[0].detections[0].confidence).toBe(0.8);
    });

    it('should have 0.8 confidence for custom patterns', async () => {
      const binding = makeSecretsBinding({
        categories: [],
        customPatterns: ['\\bsecret\\b'],
      });

      const results = await evaluatePolicies([binding], 'This is a secret');
      expect(results[0].detections[0].confidence).toBe(0.8);
    });
  });

  // ─── Decision logic ────────────────────────────────────────

  describe('decision logic integration', () => {
    it('should flag (not block) when effect is permit', async () => {
      const binding = makeSecretsBinding(
        { categories: ['aws'] },
        { effect: 'flag' },
      );

      const results = await evaluatePolicies([binding], 'AKIAIOSFODNN7EXAMPLE');
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      expect(results[0].detections).toHaveLength(1);
    });
  });
});
