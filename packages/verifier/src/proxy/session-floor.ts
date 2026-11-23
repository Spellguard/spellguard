// SPDX-License-Identifier: Apache-2.0

/**
 * The deterministic floor shared by both session policies
 * (internal design notes): which parts count as
 * sources, which values the sources state, and whether a tool parameter is
 * one of them.
 *
 * Matching rules:
 *   identifier  exact after trim and case-fold, as a whole token
 *   number      numeric equality after stripping currency symbols, thousands
 *   money       separators and trailing zeros ("3,570.00" equals 3570)
 *   text        case-folded substring of a source part
 *
 * Candidates are the values a fact could have taken from the sources: tokens
 * matching an identifier fact's pattern, or every number in the sources.
 * They are listed on a violation and become the semantic check's options.
 */

import { withoutReadingMarkers } from '../session/reading-assembly';
import {
  COUNTERPARTY_LEGS,
  HIDDEN_LAYER_LABEL_SUFFIX,
  type SessionPart,
} from '../session/types';
import type { FactSpec, SourcesFrom } from './session-config';

export interface Candidate {
  /** As it appears in the source. */
  raw: string;
  /** Normalized: a lowercase identifier, or a number. */
  value: string | number;
  /** The first part it appears in. */
  seq: number;
}

/** Most candidates kept per fact, in order of first appearance. */
export const MAX_CANDIDATES = 32;

/**
 * A token that could be an identifier: letters and digits, with `-`, `_`,
 * `/` or `.` inside but not at either end, so "PO-2291." yields "PO-2291".
 */
const IDENTIFIER_TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{N}_\-/.]*[\p{L}\p{N}])?/gu;

/**
 * A number as written in a document: digits with optional comma thousands
 * groups and an optional decimal part. Not when glued to a letter, digit,
 * `-`, `_` or `.` on the left (so the 2291 of "PO-2291" and the 48 of
 * "SW48" are not numbers), and not when a letter or digit follows.
 */
const NUMBER_TOKEN =
  /(?<![\p{L}\p{N}_.,-])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\p{L}\p{N}_]|[.,]\d)/gu;

export function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The number a parameter or a written figure means, or null when it is not
 * one. Accepts finite numbers and strings such as "3570", "3,570.00",
 * "USD 3,570.00" or "$3570".
 */
