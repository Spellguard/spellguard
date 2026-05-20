// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for IdentityEngine — the 'identity-claim' policy engine.
 *
 * Each test builds a minimal PolicyEvalContext, sets config on the binding,
 * and checks whether detections are emitted (violation) or not (pass).
 */

import { describe, expect, it } from 'vitest';
import { IdentityEngine } from '../packages/verifier/src/proxy/identity-engine';
import type {
  NormalizedIdentityClaims,
  PolicyEvalContext,
} from '../packages/verifier/src/proxy/policy-evaluator-types';
import { makeEngineBinding } from './helpers/make-binding';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeIdentity(
  overrides: Partial<NormalizedIdentityClaims> = {},
): NormalizedIdentityClaims {
  return {
    subject: 'arn:aws:iam::123:role/MyRole',
    issuer: 'sts.amazonaws.com',
    provider: 'aws',
    verifiedAt: Date.now(),
    raw: {},
    ...overrides,
  };
}

function makeCtx(
  config: Record<string, unknown>,
  identity: NormalizedIdentityClaims[],
): PolicyEvalContext {
  return {
    message: 'test',
    binding: makeEngineBinding('identity-claim', config),
    identity,
  } as unknown as PolicyEvalContext;
}

const engine = new IdentityEngine();

function passes(
  config: Record<string, unknown>,
  identity: NormalizedIdentityClaims[],
) {
  return engine.evaluate(makeCtx(config, identity)).length === 0;
}

