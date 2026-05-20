// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BuiltinEngine } from '../packages/verifier/src/proxy/builtin-engine';
import type { PolicyEvalContext } from '../packages/verifier/src/proxy/policy-evaluator-types';

describe('BuiltinEngine - Financial Disclaimer', () => {
  const engine = new BuiltinEngine();

  function createContext(
    content: string,
    config: Record<string, unknown> = {},
  ): PolicyEvalContext {
    return {
      content,
      binding: {
        policyId: 'test-financial-disclaimer',
        policyType: 'financial-disclaimer',
        policySlug: 'test-financial-disclaimer',
        level: 'agent',
        effect: 'block',
        config,
      },
      direction: 'outbound',
    } as PolicyEvalContext;
  }

  describe('Financial advice detection', () => {
    it('should detect "should invest" as financial advice', async () => {
      const ctx = createContext(
        'You should invest in index funds for long-term growth.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
      expect(detections[0].confidence).toBe(0.9);
    });

    it('should detect "recommend buying" as financial advice', async () => {
      const ctx = createContext(
        'I recommend buying stocks in the tech sector.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });

    it('should detect "consider trading" as financial advice', async () => {
      const ctx = createContext(
        'You should consider trading ETFs for better diversification.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });

    it('should detect "must diversify" as financial advice', async () => {
      const ctx = createContext(
        'You must diversify your portfolio across asset classes.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });

    it('should detect "need to" + financial term as advice', async () => {
      const ctx = createContext(
        'You need to sell your bonds before the correction.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });

    it('should detect "advise" + crypto terms as advice', async () => {
      const ctx = createContext(
        'I advise allocating 10% of your portfolio to bitcoin.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });

    it('should detect "suggest" + investment terms as advice', async () => {
      const ctx = createContext(
        'I suggest putting your money into a Roth IRA.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });

    it('should detect "would" + financial terms as advice', async () => {
      const ctx = createContext(
        'I would put more into the mutual fund for better returns.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });
  });

  describe('Disclaimer detection', () => {
    it('should allow advice with "not financial advice" disclaimer', async () => {
      const ctx = createContext(
        'You should invest in index funds. This is not financial advice.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow advice with "not a financial advisor" disclaimer', async () => {
      const ctx = createContext(
        'I am not a financial advisor, but you could consider ETFs.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow advice with "consult a financial professional"', async () => {
      const ctx = createContext(
        'You should invest in bonds. Please consult a financial professional.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow advice with "for informational purposes only"', async () => {
      const ctx = createContext(
        'You could buy stocks. This is for informational purposes only.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow advice with "do your own research"', async () => {
      const ctx = createContext(
        'You should consider investing in crypto. Do your own research.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow advice with "DYOR" disclaimer', async () => {
      const ctx = createContext('You should buy BTC before the rally. DYOR.');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow advice with "not a recommendation"', async () => {
      const ctx = createContext(
        'This is not a recommendation, but you could sell your ETFs.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should allow advice with "this is not investment advice"', async () => {
      const ctx = createContext(
        'You should sell your stock positions. This is not investment advice.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Custom disclaimer via requiredDisclaimer config', () => {
    it('should detect advice without the required custom disclaimer', async () => {
      const ctx = createContext(
        'You should invest in index funds for retirement.',
        { requiredDisclaimer: 'Acme Corp is not a licensed advisor' },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
      expect(detections[0].message).toContain(
        'Acme Corp is not a licensed advisor',
      );
    });

    it('should allow advice with the required custom disclaimer present', async () => {
      const ctx = createContext(
        'You should invest in index funds. Acme Corp is not a licensed advisor.',
        { requiredDisclaimer: 'Acme Corp is not a licensed advisor' },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should match custom disclaimer case-insensitively', async () => {
      const ctx = createContext(
        'You should buy stocks. acme corp is not a licensed advisor.',
        { requiredDisclaimer: 'Acme Corp is not a licensed advisor' },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should ignore standard disclaimers when custom one is required', async () => {
      const ctx = createContext(
        'You should invest in bonds. This is not financial advice.',
        { requiredDisclaimer: 'Acme Corp is not a licensed advisor' },
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
    });
  });

  describe('Questions should NOT trigger', () => {
    it('should not trigger for "should I invest?"', async () => {
      const ctx = createContext('Should I invest in index funds?');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for "what stocks should I buy?"', async () => {
      const ctx = createContext('What stocks should I buy?');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for "how should I diversify?"', async () => {
      const ctx = createContext('How should I diversify my portfolio?');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for questions with "?"', async () => {
      const ctx = createContext(
        'Is it a good idea to invest in crypto right now?',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should trigger when "?" is injected mid-content to bypass check', async () => {
      // A mid-content "?" should not exempt the entire message from
      // financial-advice detection — only sentence-ending questions should.
      const ctx = createContext(
        'You should buy AAPL stock for guaranteed returns. Random? Do it now.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections.length).toBeGreaterThan(0);
    });
  });

  describe('Past tense should NOT trigger', () => {
    it('should not trigger for "I invested"', async () => {
      const ctx = createContext('I invested in stocks last year.');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for "I bought"', async () => {
      const ctx = createContext('I bought some ETFs for my portfolio.');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for "I sold"', async () => {
      const ctx = createContext('I sold my bonds before the crash.');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for "I\'ve invested"', async () => {
      const ctx = createContext(
        "I've invested in mutual funds over the years.",
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for "I have traded"', async () => {
      const ctx = createContext('I have traded forex for five years.');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Content without financial terms should NOT trigger', () => {
    it('should not trigger for general content', async () => {
      const ctx = createContext(
        'You should consider taking a walk in the park.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for non-financial recommendations', async () => {
      const ctx = createContext('I recommend reading this book about cooking.');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should not trigger for content with action verbs but no financial terms', async () => {
      const ctx = createContext(
        'You should suggest improvements to the team process.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty content', async () => {
      const ctx = createContext('');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle content with financial terms but no action verbs', async () => {
      const ctx = createContext(
        'The stock market experienced high volatility today.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should handle content with action verbs but only financial terms in questions', async () => {
      const ctx = createContext('How can I start investing?');
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(0);
    });

    it('should detect mixed content with advice and financial terms', async () => {
      const ctx = createContext(
        'The market is down. You should buy the dip in ETFs and hold long term.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe('financial-advice-no-disclaimer');
    });

    it('should detect advice about cryptocurrency', async () => {
      const ctx = createContext(
        'You should buy ethereum before the next bull market.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
    });

    it('should detect advice about retirement accounts', async () => {
      const ctx = createContext(
        'You need to max out your 401k contributions this year.',
      );
      const detections = await engine.evaluate(ctx);
      expect(detections).toHaveLength(1);
    });
  });
});
