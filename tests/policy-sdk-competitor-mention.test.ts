// SPDX-License-Identifier: Apache-2.0

/**
 * Policy SDK — Competitor Mention Example Policy Tests
 *
 * Tests the CompetitorMentionPolicy from examples/policies/competitor-mention/.
 * We can't import the module directly (it calls servePolicyEngine at module level),
 * so we recreate the engine class here matching the example's logic.
 */

import { BasePolicyEngine } from '@spellguard/policy-sdk';
import type { Detection, PolicyRequest } from '@spellguard/policy-sdk';
import { mockRequest } from '@spellguard/policy-sdk/testing';
import { describe, expect, it } from 'vitest';

// ─── Recreate the example policy engine ───────────────────────
// Mirrors examples/policies/competitor-mention/src/index.ts

class CompetitorMentionPolicy extends BasePolicyEngine {
  name = 'competitor-mention';

  evaluate(request: PolicyRequest): Detection[] {
    const detections: Detection[] = [];

    const competitors = this.getConfig<string[]>(request, 'competitors', [
      'openai',
      'anthropic',
      'google',
      'microsoft',
      'meta',
    ]);

    const blockMentions = this.getConfig<boolean>(
      request,
      'blockMentions',
      true,
    );
    const minConfidence = this.getConfig<number>(request, 'minConfidence', 0.8);

    const found = this.containsAny(request.content, competitors);

    if (found) {
      detections.push(
        this.detection(
          'competitor-mention',
          minConfidence,
          `Competitor "${found}" mentioned in content`,
          { competitor: found, action: blockMentions ? 'block' : 'flag' },
        ),
      );
    }

    return detections;
  }
}

// ─── Tests ────────────────────────────────────────────────────

