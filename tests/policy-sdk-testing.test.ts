// SPDX-License-Identifier: Apache-2.0

/**
 * Policy SDK — Testing Utilities Unit Tests
 *
 * Tests mockRequest(), hasDetection(), hasDetectionWithConfidence(),
 * and runTestCases().
 */

import { BasePolicyEngine } from '@spellguard/policy-sdk';
import type { Detection, PolicyRequest } from '@spellguard/policy-sdk';
import {
  hasDetection,
  hasDetectionWithConfidence,
  mockRequest,
  runTestCases,
} from '@spellguard/policy-sdk/testing';
import { describe, expect, it } from 'vitest';

// ─── Test engines ─────────────────────────────────────────────

class AlwaysDetectEngine extends BasePolicyEngine {
  name = 'always-detect';

  evaluate(_request: PolicyRequest): Detection[] {
    return [
      { type: 'issue-a', confidence: 0.9, message: 'Found A' },
      { type: 'issue-b', confidence: 0.6, message: 'Found B' },
    ];
  }
}

class NeverDetectEngine extends BasePolicyEngine {
  name = 'never-detect';

  evaluate(_request: PolicyRequest): Detection[] {
    return [];
  }
}

class ErrorThrowingEngine extends BasePolicyEngine {
  name = 'error-engine';

  evaluate(_request: PolicyRequest): Detection[] {
    throw new Error('Evaluation failed');
  }
}

class ConfigDrivenEngine extends BasePolicyEngine {
  name = 'config-driven';

  evaluate(request: PolicyRequest): Detection[] {
    const shouldDetect = this.getConfig(request, 'detect', false);
    if (shouldDetect) {
      return [{ type: 'config-detection', confidence: 0.95 }];
    }
    return [];
  }
}

// ─── Tests ────────────────────────────────────────────────────

describe('mockRequest()', () => {
  it('should create a request with content', () => {
    const req = mockRequest('Hello world');
    expect(req.content).toBe('Hello world');
  });

  it('should use default policyId', () => {
    const req = mockRequest('test');
    expect(req.policyId).toBe('test-policy-id');
  });

  it('should use default policySlug', () => {
    const req = mockRequest('test');
    expect(req.policySlug).toBe('test-policy');
  });

  it('should override policyId from options', () => {
    const req = mockRequest('test', { policyId: 'custom-id' });
    expect(req.policyId).toBe('custom-id');
  });

  it('should override policySlug from options', () => {
    const req = mockRequest('test', { policySlug: 'custom-slug' });
    expect(req.policySlug).toBe('custom-slug');
  });

  it('should include config when provided', () => {
    const req = mockRequest('test', { config: { threshold: 0.8 } });
    expect(req.config).toEqual({ threshold: 0.8 });
  });

  it('should have undefined config when not provided', () => {
    const req = mockRequest('test');
    expect(req.config).toBeUndefined();
  });

  it('should return a complete PolicyRequest shape', () => {
    const req = mockRequest('content', {
      policyId: 'my-id',
      policySlug: 'my-slug',
      config: { key: 'value' },
    });
    expect(req).toEqual({
      content: 'content',
      policyId: 'my-id',
      policySlug: 'my-slug',
      config: { key: 'value' },
    });
  });
});

describe('hasDetection()', () => {
  const detections: Detection[] = [
    { type: 'pii-email', confidence: 0.9 },
    { type: 'injection', confidence: 0.8, message: 'Injection found' },
  ];

  it('should return true when detection type exists', () => {
    expect(hasDetection(detections, 'pii-email')).toBe(true);
  });

  it('should return true for second detection type', () => {
    expect(hasDetection(detections, 'injection')).toBe(true);
  });

  it('should return false when type is missing', () => {
    expect(hasDetection(detections, 'pii-phone')).toBe(false);
  });

  it('should be case-sensitive', () => {
    expect(hasDetection(detections, 'PII-EMAIL')).toBe(false);
  });

  it('should return false for empty array', () => {
    expect(hasDetection([], 'any-type')).toBe(false);
  });
});

