// SPDX-License-Identifier: Apache-2.0

/**
 * Testing utilities for policy engines.
 */

import type { Detection, PolicyEngine, PolicyRequest } from '../types';

/**
 * Create a mock policy request for testing.
 */
export function mockRequest(
  content: string,
  options: Partial<Omit<PolicyRequest, 'content'>> = {},
): PolicyRequest {
  return {
    content,
    policyId: options.policyId ?? 'test-policy-id',
    policySlug: options.policySlug ?? 'test-policy',
    config: options.config,
  };
}

/**
 * Assert that detections contain a specific type.
 */
export function hasDetection(detections: Detection[], type: string): boolean {
  return detections.some((d) => d.type === type);
}

/**
 * Assert that detections contain a type with minimum confidence.
 */
export function hasDetectionWithConfidence(
  detections: Detection[],
  type: string,
  minConfidence: number,
): boolean {
  return detections.some(
    (d) => d.type === type && d.confidence >= minConfidence,
  );
}

/**
 * Test helper to run a policy engine against multiple test cases.
 */
export async function runTestCases(
  engine: PolicyEngine,
  cases: Array<{
    name: string;
    content: string;
    config?: Record<string, unknown>;
    expectDetections?: boolean;
    expectTypes?: string[];
  }>,
): Promise<
  Array<{
    name: string;
    passed: boolean;
    detections: Detection[];
    error?: string;
  }>
> {
  const results = [];

  for (const testCase of cases) {
    try {
      const request = mockRequest(testCase.content, {
        config: testCase.config,
      });
      const detections = await engine.evaluate(request);

      let passed = true;

      if (testCase.expectDetections !== undefined) {
        const hasDetections = detections.length > 0;
        if (hasDetections !== testCase.expectDetections) {
          passed = false;
        }
      }

      if (testCase.expectTypes) {
        for (const expectedType of testCase.expectTypes) {
          if (!hasDetection(detections, expectedType)) {
            passed = false;
          }
        }
      }

      results.push({ name: testCase.name, passed, detections });
    } catch (err) {
      results.push({
        name: testCase.name,
        passed: false,
        detections: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
