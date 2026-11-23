// SPDX-License-Identifier: Apache-2.0

import type { DetectionSpan } from './policy-evaluator-types';

export type PiiLabel = 'ssn' | 'email' | 'phone' | 'credit-card';

export type PiiRule =
  | {
      readonly kind: 'regex';
      readonly label: Exclude<PiiLabel, 'credit-card'>;
      readonly pattern: RegExp;
    }
  | {
      readonly kind: 'credit-card';
      readonly label: 'credit-card';
    };

export interface PiiMatch {
  readonly label: PiiLabel;
  readonly rule: PiiRule;
  readonly spans: DetectionSpan[];
}

const DEFAULT_PHONE_PATTERN =
  /(?<![A-Za-z0-9])(?:\+1[-.\s]?)?(?:\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4})(?![A-Za-z0-9])/;

/**
 * The default rules share one matcher between the policy engine and the
 * legacy inbound policy path. Credit-card candidates use validation in place
 * of a regex because card formats vary and the checksum matters.
 */
export const DEFAULT_PII_RULES: readonly PiiRule[] = [
  {
    kind: 'regex',
    label: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    kind: 'regex',
    label: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  },
  {
    kind: 'regex',
    label: 'phone',
    pattern: DEFAULT_PHONE_PATTERN,
  },
  {
    kind: 'credit-card',
    label: 'credit-card',
  },
];

// Include separators in the candidate so an overlong or invalid run cannot
// fall back to a valid prefix or suffix. The lookarounds keep adjacent letters
// and digits in the same candidate while allowing normal text spacing around it.
const CARD_CANDIDATE_PATTERN =
  /(?<![\p{L}\p{N}])\d(?:[ -]?\d)*(?![\p{L}\p{N}])/gu;

export function findDefaultPiiMatches(content: string): PiiMatch[] {
  return DEFAULT_PII_RULES.flatMap((rule) => {
    const spans =
      rule.kind === 'credit-card'
        ? findCreditCardSpans(content)
        : rule.label === 'email'
          ? findEmailSpans(content, rule.pattern)
          : findRegexSpans(content, rule.pattern);

    return spans.length > 0 ? [{ label: rule.label, rule, spans }] : [];
  });
}

function findEmailSpans(content: string, pattern: RegExp): DetectionSpan[] {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const spans: DetectionSpan[] = [];

  for (const match of content.matchAll(globalPattern)) {
    if (isReservedEmail(match[0])) continue;

    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }

  return spans;
}

function isReservedEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;

  const localPart = email.slice(0, at).toLowerCase();
  const host = email.slice(at + 1).toLowerCase();

  return (
    localPart === 'noreply' ||
    host === 'example.com' ||
    host.endsWith('.test') ||
    host.endsWith('.invalid') ||
    host === 'users.noreply.github.com'
  );
}

function findRegexSpans(content: string, pattern: RegExp): DetectionSpan[] {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const spans: DetectionSpan[] = [];

  for (const match of content.matchAll(globalPattern)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }

  return spans;
}

function findCreditCardSpans(content: string): DetectionSpan[] {
  const spans: DetectionSpan[] = [];

  for (const match of content.matchAll(CARD_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    const digits = candidate.replace(/[ -]/g, '');
    if (!passesLuhn(digits)) continue;

    const start = match.index ?? 0;
    spans.push({ start, end: start + candidate.length });
  }

  return spans;
}

function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}