describe('hasDetectionWithConfidence()', () => {
  const detections: Detection[] = [
    { type: 'pii-email', confidence: 0.9 },
    { type: 'injection', confidence: 0.4 },
    { type: 'toxicity', confidence: 0.7 },
  ];

  it('should return true when type and confidence meet threshold', () => {
    expect(hasDetectionWithConfidence(detections, 'pii-email', 0.8)).toBe(true);
  });

  it('should return true when confidence equals threshold exactly', () => {
    expect(hasDetectionWithConfidence(detections, 'pii-email', 0.9)).toBe(true);
  });

  it('should return false when confidence below threshold', () => {
    expect(hasDetectionWithConfidence(detections, 'injection', 0.5)).toBe(
      false,
    );
  });

  it('should return false when type is missing', () => {
    expect(hasDetectionWithConfidence(detections, 'nonexistent', 0.1)).toBe(
      false,
    );
  });

  it('should work with threshold 0.0', () => {
    expect(hasDetectionWithConfidence(detections, 'injection', 0.0)).toBe(true);
  });

  it('should work with threshold 1.0', () => {
    expect(hasDetectionWithConfidence(detections, 'pii-email', 1.0)).toBe(
      false,
    );
  });

  it('should return false for empty array', () => {
    expect(hasDetectionWithConfidence([], 'any', 0.0)).toBe(false);
  });
});

describe('runTestCases()', () => {
  it('should return results matching number of cases', async () => {
    const results = await runTestCases(new NeverDetectEngine(), [
      { name: 'case-1', content: 'a' },
      { name: 'case-2', content: 'b' },
      { name: 'case-3', content: 'c' },
    ]);
    expect(results).toHaveLength(3);
  });

  it('should return empty results for empty cases', async () => {
    const results = await runTestCases(new NeverDetectEngine(), []);
    expect(results).toEqual([]);
  });

  it('should pass when expectDetections matches (true + detections found)', async () => {
    const results = await runTestCases(new AlwaysDetectEngine(), [
      { name: 'should-detect', content: 'test', expectDetections: true },
    ]);
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toBe('should-detect');
    expect(results[0].detections).toHaveLength(2);
  });

  it('should pass when expectDetections matches (false + no detections)', async () => {
    const results = await runTestCases(new NeverDetectEngine(), [
      { name: 'should-not-detect', content: 'test', expectDetections: false },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it('should fail when expectDetections is true but no detections found', async () => {
    const results = await runTestCases(new NeverDetectEngine(), [
      { name: 'expected-detect', content: 'test', expectDetections: true },
    ]);
    expect(results[0].passed).toBe(false);
  });

  it('should fail when expectDetections is false but detections found', async () => {
    const results = await runTestCases(new AlwaysDetectEngine(), [
      { name: 'expected-clean', content: 'test', expectDetections: false },
    ]);
    expect(results[0].passed).toBe(false);
  });

  it('should pass when expectDetections is undefined (no check)', async () => {
    const results = await runTestCases(new AlwaysDetectEngine(), [
      { name: 'no-check', content: 'test' },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it('should pass when all expectTypes are present', async () => {
    const results = await runTestCases(new AlwaysDetectEngine(), [
      {
        name: 'types-present',
        content: 'test',
        expectTypes: ['issue-a', 'issue-b'],
      },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it('should fail when expected type is missing', async () => {
    const results = await runTestCases(new AlwaysDetectEngine(), [
      {
        name: 'missing-type',
        content: 'test',
        expectTypes: ['issue-a', 'nonexistent'],
      },
    ]);
    expect(results[0].passed).toBe(false);
  });

  it('should capture error when engine throws', async () => {
    const results = await runTestCases(new ErrorThrowingEngine(), [
      { name: 'error-case', content: 'test' },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].detections).toEqual([]);
    expect(results[0].error).toBe('Evaluation failed');
  });

  it('should pass config through to engine', async () => {
    const results = await runTestCases(new ConfigDrivenEngine(), [
      {
        name: 'with-config',
        content: 'test',
        config: { detect: true },
        expectDetections: true,
      },
      { name: 'without-config', content: 'test', expectDetections: false },
    ]);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
  });

  it('should run cases independently', async () => {
    const results = await runTestCases(new ErrorThrowingEngine(), [
      { name: 'error-case', content: 'test' },
      // This case should still run even though the previous one errored
      // (but this engine always throws, so it will also fail)
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeDefined();
  });
});
