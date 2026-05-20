// SPDX-License-Identifier: Apache-2.0

/**
 * Content Redactor
 *
 * Replaces detected character spans in message content with a mask
 * string (default: '[REDACTED]'). Handles overlapping/adjacent spans
 * by merging them, and clamps out-of-bounds offsets to content bounds.
 */

import type { DetectionSpan } from './policy-evaluator-types';

export interface RedactionMetadata {
  spanCount: number;
  spans: Array<{ start: number; end: number }>;
  detectionTypes?: string[];
}

export interface RedactionResult {
  content: string;
  metadata: RedactionMetadata;
}

/**
 * Redact character spans from content, replacing each with a mask string.
 *
 * Algorithm:
 * 1. Return original if no spans
 * 2. Clamp spans to content bounds
 * 3. Sort by start position
 * 4. Merge overlapping/adjacent spans
 * 5. Replace in reverse order to preserve offsets
 */
export function redact(
  content: string,
  spans: DetectionSpan[],
  mask = '[REDACTED]',
): RedactionResult {
  if (spans.length === 0) {
    return {
      content,
      metadata: { spanCount: 0, spans: [] },
    };
  }

  // CR-014: Sanitize inverted spans (start > end) by swapping, then clamp to content bounds
  const clamped = spans.map((s) => {
    const lo = Math.min(s.start, s.end);
    const hi = Math.max(s.start, s.end);
    return {
      start: Math.max(0, Math.min(lo, content.length)),
      end: Math.max(0, Math.min(hi, content.length)),
    };
  });

  // Sort by start position
  clamped.sort((a, b) => a.start - b.start);

  // Merge overlapping/adjacent spans
  const merged: Array<{ start: number; end: number }> = [clamped[0]];
  for (let i = 1; i < clamped.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = clamped[i];
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }

  // Replace in reverse order to preserve character offsets
  let result = content;
  for (let i = merged.length - 1; i >= 0; i--) {
    const span = merged[i];
    result = result.slice(0, span.start) + mask + result.slice(span.end);
  }

  return {
    content: result,
    metadata: {
      spanCount: merged.length,
      spans: merged,
    },
  };
}
