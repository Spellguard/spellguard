// SPDX-License-Identifier: Apache-2.0

/**
 * Time Window Engine Unit Tests
 *
 * Tests the time-window policy engine that restricts messages
 * to specific hours and days of the week.
 */

import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

function makeTimeWindowBinding(
  config: Record<string, unknown>,
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'time-window-test',
    level: 'org',
    effect: 'block',
    policyType: 'time-window',
    policySlug: 'custom-time-window',
    config,
    ...overrides,
  };
}

describe('Time Window Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
    vi.useRealTimers();
  });

  // ─── Hour restrictions ─────────────────────────────────────

  describe('hour restrictions', () => {
    it('should permit when current hour is within allowed range', async () => {
      // Mock time to 10:00 UTC on a Monday
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T10:00:00Z')); // Monday

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should detect when current hour is before allowed range', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T07:00:00Z')); // Monday 7am

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain(
        'outside allowed range',
      );
    });

    it('should detect when current hour is after allowed range', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T20:00:00Z')); // Monday 8pm

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
    });

    it('should handle overnight hour ranges (e.g., 22-6)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T23:00:00Z')); // 11pm

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 22, end: 6 },
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
    });

    it('should block during day for overnight ranges', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T14:00:00Z')); // 2pm

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 22, end: 6 },
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('deny');
    });
  });

  // ─── Day restrictions ──────────────────────────────────────

  describe('day restrictions', () => {
    it('should permit on allowed days (Monday-Friday)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-11T12:00:00Z')); // Wednesday

      const binding = makeTimeWindowBinding({
        allowedDays: [1, 2, 3, 4, 5], // Mon-Fri
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
    });

    it('should detect on disallowed days (weekend)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-14T12:00:00Z')); // Saturday

      const binding = makeTimeWindowBinding({
        allowedDays: [1, 2, 3, 4, 5], // Mon-Fri
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].message).toContain('Saturday');
    });

    it('should permit on Sunday when Sunday is allowed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-15T12:00:00Z')); // Sunday

      const binding = makeTimeWindowBinding({
        allowedDays: [0, 6], // Weekend only
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
    });
  });

  // ─── Combined restrictions ─────────────────────────────────

  describe('combined hour and day restrictions', () => {
    it('should permit when both hour and day are allowed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-11T14:00:00Z')); // Wednesday 2pm

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        allowedDays: [1, 2, 3, 4, 5],
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
    });

    it('should detect when hour is wrong even if day is allowed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-11T22:00:00Z')); // Wednesday 10pm

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        allowedDays: [1, 2, 3, 4, 5],
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('deny');
    });

    it('should detect when day is wrong even if hour is allowed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-14T14:00:00Z')); // Saturday 2pm

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        allowedDays: [1, 2, 3, 4, 5],
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('deny');
    });

    it('should produce two detections when both hour and day are wrong', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-14T22:00:00Z')); // Saturday 10pm

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        allowedDays: [1, 2, 3, 4, 5],
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].detections).toHaveLength(2);
    });
  });

  // ─── Timezone handling ────────────────────────────────────

  describe('timezone handling', () => {
    it('should convert UTC time to specified timezone for hour check', async () => {
      vi.useFakeTimers();
      // UTC 14:00 = EST 09:00 (America/New_York is UTC-5 in February)
      vi.setSystemTime(new Date('2026-02-09T14:00:00Z')); // Monday

      const binding = makeTimeWindowBinding({
        timezone: 'America/New_York',
        allowedHours: { start: 9, end: 10 },
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should fallback to UTC on invalid timezone without crashing', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T10:00:00Z')); // Monday 10am UTC

      const binding = makeTimeWindowBinding({
        timezone: 'Invalid/Nowhere',
        allowedHours: { start: 9, end: 18 },
      });

      const results = await evaluatePolicies([binding], 'any message');
      // Should not crash — falls back to UTC, hour 10 is in 9-18 range
      expect(results[0].decision).toBe('permit');
    });
  });

  // ─── Hour boundary exactness ────────────────────────────

  describe('hour boundary exactness', () => {
    it('should block at exactly the end hour (exclusive boundary)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T18:00:00Z')); // Monday 18:00

      const binding = makeTimeWindowBinding({
        allowedHours: { start: 9, end: 18 },
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      // hour < end means 18 is NOT in range (exclusive end)
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].message).toContain(
        'outside allowed range',
      );
    });
  });

  // ─── Custom label ──────────────────────────────────────────

  describe('custom label', () => {
    it('should use custom label when provided', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-14T12:00:00Z')); // Saturday

      const binding = makeTimeWindowBinding({
        allowedDays: [1, 2, 3, 4, 5],
        label: 'outside-business-hours',
        timezone: 'UTC',
      });

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].detections[0].type).toBe('outside-business-hours');
    });
  });

  // ─── Empty config ──────────────────────────────────────────

  describe('empty config', () => {
    it('should permit when no restrictions configured', async () => {
      const binding = makeTimeWindowBinding({});

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should permit when config is undefined', async () => {
      const binding: ResolvedPolicyBinding = {
        policyId: 'time-window-noconfig',
        level: 'org',
        effect: 'block',
        policyType: 'time-window',
        policySlug: 'no-config',
      };

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
    });
  });

  // ─── Decision logic ────────────────────────────────────────

  describe('decision logic integration', () => {
    it('should flag (not block) when effect is permit', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-14T12:00:00Z')); // Saturday

      const binding = makeTimeWindowBinding(
        { allowedDays: [1, 2, 3, 4, 5] },
        { effect: 'flag' },
      );

      const results = await evaluatePolicies([binding], 'any message');
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
      expect(results[0].detections).toHaveLength(1);
    });
  });
});
