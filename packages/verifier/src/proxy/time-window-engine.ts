// SPDX-License-Identifier: Apache-2.0

/**
 * Time Window policy engine.
 *
 * Restricts messages to specific hours and days of the week.
 * Useful for enforcing business hours or maintenance windows.
 *
 * Config shape (on binding.config):
 *   allowedHours?: { start: number; end: number }  — 0-23 hour range
 *   allowedDays?: number[]                         — 0=Sun, 1=Mon, ... 6=Sat
 *   timezone?: string                              — IANA timezone, default UTC
 *   label?: string                                 — detection label
 *
 * Example binding config:
 *   {
 *     "allowedHours": { "start": 9, "end": 18 },
 *     "allowedDays": [1, 2, 3, 4, 5],
 *     "timezone": "America/New_York",
 *     "label": "outside-business-hours"
 *   }
 */

import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

interface HourRange {
  start: number;
  end: number;
}

export class TimeWindowEngine implements PolicyEngine {
  readonly name = 'time-window';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config;
    if (!cfg) return [];

    const allowedHours = cfg.allowedHours as HourRange | undefined;
    const allowedDays = cfg.allowedDays as number[] | undefined;
    const timezone = (cfg.timezone as string) || 'UTC';
    const label = (cfg.label as string) || 'outside-time-window';

    // If no restrictions configured, permit
    if (!allowedHours && !allowedDays) {
      return [];
    }

    const now = new Date();
    let hour: number;
    let dayOfWeek: number;

    try {
      // Get time in specified timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
        weekday: 'short',
      });
      const parts = formatter.formatToParts(now);
      const hourPart = parts.find((p) => p.type === 'hour');
      const weekdayPart = parts.find((p) => p.type === 'weekday');

      hour = hourPart ? Number.parseInt(hourPart.value, 10) : now.getUTCHours();

      // Convert weekday name to number
      const weekdayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      dayOfWeek = weekdayPart
        ? (weekdayMap[weekdayPart.value] ?? now.getUTCDay())
        : now.getUTCDay();
    } catch {
      // Fallback to UTC if timezone parsing fails
      hour = now.getUTCHours();
      dayOfWeek = now.getUTCDay();
    }

    const detections: PolicyDetection[] = [];

    // Check hours
    // Confidence 1.0 = deterministic check (time comparison, not heuristic)
    if (allowedHours) {
      const { start, end } = allowedHours;
      const inRange =
        start <= end
          ? hour >= start && hour < end
          : hour >= start || hour < end; // Handle overnight ranges like 22-6

      if (!inRange) {
        detections.push({
          type: label,
          confidence: 1.0,
          message: `Current hour ${hour} is outside allowed range ${start}-${end} (${timezone})`,
        });
      }
    }

    // Check days
    if (allowedDays && allowedDays.length > 0) {
      if (!allowedDays.includes(dayOfWeek)) {
        const dayNames = [
          'Sunday',
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
        ];
        detections.push({
          type: label,
          confidence: 1.0,
          message: `${dayNames[dayOfWeek]} is not in allowed days`,
        });
      }
    }

    return detections;
  }
}
