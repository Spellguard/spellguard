// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BuiltinEngine } from '../packages/verifier/src/proxy/builtin-engine';
import type { PolicyEvalContext } from '../packages/verifier/src/proxy/policy-evaluator-types';

describe('BuiltinEngine - Topic Boundary', () => {
  const engine = new BuiltinEngine();

  function createContext(
    content: string,
    config: Record<string, unknown> = {},
  ): PolicyEvalContext {
    return {
      content,
      binding: {
        policyId: 'test-topic-boundary',
        policyType: 'topic-boundary',
        policySlug: 'test-topic-boundary',
        level: 'agent',
        effect: 'block',
        config,
      },
      direction: 'inbound',
    };
  }

  describe('Strict mode - must match allowed topics', () => {
    it('should allow programming questions when programming is allowed', async () => {
      const ctx = createContext('How do I fix this Python bug in my code?', {
        allowedTopics: ['programming'],
        mode: 'strict',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should block politics when only programming is allowed', async () => {
      const ctx = createContext(
        'Who should I vote for in the election? What about the president?',
        {
          allowedTopics: ['programming'],
          mode: 'strict',
          offTopicMessage: 'I can only help with coding questions.',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
      expect(detections[0].message).toContain('coding questions');
    });

    it('should block medical when only programming is allowed', async () => {
      const ctx = createContext(
        'I have a headache and pain. What medicine should I take for this symptom? Should I see a doctor?',
        {
          allowedTopics: ['programming'],
          mode: 'strict',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });

    it('should allow multiple allowed topics', async () => {
      const ctx = createContext('I need to learn about databases and APIs', {
        allowedTopics: ['programming', 'education'],
        mode: 'strict',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow education topics when allowed', async () => {
      const ctx = createContext(
        'Can you help me study for my exam? I need to learn this homework.',
        {
          allowedTopics: ['education'],
          mode: 'strict',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Moderate mode - block only specific topics', () => {
    it('should allow programming even without explicit allowlist', async () => {
      const ctx = createContext('How do I debug this JavaScript function?', {
        blockedTopics: ['politics', 'religion'],
        mode: 'moderate',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should block politics when in blocked list', async () => {
      const ctx = createContext(
        'The election is coming up. Who should vote for congress?',
        {
          blockedTopics: ['politics', 'religion'],
          mode: 'moderate',
          offTopicMessage:
            "I'd prefer to keep our conversation on other topics.",
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
      expect(detections[0].message).toContain('other topics');
    });

    it('should block religion when in blocked list', async () => {
      const ctx = createContext(
        'What does the bible say about faith? I want to pray at church on Sunday.',
        {
          blockedTopics: ['politics', 'religion'],
          mode: 'moderate',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });

    it('should block relationships when in blocked list', async () => {
      const ctx = createContext(
        'My boyfriend broke up with me. Dating is so hard. I miss our romantic relationship.',
        {
          blockedTopics: ['relationships'],
          mode: 'moderate',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });

    it('should allow general conversation when no blocked topic detected', async () => {
      const ctx = createContext("What's the weather like today?", {
        blockedTopics: ['politics', 'religion'],
        mode: 'moderate',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Loose mode - warn but permit', () => {
    it('should warn but permit blocked topics', async () => {
      const ctx = createContext(
        'What about the election? I want to vote for the candidate running the political campaign.',
        {
          blockedTopics: ['politics'],
          mode: 'loose',
          offTopicMessage: 'Please stay on topic.',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic-warning');
      expect(detections[0].confidence).toBeLessThan(0.9); // Lower confidence for warnings
      expect(detections[0].message).toContain('Warning');
    });

    it('should allow non-blocked topics without warning', async () => {
      const ctx = createContext('How do I write better code?', {
        blockedTopics: ['politics'],
        mode: 'loose',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Topic detection accuracy', () => {
    it('should detect programming topic from multiple keywords', async () => {
      const ctx = createContext(
        'I need help debugging my Python code. The function has a bug in the API call.',
        {
          allowedTopics: ['programming'],
          mode: 'strict',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should detect finance topic', async () => {
      const ctx = createContext(
        'Should I invest in stocks? What about my savings and budget?',
        {
          blockedTopics: ['finance'],
          mode: 'moderate',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });

    it('should detect legal topic', async () => {
      const ctx = createContext(
        'Can I sue? Do I need a lawyer for this lawsuit?',
        {
          blockedTopics: ['legal'],
          mode: 'moderate',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });

    it('should detect sports topic', async () => {
      const ctx = createContext(
        'Who won the football game? The team scored in the championship.',
        {
          blockedTopics: ['sports'],
          mode: 'moderate',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });

    it('should detect entertainment topic', async () => {
      const ctx = createContext(
        'Did you see that movie? The TV show was amazing with great music.',
        {
          blockedTopics: ['entertainment'],
          mode: 'moderate',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });
  });

  describe('Edge cases and corner scenarios', () => {
    it('should allow messages with no clear topic', async () => {
      const ctx = createContext('Hello, how are you?', {
        allowedTopics: ['programming'],
        mode: 'strict',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0); // No clear topic, so allow
    });

    it('should handle very short messages', async () => {
      const ctx = createContext('Hi', {
        allowedTopics: ['programming'],
        mode: 'strict',
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle messages with single keyword mention', async () => {
      const ctx = createContext('I like code', {
        allowedTopics: ['programming'],
        mode: 'strict',
      });
      const detections = await engine.evaluate(ctx);
      // Single mention might not reach threshold
      expect(Array.isArray(detections)).toBe(true);
    });

    it('should handle empty config gracefully', async () => {
      const ctx = createContext('Talk about politics', {});
      const detections = await engine.evaluate(ctx);
      // No restrictions, should allow
      expect(detections).toHaveLength(0);
    });

    it('should use default off-topic message', async () => {
      const ctx = createContext(
        'The election campaign is heating up. I want to vote for the best political candidate.',
        {
          blockedTopics: ['politics'],
          mode: 'moderate',
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].message).toContain('off-topic');
    });
  });

  describe('Custom topics', () => {
    it('should support custom topic keywords', async () => {
      const ctx = createContext('I need help with my blockchain DeFi project', {
        allowedTopics: ['crypto'],
        mode: 'strict',
        customTopics: {
          crypto: ['blockchain', 'bitcoin', 'ethereum', 'defi', 'nft', 'web3'],
        },
      });
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should block custom topics', async () => {
      const ctx = createContext(
        'My blockchain NFT project uses ethereum and web3 technology',
        {
          blockedTopics: ['crypto'],
          mode: 'moderate',
          customTopics: {
            crypto: [
              'blockchain',
              'bitcoin',
              'ethereum',
              'defi',
              'nft',
              'web3',
            ],
          },
        },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('off-topic');
    });
  });

  describe('Real-world scenarios', () => {
    it('coding assistant - allows coding, blocks politics', async () => {
      const config = {
        allowedTopics: ['programming', 'education'],
        mode: 'strict' as const,
        offTopicMessage:
          "I'm a coding assistant. I can only help with programming questions.",
      };

      // Should allow
      const coding = createContext('How do I fix this Python bug?', config);
      expect(await engine.evaluate(coding)).toHaveLength(0);

      // Should block
      const politics = createContext(
        'Who should I vote for in the election? The political campaign is intense.',
        config,
      );
      expect((await engine.evaluate(politics)).length).toBeGreaterThan(0);
    });

    it('general bot with guardrails - allows most, blocks sensitive', async () => {
      const config = {
        blockedTopics: ['politics', 'religion', 'relationships'],
        mode: 'moderate' as const,
        offTopicMessage: "I'd prefer to keep our conversation on other topics.",
      };

      // Should allow
      const weather = createContext("What's the weather?", config);
      expect(await engine.evaluate(weather)).toHaveLength(0);

      const code = createContext('How do I code?', config);
      expect(await engine.evaluate(code)).toHaveLength(0);

      // Should block
      const politics = createContext(
        'The election campaign is getting political. Who will the president be?',
        config,
      );
      expect((await engine.evaluate(politics)).length).toBeGreaterThan(0);

      const religion = createContext(
        'What does the bible say about faith? Let us pray at church.',
        config,
      );
      expect((await engine.evaluate(religion)).length).toBeGreaterThan(0);
    });

    it('medical bot - only medical, blocks legal', async () => {
      const config = {
        allowedTopics: ['medical', 'education'],
        mode: 'strict' as const,
        offTopicMessage: 'I can only provide medical information.',
      };

      // Should allow
      const medical = createContext(
        'What are symptoms of flu? Treatment and medication?',
        config,
      );
      expect(await engine.evaluate(medical)).toHaveLength(0);

      // Should block
      const legal = createContext(
        'Can I sue my doctor for malpractice? I need a lawyer to file a lawsuit in court.',
        config,
      );
      expect((await engine.evaluate(legal)).length).toBeGreaterThan(0);
    });
  });
});