export function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const stripped = value
    .trim()
    .replace(/^(?:[A-Z]{3}\s*|[$€£¥]\s*)/i, '')
    .replace(/\s*(?:[A-Z]{3})$/i, '')
    .trim();
  if (!/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(stripped)) return null;
  const n = Number(stripped.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function numericEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Whether two values of one fact are the same value under its rule. */
export function sameValue(fact: FactSpec, a: unknown, b: unknown): boolean {
  if (fact.kind === 'number' || fact.kind === 'money') {
    const x = parseNumeric(a);
    const y = parseNumeric(b);
    return x !== null && y !== null && numericEqual(x, y);
  }
  if (
    (typeof a !== 'string' && typeof a !== 'number') ||
    (typeof b !== 'string' && typeof b !== 'number')
  ) {
    return false;
  }
  return normalizeIdentifier(String(a)) === normalizeIdentifier(String(b));
}

/**
 * A part's text as the floor reads it: a document read in part by OCR
 * without its reading-marker lines, whose page numbers nobody stated
 * (session/reading-assembly.ts).
 */
function matchText(part: SessionPart): string {
  return part.leg === 'document' ? withoutReadingMarkers(part.text) : part.text;
}

/** The values one part offers for a fact, as written and normalized. */
function valuesIn(
  fact: FactSpec,
  text: string,
): Array<{ raw: string; value: string | number }> {
  if (fact.kind === 'identifier') {
    const pattern = fact.pattern;
    if (!pattern) return [];
    return [...text.matchAll(IDENTIFIER_TOKEN)]
      .map((m) => m[0])
      .filter((raw) => pattern.test(raw))
      .map((raw) => ({ raw, value: normalizeIdentifier(raw) }));
  }
  if (fact.kind === 'number' || fact.kind === 'money') {
    return [...text.matchAll(NUMBER_TOKEN)].flatMap((m) => {
      const value = parseNumeric(m[0]);
      return value === null ? [] : [{ raw: m[0], value }];
    });
  }
  return [];
}

/**
 * The values a fact could have taken from these parts, at most
 * MAX_CANDIDATES in order of first appearance. `keep` is the parameter the
 * call used: when the sources state it as a candidate but the cap cut it,
 * it is added after the cap, so the semantic check can always pick the
 * value the action used when the input states it.
 */
export function candidatesFor(
  fact: FactSpec,
  parts: readonly SessionPart[],
  keep?: unknown,
): Candidate[] {
  const all = distinctValues(fact, parts);
  const listed = all.slice(0, MAX_CANDIDATES);
  if (keep === undefined || all.length === listed.length) return listed;
  const isKept = (c: Candidate) => sameValue(fact, c.value, keep);
  if (listed.some(isKept)) return listed;
  const cut = all.slice(MAX_CANDIDATES).find(isKept);
  return cut ? [...listed, cut] : listed;
}

/** Every distinct value the parts offer for a fact, first appearance first. */
function distinctValues(
  fact: FactSpec,
  parts: readonly SessionPart[],
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const { raw, value } of valuesIn(fact, matchText(part))) {
      const key = typeof value === 'number' ? `n:${value}` : `s:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ raw, value, seq: part.seq });
    }
  }
  return out;
}

/**
 * The first source part that states `value` for this fact, or undefined.
 * Independent of the fact's pattern: a value the sources state counts even
 * if the pattern would not have listed it.
 */
export function statedIn(
  fact: FactSpec,
  value: unknown,
  parts: readonly SessionPart[],
): SessionPart | undefined {
  if (fact.kind === 'number' || fact.kind === 'money') {
    const target = parseNumeric(value);
    if (target === null) return undefined;
    return parts.find((part) =>
      [...matchText(part).matchAll(NUMBER_TOKEN)].some((m) => {
        const n = parseNumeric(m[0]);
        return n !== null && numericEqual(n, target);
      }),
    );
  }
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const target = normalizeIdentifier(String(value));
  if (target.length === 0) return undefined;
  if (fact.kind === 'text') {
    return parts.find((part) => matchText(part).toLowerCase().includes(target));
  }
  return parts.find((part) =>
    [...matchText(part).matchAll(IDENTIFIER_TOKEN)].some(
      (m) => normalizeIdentifier(m[0]) === target,
    ),
  );
}

/**
 * The sender of the session's first `message:inbound` part from another
 * agent: who opened the conversation with this agent. `self` is the
 * session's own agent; a message it sent itself never makes it its own
 * counterparty.
 */
export function counterpartyOf(
  parts: readonly SessionPart[],
  self?: string,
): string | undefined {
  return parts.find(
    (p) => p.leg === 'message:inbound' && p.from.agentId !== self,
  )?.from.agentId;
}

/**
 * The parts a policy treats as sources: its legs, and its producers. A
 * message or document the session's own agent (`self`) sent itself is
 * never a source, whatever `from` says: the agent cannot be its own input.
 * A document's invisible text layer is never a source, whatever the config
 * says (`selectHiddenLayers`).
 */
export function selectSources(
  parts: readonly SessionPart[],
  legs: readonly string[],
  from: SourcesFrom,
  self?: string,
): SessionPart[] {
  return selectParts(parts, legs, from, self).filter(
    (part) => part.kind !== 'hidden-layer',
  );
}

/**
 * The invisible text layers of the documents the policy reads, chosen by
 * the same legs and producers as its sources. Not sources: a person looking
 * at the page sees the picture, so a value stated only here is one the
 * agent's model may have read but the sender never showed (#1573).
 */
export function selectHiddenLayers(
  parts: readonly SessionPart[],
  legs: readonly string[],
  from: SourcesFrom,
  self?: string,
): SessionPart[] {
  return selectParts(parts, legs, from, self).filter(
    (part) => part.kind === 'hidden-layer',
  );
}

function selectParts(
  parts: readonly SessionPart[],
  legs: readonly string[],
  from: SourcesFrom,
  self?: string,
): SessionPart[] {
  const counterparty = counterpartyOf(parts, self);
  return parts.filter((part) => {
    if (!legs.includes(part.leg)) return false;
    // The agent's own legs (its replies and tool calls) are not filtered by
    // producer: their trust comes from the leg, not from who sent them.
    if (!COUNTERPARTY_LEGS.has(part.leg)) return true;
    if (self !== undefined && part.from.agentId === self) return false;
    switch (from.kind) {
      case 'any':
        return true;
      case 'counterparty':
        return counterparty !== undefined && part.from.agentId === counterparty;
      case 'agent':
        return part.from.agentId === from.agentId;
    }
  });
}

/**
 * The distinct numbers a text states, read the way the floor reads them
 * (marker lines dropped). Used to tell whether a hidden text layer says
 * other numbers than the page a person sees.
 */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of withoutReadingMarkers(text).matchAll(NUMBER_TOKEN)) {
    const n = parseNumeric(m[0]);
    if (n !== null) out.add(n);
  }
  return out;
}

/** The file name a hidden-layer part's label carries. */
export function hiddenLayerDocument(part: SessionPart): string {
  const label = part.label ?? 'the document';
  return label.endsWith(HIDDEN_LAYER_LABEL_SUFFIX)
    ? label.slice(0, -HIDDEN_LAYER_LABEL_SUFFIX.length)
    : label;
}

/** How a value reads in a detection message. */
export function displayValue(fact: FactSpec, value: unknown): string {
  if (fact.kind === 'number' || fact.kind === 'money') {
    const n = parseNumeric(value);
    return n === null ? JSON.stringify(value) : String(n);
  }
  return JSON.stringify(typeof value === 'number' ? String(value) : value);
}
