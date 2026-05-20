// SPDX-License-Identifier: Apache-2.0

/**
 * Policy SDK — BasePolicyEngine Unit Tests
 *
 * Tests the abstract base class helper methods: detection(), getConfig(),
 * containsAny(), matchesAny(), countMatches().
 */

import { BasePolicyEngine } from '@spellguard/policy-sdk';
import type { Detection, PolicyRequest } from '@spellguard/policy-sdk';
import { describe, expect, it } from 'vitest';

// ─── Concrete test implementation ─────────────────────────────

class TestEngine extends BasePolicyEngine {
  name = 'test-engine';

  evaluate(_request: PolicyRequest): Detection[] {
    return [];
  }

  // Expose protected methods for testing
  public testDetection(
    type: string,
    confidence: number,
    message?: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.detection(type, confidence, message, metadata);
  }

  public testGetConfig<T>(
    request: PolicyRequest,
    key: string,
    defaultValue: T,
  ) {
    return this.getConfig(request, key, defaultValue);
  }

  public testContainsAny(content: string, values: string[]) {
    return this.containsAny(content, values);
  }

  public testMatchesAny(content: string, patterns: RegExp[]) {
    return this.matchesAny(content, patterns);
  }

  public testCountMatches(content: string, pattern: RegExp) {
    return this.countMatches(content, pattern);
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function makeRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    content: 'test content',
    policyId: 'test-id',
    policySlug: 'test-slug',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe('BasePolicyEngine', () => {
  const engine = new TestEngine();

  // ─── name property ────────────────────────────────────────

  it('should expose name property', () => {
    expect(engine.name).toBe('test-engine');
  });

  // ─── detection() ──────────────────────────────────────────

  describe('detection()', () => {
    it('should create a detection with type and confidence', () => {
      const d = engine.testDetection('pii-email', 0.9);
      expect(d.type).toBe('pii-email');
      expect(d.confidence).toBe(0.9);
      expect(d.message).toBeUndefined();
      expect(d.metadata).toBeUndefined();
    });

    it('should include message when provided', () => {
      const d = engine.testDetection('issue', 0.8, 'Found an issue');
      expect(d.message).toBe('Found an issue');
    });

    it('should include metadata when provided', () => {
      const d = engine.testDetection('issue', 0.8, 'msg', { key: 'value' });
      expect(d.metadata).toEqual({ key: 'value' });
    });

    it('should clamp confidence below 0 to 0', () => {
      const d = engine.testDetection('test', -0.5);
      expect(d.confidence).toBe(0);
    });

    it('should clamp confidence above 1 to 1', () => {
      const d = engine.testDetection('test', 1.5);
      expect(d.confidence).toBe(1);
    });

    it('should pass through confidence exactly 0', () => {
      const d = engine.testDetection('test', 0);
      expect(d.confidence).toBe(0);
    });

    it('should pass through confidence exactly 1', () => {
      const d = engine.testDetection('test', 1);
      expect(d.confidence).toBe(1);
    });

    it('should pass through valid confidence 0.5', () => {
      const d = engine.testDetection('test', 0.5);
      expect(d.confidence).toBe(0.5);
    });

    it('should preserve empty metadata object', () => {
      const d = engine.testDetection('test', 0.5, undefined, {});
      expect(d.metadata).toEqual({});
    });
  });

  // ─── getConfig() ──────────────────────────────────────────

  describe('getConfig()', () => {
    it('should return default when config is undefined', () => {
      const request = makeRequest({ config: undefined });
      expect(engine.testGetConfig(request, 'key', 'default')).toBe('default');
    });

    it('should return default when key does not exist', () => {
      const request = makeRequest({ config: { other: 'value' } });
      expect(engine.testGetConfig(request, 'missing', 42)).toBe(42);
    });

    it('should return actual value when key exists', () => {
      const request = makeRequest({ config: { threshold: 0.8 } });
      expect(engine.testGetConfig(request, 'threshold', 0.5)).toBe(0.8);
    });

    it('should return string array config', () => {
      const request = makeRequest({ config: { items: ['a', 'b', 'c'] } });
      expect(engine.testGetConfig(request, 'items', [])).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('should return boolean config', () => {
      const request = makeRequest({ config: { enabled: false } });
      expect(engine.testGetConfig(request, 'enabled', true)).toBe(false);
    });

    it('should return null from config (not defaultValue)', () => {
      const request = makeRequest({ config: { key: null } });
      expect(engine.testGetConfig(request, 'key', 'default')).toBeNull();
    });

    it('should return default when value is explicitly undefined', () => {
      const request = makeRequest({ config: { key: undefined } });
      expect(engine.testGetConfig(request, 'key', 'default')).toBe('default');
    });

    it('should return object config', () => {
      const request = makeRequest({ config: { nested: { a: 1, b: 2 } } });
      expect(engine.testGetConfig(request, 'nested', {})).toEqual({
        a: 1,
        b: 2,
      });
    });
  });

  // ─── containsAny() ───────────────────────────────────────

  describe('containsAny()', () => {
    it('should return the matching value (case-insensitive)', () => {
      const result = engine.testContainsAny('I use OpenAI daily', [
        'openai',
        'anthropic',
      ]);
      expect(result).toBe('openai');
    });

    it('should return original casing from values array', () => {
      const result = engine.testContainsAny('i use openai daily', [
        'OpenAI',
        'Anthropic',
      ]);
      expect(result).toBe('OpenAI');
    });

    it('should return null when no matches found', () => {
      const result = engine.testContainsAny('Hello world', [
        'secret',
        'password',
      ]);
      expect(result).toBeNull();
    });

    it('should match case-insensitively', () => {
      const result = engine.testContainsAny('OPENAI is great', ['openai']);
      expect(result).toBe('openai');
    });

    it('should return null for empty values array', () => {
      const result = engine.testContainsAny('any content', []);
      expect(result).toBeNull();
    });

    it('should return null for empty content', () => {
      const result = engine.testContainsAny('', ['test']);
      expect(result).toBeNull();
    });

    it('should match partial words in content', () => {
      const result = engine.testContainsAny('Our partner is OpenAI Corp', [
        'openai',
      ]);
      expect(result).toBe('openai');
    });

    it('should return the first matching value', () => {
      const result = engine.testContainsAny('I use OpenAI and Anthropic', [
        'anthropic',
        'openai',
      ]);
      // "anthropic" appears after "openai" in text, but we iterate values in order
      // The code iterates values[], so 'anthropic' is checked first but appears later in text
      // containsAny checks values in order, "anthropic" is found first since it checks lower.includes
      expect(result).toBe('anthropic');
    });
  });

  // ─── matchesAny() ────────────────────────────────────────

  describe('matchesAny()', () => {
    it('should return match array for simple pattern', () => {
      const result = engine.testMatchesAny('this has a secret', [/secret/]);
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe('secret');
    });

    it('should return null when no patterns match', () => {
      const result = engine.testMatchesAny('clean content', [
        /secret/,
        /password/,
      ]);
      expect(result).toBeNull();
    });

    it('should return null for empty patterns array', () => {
      const result = engine.testMatchesAny('any content', []);
      expect(result).toBeNull();
    });

    it('should work with case-insensitive flag', () => {
      const result = engine.testMatchesAny('SECRET data', [/secret/i]);
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe('SECRET');
    });

    it('should work with capturing groups', () => {
      const result = engine.testMatchesAny('SSN: 123-45-6789', [
        /(\d{3})-(\d{2})-(\d{4})/,
      ]);
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe('123-45-6789');
      expect(result?.[1]).toBe('123');
      expect(result?.[2]).toBe('45');
      expect(result?.[3]).toBe('6789');
    });

    it('should return first matching pattern', () => {
      const result = engine.testMatchesAny('foo bar baz', [/bar/, /foo/]);
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe('bar');
    });

    it('should work with complex regex', () => {
      const result = engine.testMatchesAny('email: test@example.com', [
        /[\w.+-]+@[\w-]+\.[\w.]+/,
      ]);
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe('test@example.com');
    });
  });

  // ─── countMatches() ──────────────────────────────────────

  describe('countMatches()', () => {
    it('should count single match', () => {
      expect(engine.testCountMatches('one secret here', /secret/)).toBe(1);
    });

    it('should count multiple matches', () => {
      expect(engine.testCountMatches('foo bar foo baz foo', /foo/)).toBe(3);
    });

    it('should return 0 for no matches', () => {
      expect(engine.testCountMatches('clean content', /secret/)).toBe(0);
    });

    it('should be case-insensitive (uses gi flags internally)', () => {
      expect(engine.testCountMatches('FOO foo Foo', /foo/)).toBe(3);
    });

    it('should count with word boundary patterns', () => {
      // The implementation uses new RegExp(pattern.source, 'gi'), so flags from
      // the original pattern are overridden with 'gi'
      expect(engine.testCountMatches('pass password pass', /\bpass\b/)).toBe(2);
    });

    it('should return 0 for empty content', () => {
      expect(engine.testCountMatches('', /test/)).toBe(0);
    });
  });

  // ─── evaluate() abstract ─────────────────────────────────

  describe('evaluate()', () => {
    it('should be callable on concrete implementation', async () => {
      const request = makeRequest();
      const result = await engine.evaluate(request);
      expect(result).toEqual([]);
    });
  });
});
