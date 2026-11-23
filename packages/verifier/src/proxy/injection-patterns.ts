// SPDX-License-Identifier: Apache-2.0

/**
 * Shared prompt-injection detection patterns and evaluation logic.
 *
 * Used by policy-file-engine, policy-network-engine, and policy-memory-engine.
 * Each engine imports the common base patterns and extends them with
 * domain-specific extras before calling buildInjectionDetections().
 */

import type {
  DetectionSpan,
  PolicyDetection,
  PolicyEvalContext,
} from './policy-evaluator-types';

const TAG_START = 0xe0000;
const TAG_END = 0xe007f;
const CANCEL_TAG = 0xe007f;
const BLACK_FLAG = 0x1f3f4;

const BIDI_CONTROLS = new Set([
  0x061c, // Arabic letter mark
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b, // right-to-left embedding
  0x202c, // pop directional formatting
  0x202d, // left-to-right override
  0x202e, // right-to-left override
  0x2066, // left-to-right isolate
  0x2067, // right-to-left isolate
  0x2068, // first-strong isolate
  0x2069, // pop directional isolate
]);

const SUPPORTED_FLAG_TAGS = new Set(['gbeng', 'gbsct', 'gbwls']);
const REGION_TAG = /^[a-z]{2}$|^\d{3}$/;
const SUBDIVISION_TAG = /^[a-z]{2}[a-z0-9]{1,3}$/;

/**
 * The evaluator uses this marker, rather than the public detection string, to
 * recognize the one built-in bidi observation that may be flagged. A WeakSet
 * keeps the provenance private and cannot be forged by a replacement engine.
 */
const TRUSTED_BIDI_DETECTIONS = new WeakSet<PolicyDetection>();

export function isTrustedBidiDetection(detection: PolicyDetection): boolean {
  return (
    detection.type === 'bidi-override' && TRUSTED_BIDI_DETECTIONS.has(detection)
  );
}

interface PreparedInjectionText {
  readonly text: string;
  /** Original UTF-16 ranges for each prepared UTF-16 code unit. */
  readonly sourceRanges?: DetectionSpan[];
  readonly hasTagSmuggling: boolean;
  readonly hasBidiOverride: boolean;
}

function isTagCodePoint(codePoint: number): boolean {
  return codePoint >= TAG_START && codePoint <= TAG_END;
}

function codePointLength(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

function isFlagTagAscii(codePoint: number): boolean {
  return (
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    (codePoint >= 0x30 && codePoint <= 0x39)
  );
}

function isBoundedFlagTag(payload: string): boolean {
  return (
    SUPPORTED_FLAG_TAGS.has(payload) ||
    REGION_TAG.test(payload) ||
    SUBDIVISION_TAG.test(payload)
  );
}

/**
 * Return the end of a protected black-flag tag sequence, if it is a bounded
 * region/subdivision sequence. Unknown or overlong payloads are left to the
 * decoder so a black flag cannot hide an instruction sentence.
 */
function protectedFlagEnd(text: string, start: number): number | undefined {
  const blackFlagLength = codePointLength(BLACK_FLAG);
  let offset = start + blackFlagLength;
  let payload = '';

  while (offset < text.length) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) return undefined;

    if (codePoint === CANCEL_TAG) {
      return isBoundedFlagTag(payload)
        ? offset + codePointLength(codePoint)
        : undefined;
    }

    if (!isTagCodePoint(codePoint)) return undefined;
    const ascii = codePoint - TAG_START;
    if (!isFlagTagAscii(ascii) || payload.length >= 5) return undefined;
    payload += String.fromCodePoint(ascii);
    offset += codePointLength(codePoint);
  }

  return undefined;
}

function appendMappedOutput(
  parts: string[],
  sourceRanges: DetectionSpan[],
  output: string,
  originalStart: number,
  originalEnd: number,
): void {
  for (let offset = 0; offset < output.length; offset += 1) {
    sourceRanges.push({ start: originalStart, end: originalEnd });
  }
  parts.push(output);
}