describe('CompetitorMentionPolicy', () => {
  const engine = new CompetitorMentionPolicy();

  // ─── Name ─────────────────────────────────────────────────

  it('should have name "competitor-mention"', () => {
    expect(engine.name).toBe('competitor-mention');
  });

  // ─── Default competitors ──────────────────────────────────

  describe('default competitors', () => {
    it('should detect "openai"', async () => {
      const req = mockRequest('What about using OpenAI?');
      const detections = await engine.evaluate(req);

      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('competitor-mention');
      expect(detections[0].confidence).toBe(0.8);
      expect(detections[0].message).toContain('openai');
      expect(detections[0].metadata?.competitor).toBe('openai');
      expect(detections[0].metadata?.action).toBe('block');
    });

    it('should detect "anthropic"', async () => {
      const detections = await engine.evaluate(
        mockRequest('Try Anthropic instead'),
      );
      expect(detections).toHaveLength(1);
      expect(detections[0].metadata?.competitor).toBe('anthropic');
    });

    it('should detect "google"', async () => {
      const detections = await engine.evaluate(
        mockRequest('Use Google Gemini'),
      );
      expect(detections).toHaveLength(1);
      expect(detections[0].metadata?.competitor).toBe('google');
    });

    it('should detect "microsoft"', async () => {
      const detections = await engine.evaluate(
        mockRequest('Microsoft Copilot is good'),
      );
      expect(detections).toHaveLength(1);
      expect(detections[0].metadata?.competitor).toBe('microsoft');
    });

    it('should detect "meta"', async () => {
      const detections = await engine.evaluate(mockRequest('Meta Llama model'));
      expect(detections).toHaveLength(1);
      expect(detections[0].metadata?.competitor).toBe('meta');
    });
  });

  // ─── Case insensitivity ───────────────────────────────────

  describe('case insensitivity', () => {
    it('should match uppercase "OPENAI"', async () => {
      const detections = await engine.evaluate(
        mockRequest('Check OPENAI docs'),
      );
      expect(detections).toHaveLength(1);
    });

    it('should match mixed case "OpenAI"', async () => {
      const detections = await engine.evaluate(
        mockRequest('OpenAI is a company'),
      );
      expect(detections).toHaveLength(1);
    });

    it('should match lowercase "openai"', async () => {
      const detections = await engine.evaluate(mockRequest('use openai api'));
      expect(detections).toHaveLength(1);
    });
  });

  // ─── No matches ───────────────────────────────────────────

  describe('no matches', () => {
    it('should return empty array for clean content', async () => {
      const detections = await engine.evaluate(
        mockRequest('This is a normal message'),
      );
      expect(detections).toEqual([]);
    });

    it('should return empty array for empty content', async () => {
      const detections = await engine.evaluate(mockRequest(''));
      expect(detections).toEqual([]);
    });
  });

  // ─── Custom competitors config ────────────────────────────

  describe('custom competitors config', () => {
    it('should use custom competitors list', async () => {
      const req = mockRequest('Check out AWS services', {
        config: { competitors: ['aws', 'azure'] },
      });
      const detections = await engine.evaluate(req);

      expect(detections).toHaveLength(1);
      expect(detections[0].metadata?.competitor).toBe('aws');
    });

    it('should not detect defaults when custom list provided', async () => {
      const req = mockRequest('OpenAI is great', {
        config: { competitors: ['aws', 'azure'] },
      });
      const detections = await engine.evaluate(req);

      expect(detections).toEqual([]);
    });

    it('should handle empty competitors array', async () => {
      const req = mockRequest('OpenAI Microsoft Google', {
        config: { competitors: [] },
      });
      const detections = await engine.evaluate(req);

      expect(detections).toEqual([]);
    });
  });

  // ─── blockMentions config ─────────────────────────────────

  describe('blockMentions config', () => {
    it('should default to action "block"', async () => {
      const detections = await engine.evaluate(mockRequest('Use OpenAI'));
      expect(detections[0].metadata?.action).toBe('block');
    });

    it('should set action "flag" when blockMentions is false', async () => {
      const req = mockRequest('Use OpenAI', {
        config: { blockMentions: false },
      });
      const detections = await engine.evaluate(req);

      expect(detections[0].metadata?.action).toBe('flag');
    });

    it('should set action "block" when blockMentions is true', async () => {
      const req = mockRequest('Use OpenAI', {
        config: { blockMentions: true },
      });
      const detections = await engine.evaluate(req);

      expect(detections[0].metadata?.action).toBe('block');
    });
  });

  // ─── minConfidence config ─────────────────────────────────

  describe('minConfidence config', () => {
    it('should default to 0.8 confidence', async () => {
      const detections = await engine.evaluate(mockRequest('Use OpenAI'));
      expect(detections[0].confidence).toBe(0.8);
    });

    it('should use custom minConfidence', async () => {
      const req = mockRequest('Use OpenAI', {
        config: { minConfidence: 0.95 },
      });
      const detections = await engine.evaluate(req);

      expect(detections[0].confidence).toBe(0.95);
    });

    it('should use low minConfidence', async () => {
      const req = mockRequest('Use OpenAI', {
        config: { minConfidence: 0.3 },
      });
      const detections = await engine.evaluate(req);

      expect(detections[0].confidence).toBe(0.3);
    });
  });

  // ─── Detection shape ──────────────────────────────────────

  describe('detection shape', () => {
    it('should return properly shaped detection', async () => {
      const detections = await engine.evaluate(
        mockRequest('OpenAI is mentioned'),
      );

      expect(detections).toHaveLength(1);
      const d = detections[0];
      expect(d).toHaveProperty('type', 'competitor-mention');
      expect(d).toHaveProperty('confidence');
      expect(d).toHaveProperty('message');
      expect(d).toHaveProperty('metadata');
      expect(d.metadata).toHaveProperty('competitor');
      expect(d.metadata).toHaveProperty('action');
    });

    it('should include competitor name in message', async () => {
      const detections = await engine.evaluate(mockRequest('Try Google AI'));
      expect(detections[0].message).toContain('google');
    });
  });

  // ─── Partial match ────────────────────────────────────────

  describe('partial matching', () => {
    it('should match competitor as substring', async () => {
      const detections = await engine.evaluate(
        mockRequest('The OpenAI-powered system works'),
      );
      expect(detections).toHaveLength(1);
    });

    it('should detect only the first matching competitor', async () => {
      // containsAny returns the first match from the values array
      const detections = await engine.evaluate(
        mockRequest('OpenAI and Google and Microsoft'),
      );
      // Only one detection because containsAny returns first match and the
      // engine only pushes one detection
      expect(detections).toHaveLength(1);
    });
  });
});