function detects(
  config: Record<string, unknown>,
  identity: NormalizedIdentityClaims[],
) {
  return engine.evaluate(makeCtx(config, identity)).length > 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IdentityEngine', () => {
  describe('empty config', () => {
    it('passes with no identity and no constraints', () => {
      expect(passes({}, [])).toBe(true);
    });

    it('passes with identity and no constraints', () => {
      expect(passes({}, [makeIdentity()])).toBe(true);
    });
  });

  describe('requireProvider', () => {
    it('passes when provider matches (string)', () => {
      expect(passes({ requireProvider: 'aws' }, [makeIdentity()])).toBe(true);
    });

    it('blocks when provider does not match (string)', () => {
      expect(detects({ requireProvider: 'azure' }, [makeIdentity()])).toBe(
        true,
      );
    });

    it('passes when provider is in array', () => {
      expect(
        passes({ requireProvider: ['aws', 'gcp'] }, [makeIdentity()]),
      ).toBe(true);
    });

    it('blocks when provider not in array', () => {
      expect(
        detects({ requireProvider: ['azure', 'gcp'] }, [makeIdentity()]),
      ).toBe(true);
    });

    it('blocks when identity list is empty', () => {
      expect(detects({ requireProvider: 'aws' }, [])).toBe(true);
    });
  });

  describe('allowedSubjects', () => {
    it('passes when subject is in list', () => {
      expect(
        passes({ allowedSubjects: ['arn:aws:iam::123:role/MyRole'] }, [
          makeIdentity(),
        ]),
      ).toBe(true);
    });

    it('blocks when subject not in list', () => {
      expect(
        detects({ allowedSubjects: ['arn:aws:iam::999:role/OtherRole'] }, [
          makeIdentity(),
        ]),
      ).toBe(true);
    });
  });

  describe('subjectPattern', () => {
    it('passes when subject matches regex', () => {
      expect(
        passes({ subjectPattern: '^arn:aws:iam::123:' }, [makeIdentity()]),
      ).toBe(true);
    });

    it('blocks when subject does not match regex', () => {
      expect(
        detects({ subjectPattern: '^arn:aws:iam::999:' }, [makeIdentity()]),
      ).toBe(true);
    });

    it('blocks on invalid regex (treated as no-match)', () => {
      expect(detects({ subjectPattern: '[invalid' }, [makeIdentity()])).toBe(
        true,
      );
    });
  });

  describe('allowedIssuers', () => {
    it('passes when issuer is in list', () => {
      expect(
        passes({ allowedIssuers: ['sts.amazonaws.com'] }, [makeIdentity()]),
      ).toBe(true);
    });

    it('blocks when issuer not in list', () => {
      expect(
        detects({ allowedIssuers: ['accounts.google.com'] }, [makeIdentity()]),
      ).toBe(true);
    });
  });

  describe('allowedEmails', () => {
    it('passes when email matches', () => {
      expect(
        passes({ allowedEmails: ['agent@example.com'] }, [
          makeIdentity({ email: 'agent@example.com' }),
        ]),
      ).toBe(true);
    });

    it('blocks when email does not match', () => {
      expect(
        detects({ allowedEmails: ['other@example.com'] }, [
          makeIdentity({ email: 'agent@example.com' }),
        ]),
      ).toBe(true);
    });

    it('blocks when identity has no email', () => {
      expect(
        detects({ allowedEmails: ['agent@example.com'] }, [makeIdentity()]),
      ).toBe(true);
    });
  });

  describe('minVerifiedProviders', () => {
    it('passes when count meets minimum', () => {
      expect(
        passes({ minVerifiedProviders: 2 }, [
          makeIdentity({ provider: 'aws' }),
          makeIdentity({ provider: 'gcp' }),
        ]),
      ).toBe(true);
    });

    it('blocks when count is below minimum', () => {
      expect(
        detects({ minVerifiedProviders: 2 }, [
          makeIdentity({ provider: 'aws' }),
        ]),
      ).toBe(true);
    });

    it('blocks when identity list is empty and min > 0', () => {
      expect(detects({ minVerifiedProviders: 1 }, [])).toBe(true);
    });

    it('emits a separate detection from attribute constraints', () => {
      const detections = engine.evaluate(
        makeCtx({ minVerifiedProviders: 2, requireProvider: 'azure' }, [
          makeIdentity({ provider: 'aws' }),
        ]),
      );
      // Two separate detections: one for count, one for attribute constraint
      expect(detections.length).toBe(2);
    });
  });

  describe('combined constraints (AND logic)', () => {
    it('passes when all constraints satisfied by one identity', () => {
      expect(
        passes(
          {
            requireProvider: 'aws',
            allowedSubjects: ['arn:aws:iam::123:role/MyRole'],
            allowedIssuers: ['sts.amazonaws.com'],
          },
          [makeIdentity()],
        ),
      ).toBe(true);
    });

    it('blocks when only some constraints satisfied', () => {
      expect(
        detects(
          {
            requireProvider: 'aws',
            allowedSubjects: ['arn:aws:iam::999:role/OtherRole'], // wrong subject
            allowedIssuers: ['sts.amazonaws.com'],
          },
          [makeIdentity()],
        ),
      ).toBe(true);
    });
  });

  describe('multiple identities (OR across identities)', () => {
    it('passes if any one identity satisfies all constraints', () => {
      expect(
        passes(
          { requireProvider: 'gcp', allowedIssuers: ['accounts.google.com'] },
          [
            makeIdentity({ provider: 'aws', issuer: 'sts.amazonaws.com' }),
            makeIdentity({
              provider: 'gcp',
              issuer: 'accounts.google.com',
              subject: 'sa@project.iam.gserviceaccount.com',
            }),
          ],
        ),
      ).toBe(true);
    });

    it('blocks if no identity satisfies all constraints', () => {
      expect(
        detects({ requireProvider: 'azure' }, [
          makeIdentity({ provider: 'aws' }),
          makeIdentity({ provider: 'gcp' }),
        ]),
      ).toBe(true);
    });
  });

  describe('detection shape', () => {
    it('emits detection with type identity-claim and confidence 1.0', () => {
      const detections = engine.evaluate(
        makeCtx({ requireProvider: 'azure' }, [makeIdentity()]),
      );
      expect(detections[0].type).toBe('identity-claim');
      expect(detections[0].confidence).toBe(1.0);
      expect(typeof detections[0].message).toBe('string');
    });
  });
});