/**
 * Decode tag characters and remove bidi controls for regex scanning. The
 * unchanged path returns the original string without allocating a source map.
 */
interface UnicodeSignals {
  readonly hasTagSmuggling: boolean;
  readonly hasBidiOverride: boolean;
}

function scanUnicodeSignals(text: string): UnicodeSignals {
  let hasTagSmuggling = false;
  let hasBidiOverride = false;
  let offset = 0;

  while (offset < text.length) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const length = codePointLength(codePoint);

    if (codePoint === BLACK_FLAG) {
      const end = protectedFlagEnd(text, offset);
      if (end !== undefined) {
        offset = end;
        continue;
      }
    }

    if (isTagCodePoint(codePoint)) hasTagSmuggling = true;
    if (BIDI_CONTROLS.has(codePoint)) hasBidiOverride = true;
    offset += length;
  }

  return { hasTagSmuggling, hasBidiOverride };
}

function appendProtectedFlag(
  text: string,
  start: number,
  end: number,
  parts: string[],
  sourceRanges: DetectionSpan[],
): void {
  let offset = start;
  while (offset < end) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) return;
    const length = codePointLength(codePoint);
    appendMappedOutput(
      parts,
      sourceRanges,
      text.slice(offset, offset + length),
      offset,
      offset + length,
    );
    offset += length;
  }
}

function appendPreparedCodePoint(
  text: string,
  codePoint: number,
  offset: number,
  length: number,
  parts: string[],
  sourceRanges: DetectionSpan[],
): void {
  const output = isTagCodePoint(codePoint)
    ? String.fromCodePoint(codePoint - TAG_START)
    : text.slice(offset, offset + length);
  appendMappedOutput(parts, sourceRanges, output, offset, offset + length);
}

export function prepareInjectionText(text: string): PreparedInjectionText {
  const signals = scanUnicodeSignals(text);

  if (!signals.hasTagSmuggling && !signals.hasBidiOverride) {
    return {
      text,
      hasTagSmuggling: false,
      hasBidiOverride: false,
    };
  }

  const parts: string[] = [];
  const sourceRanges: DetectionSpan[] = [];
  let offset = 0;

  while (offset < text.length) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const length = codePointLength(codePoint);

    if (codePoint === BLACK_FLAG) {
      const end = protectedFlagEnd(text, offset);
      if (end !== undefined) {
        appendProtectedFlag(text, offset, end, parts, sourceRanges);
        offset = end;
        continue;
      }
    }

    if (BIDI_CONTROLS.has(codePoint)) {
      offset += length;
      continue;
    }

    appendPreparedCodePoint(
      text,
      codePoint,
      offset,
      length,
      parts,
      sourceRanges,
    );

    offset += length;
  }

  return {
    text: parts.join(''),
    sourceRanges,
    hasTagSmuggling: signals.hasTagSmuggling,
    hasBidiOverride: signals.hasBidiOverride,
  };
}

function mapPreparedSpan(
  prepared: PreparedInjectionText,
  start: number,
  end: number,
): DetectionSpan | undefined {
  if (!prepared.sourceRanges) return { start, end };
  if (start < 0 || end <= start || end > prepared.sourceRanges.length) {
    return undefined;
  }

  return {
    start: prepared.sourceRanges[start].start,
    end: prepared.sourceRanges[end - 1].end,
  };
}

function detectionFromPatternMatch(
  prepared: PreparedInjectionText,
  match: RegExpExecArray,
  label: string,
  confidence: number,
  messagePrefix: string,
): PolicyDetection {
  const start = match.index ?? 0;
  const span = mapPreparedSpan(prepared, start, start + match[0].length);
  const detection: PolicyDetection = {
    type: label,
    confidence,
    message: `${messagePrefix}: ${match[0].slice(0, 60)}`,
  };
  if (span) detection.spans = [span];
  return detection;
}

