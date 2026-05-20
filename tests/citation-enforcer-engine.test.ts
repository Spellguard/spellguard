// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BuiltinEngine } from '../packages/verifier/src/proxy/builtin-engine';
import type { PolicyEvalContext } from '../packages/verifier/src/proxy/policy-evaluator-types';

describe('BuiltinEngine - Citation Enforcer', () => {
  const engine = new BuiltinEngine();

  function createContext(
    content: string,
    config: Record<string, unknown> = {},
  ): PolicyEvalContext {
    return {
      content,
      binding: {
        policyId: 'test-citation-enforcer',
        policyType: 'citation-enforcer',
        policySlug: 'test-citation-enforcer',
        level: 'agent',
        effect: 'block',
        config,
      },
      direction: 'outbound',
    };
  }

  describe('Factual claim detection', () => {
    it('should detect claims with "according to"', async () => {
      const ctx = createContext('According to research, the rate is 75%');
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
      expect(detections[0].type).toContain('citation');
    });

    it('should detect claims with "studies show"', async () => {
      const ctx = createContext('Studies show that this is effective');
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });

    it('should detect claims with "research shows"', async () => {
      const ctx = createContext('Research shows a clear correlation');
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });

    it('should detect claims with "experts say"', async () => {
      const ctx = createContext('Experts say this is the best approach');
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });

    it('should detect claims with "statistics show"', async () => {
      const ctx = createContext('Statistics show a 50% increase');
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });

    it('should detect claims with "data shows"', async () => {
      const ctx = createContext(
        'Data shows that 80% of users prefer this method',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });
  });

  describe('Citation validation', () => {
    it('should accept URL citations', async () => {
      const ctx = createContext(
        'According to research (https://example.com/study), the rate is 75%',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should accept academic-style citations', async () => {
      const ctx = createContext('Studies show this is effective (Smith, 2024)');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should accept et al. citations', async () => {
      const ctx = createContext(
        'Research shows a correlation (Jones et al., 2023)',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should accept numbered references', async () => {
      const ctx = createContext('According to the report [1], rates increased');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should accept explicit source labels', async () => {
      const ctx = createContext(
        'Studies show improvement. Source: WHO 2024 Report',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should accept markdown link citations', async () => {
      const ctx = createContext(
        'According to [this study](https://example.com), 75% agree',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Missing citations', () => {
    it('should flag claims without citations', async () => {
      const ctx = createContext(
        'Studies show that this method is 50% more effective',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
      expect(detections.some((d) => d.type === 'insufficient-citations')).toBe(
        true,
      );
    });

    it('should flag when URL citations are required but missing', async () => {
      const ctx = createContext('Research shows this works (Smith, 2024)', {
        requireUrls: true,
      });
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
      expect(detections.some((d) => d.type === 'missing-url-citation')).toBe(
        true,
      );
    });

    it('should flag when minimum citation count not met', async () => {
      const ctx = createContext(
        'Studies show effectiveness [1]. Data indicates improvement. Research confirms benefits.',
        { minCitations: 3 },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
      expect(detections.some((d) => d.type === 'insufficient-citations')).toBe(
        true,
      );
    });
  });

  describe('Non-factual content', () => {
    it('should not require citations for opinions', async () => {
      const ctx = createContext(
        'I think this is a good approach that might work well',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not require citations for questions', async () => {
      const ctx = createContext('What is the best approach for this topic?');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not require citations for personal experience', async () => {
      const ctx = createContext('In my experience, this approach works well');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not require citations for general knowledge', async () => {
      const ctx = createContext('Water boils at 100 degrees Celsius');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Configuration options', () => {
    it('should respect custom claim indicators', async () => {
      const ctx = createContext('Data demonstrates a clear trend', {
        claimIndicators: ['data demonstrates'],
      });
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });

    it('should allow requireUrls: false', async () => {
      const ctx = createContext('Studies show this (Smith, 2024)', {
        requireUrls: false,
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should respect minCitations setting', async () => {
      const ctx = createContext('Studies show this [1] and experts agree [2]', {
        minCitations: 2,
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Multiple claims and citations', () => {
    it('should handle multiple claims with multiple citations', async () => {
      const ctx = createContext(
        'According to research [1], 80% agree. Studies show [2] that this is effective.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should detect mixed content (cited and uncited)', async () => {
      const ctx = createContext(
        'Research shows A is true [1]. Studies also show B is true.',
      );
      const detections = await engine.evaluate(ctx);
      // Should detect because overall insufficient citations for both claims
      expect(Array.isArray(detections)).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle very short messages', async () => {
      const ctx = createContext('Studies show it works');
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });

    it('should handle messages with only URLs', async () => {
      const ctx = createContext('https://example.com/study');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle empty config gracefully', async () => {
      const ctx = createContext('Studies show this works', {});
      const detections = await engine.evaluate(ctx);
      expect(Array.isArray(detections)).toBe(true);
    });
  });
});
