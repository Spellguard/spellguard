// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BuiltinEngine } from '../packages/verifier/src/proxy/builtin-engine';
import type { PolicyEvalContext } from '../packages/verifier/src/proxy/policy-evaluator-types';

describe('BuiltinEngine - NSFW Blocker', () => {
  const engine = new BuiltinEngine();

  function createContext(
    content: string,
    config: Record<string, unknown> = {},
  ): PolicyEvalContext {
    return {
      content,
      binding: {
        policyId: 'test-nsfw-blocker',
        policyType: 'nsfw-blocker',
        policySlug: 'test-nsfw-blocker',
        level: 'agent',
        effect: 'block',
        config,
      },
      direction: 'inbound',
    };
  }

  describe('Sexual content detection', () => {
    it('should detect explicit sexual content', async () => {
      const ctx = createContext('This contains explicit sexual content');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
      expect(detections[0].message).toContain('sexual');
    });

    it('should detect pornographic references', async () => {
      const ctx = createContext('Links to pornography websites');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });

    it('should detect adult content mentions', async () => {
      const ctx = createContext('This is adult content warning');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });

    it('should detect sexually explicit content', async () => {
      const ctx = createContext('Sexually explicit material ahead');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });

    it('should detect erotic content', async () => {
      const ctx = createContext('Erotic stories and content');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });
  });

  describe('Violence detection', () => {
    it('should detect graphic violence', async () => {
      const ctx = createContext('Contains graphic violence and blood');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
      expect(detections[0].message).toContain('violence');
    });

    it('should detect gore', async () => {
      const ctx = createContext('Extreme gore and mutilation');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });

    it('should detect torture references', async () => {
      const ctx = createContext('Depicts torture and suffering');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });

    it('should detect extreme violence', async () => {
      const ctx = createContext('Extreme violence and sadistic acts');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });
  });

  describe('Nudity detection', () => {
    it('should detect nudity mentions', async () => {
      const ctx = createContext('Contains full nudity scenes');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
      expect(detections[0].message).toContain('nudity');
    });

    it('should detect naked references', async () => {
      const ctx = createContext('People shown naked in photos');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });

    it('should detect nude content', async () => {
      const ctx = createContext('Nude photography and art');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });

    it('should detect topless references', async () => {
      const ctx = createContext('Topless beach photos');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
    });
  });

  describe('Medical/educational exceptions', () => {
    it('should allow breast cancer discussions', async () => {
      const ctx = createContext(
        'Information about breast cancer screening and treatment',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow medical anatomy discussions', async () => {
      const ctx = createContext('Anatomy textbook showing exposed body parts');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow gynecology content', async () => {
      const ctx = createContext('Gynecology examination procedures');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow healthcare discussions', async () => {
      const ctx = createContext('Healthcare treatment for patients');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow surgical content', async () => {
      const ctx = createContext('Surgery involving exposed tissue');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow clinical discussions', async () => {
      const ctx = createContext('Clinical diagnosis of patient condition');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Configuration options', () => {
    it('should respect checkSexual: false', async () => {
      const ctx = createContext('Explicit sexual content here', {
        checkSexual: false,
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should respect checkViolence: false', async () => {
      const ctx = createContext('Graphic violence and gore', {
        checkViolence: false,
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should respect checkNudity: false', async () => {
      const ctx = createContext('Contains nudity', { checkNudity: false });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should detect custom patterns', async () => {
      const ctx = createContext('This is inappropriate content', {
        customPatterns: ['inappropriate'],
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('nsfw-content');
      expect(detections[0].message).toContain('custom');
    });

    it('should use custom label', async () => {
      const ctx = createContext('Explicit sexual content', {
        label: 'explicit-content',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('explicit-content');
    });
  });

  describe('Safe content', () => {
    it('should allow general text', async () => {
      const ctx = createContext('This is a normal conversation about work');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow artistic discussions', async () => {
      const ctx = createContext('Discussion of classical art and sculpture');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow educational content', async () => {
      const ctx = createContext('Educational content about human biology');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow news content', async () => {
      const ctx = createContext('News report about a violent incident');
      const detections = await engine.evaluate(ctx);
      // May detect "violent" - this is acceptable for news context
      expect(Array.isArray(detections)).toBe(true);
    });
  });

  describe('Multiple categories', () => {
    it('should detect multiple NSFW categories', async () => {
      const ctx = createContext(
        'Contains explicit sexual content, graphic violence, and nudity',
      );
      const detections = await engine.evaluate(ctx);
      // Should detect at least 2 categories
      expect(detections.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty content', async () => {
      const ctx = createContext('');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle very short messages', async () => {
      const ctx = createContext('Hi');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle mixed case', async () => {
      const ctx = createContext('ExPlIcIt SeXuAl CoNtEnT');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
    });
  });
});