function trustedBidiDetection(): PolicyDetection {
  const detection: PolicyDetection = {
    type: 'bidi-override',
    confidence: 0.8,
    message: 'Bidirectional control characters detected',
  };
  TRUSTED_BIDI_DETECTIONS.add(detection);
  return detection;
}

export function appendUnicodeDetections(
  detections: PolicyDetection[],
  prepared: PreparedInjectionText,
): void {
  if (prepared.hasTagSmuggling) {
    detections.push({
      type: 'unicode-tag-smuggling',
      confidence: 0.95,
      message: 'Unicode tag characters decoded for injection scanning',
    });
  }
  if (prepared.hasBidiOverride) detections.push(trustedBidiDetection());
}

// ─── Common base patterns ─────────────────────────────────────────────────────

/** Core instruction-override signals shared by all injection-scan engines. */
export const INJECTION_HIGH_COMMON: ReadonlyArray<RegExp> = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(all\s+)?previous\s+instructions?/i,
  /forget\s+everything\s+(above|before)/i,
  /you\s+are\s+now\s+(a\s+)?(?:an?\s+)?\w/i,
  /new\s+instructions?:/i,
  /\[INST\]|\[\/INST\]/, // Llama-style injection markers
  /\u200b|\u200c|\u200d|\u00ad|\ufeff/, // zero-width / invisible chars
];

/** Role-override and jailbreak signals shared by all injection-scan engines. */
export const INJECTION_MEDIUM_COMMON: ReadonlyArray<RegExp> = [
  /act\s+as\s+(a\s+)?(?:an?\s+)?\w/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /jailbreak/i,
  /developer\s+mode/i,
  /<\s*script[^>]*>/i, // script tags in text context
];

/** Soft override signals shared by all injection-scan engines. */
export const INJECTION_LOW_COMMON: ReadonlyArray<RegExp> = [
  /override\s+(previous\s+)?instructions?/i,
  /assistant\s*:\s*(?:sure|ok|yes|i\s+will)/i,
];

// ─── Shared evaluation logic ──────────────────────────────────────────────────

/**
 * Core injection detection algorithm used by all three injection-scan engines.
 * Reads `sensitivity` and `label` from the binding config.
 *
 * @param ctx          - Policy evaluation context
 * @param defaultLabel - Detection label when config.label is not set
 * @param messagePrefix - Human-readable prefix for the detection message
 * @param high         - High-confidence patterns (confidence: 0.95)
 * @param medium       - Medium-confidence patterns (confidence: 0.75)
 * @param low          - Low-confidence patterns (confidence: 0.75)
 */
export function buildInjectionDetections(
  ctx: PolicyEvalContext,
  defaultLabel: string,
  messagePrefix: string,
  high: ReadonlyArray<RegExp>,
  medium: ReadonlyArray<RegExp>,
  low: ReadonlyArray<RegExp>,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || defaultLabel;
  const sensitivity = (cfg.sensitivity as string) || 'medium';

  const patterns: RegExp[] = [...high];
  if (sensitivity === 'medium' || sensitivity === 'high') {
    patterns.push(...medium);
  }
  if (sensitivity === 'high') {
    patterns.push(...low);
  }

  const detections: PolicyDetection[] = [];
  const prepared = prepareInjectionText(ctx.content);

  for (const pattern of patterns) {
    const match = pattern.exec(prepared.text);
    if (match) {
      const isHigh = high.includes(pattern);
      detections.push(
        detectionFromPatternMatch(
          prepared,
          match,
          label,
          isHigh ? 0.95 : 0.75,
          messagePrefix,
        ),
      );
    }
  }

  // Append Unicode metadata after all regular patterns so a high-confidence
  // tag match cannot short-circuit the decoded attack or hide a bidi mix.
  appendUnicodeDetections(detections, prepared);

  return detections;
}
