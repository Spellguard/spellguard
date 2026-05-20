// SPDX-License-Identifier: Apache-2.0

/**
 * Tool Database Policy Engine.
 *
 * Handles three policy types:
 *
 * ── sql-injection ─────────────────────────────────────────────────────────────
 * Detects SQL injection patterns in content — tautologies, UNION attacks, comment
 * escapes, stacked queries, out-of-band exfiltration functions, and more.
 *
 * Config:
 *   customPatterns?: string[]  — additional regex patterns to check
 *   label?: string             — default: 'query-injection'
 *
 * ── ddl-block ─────────────────────────────────────────────────────────────────
 * Blocks DDL operations (DROP, ALTER, TRUNCATE, CREATE, RENAME) unless the
 * agent has been explicitly granted schema-mutate scope via the allowedDdl list.
 *
 * Config:
 *   allowedDdl?: string[]  — DDL verbs explicitly permitted (e.g. ["CREATE INDEX"])
 *   label?: string         — default: 'ddl-blocked'
 *
 * ── db-read-only ─────────────────────────────────────────────────────────────
 * Enforces read-only database access. Blocks INSERT, UPDATE, DELETE, REPLACE,
 * UPSERT, MERGE unless an exception is declared.
 *
 * Config:
 *   label?: string  — default: 'write-blocked'
 */

import { safeRegex } from './builtin-engine';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// ─── sql-injection ────────────────────────────────────────────────────────────

const SQL_INJECTION_PATTERNS: ReadonlyArray<{
  re: RegExp;
  msg: string;
  confidence: number;
}> = [
  // Classic tautology attacks
  {
    re: /'\s*(?:OR|AND)\s*'?\d+'?\s*=\s*'?\d+/i,
    msg: "tautology: ' OR '1'='1",
    confidence: 0.98,
  },
  {
    re: /'\s*(?:OR|AND)\s+'[^']*'\s*=\s*'[^']*'/i,
    msg: 'string tautology',
    confidence: 0.95,
  },
  // UNION-based injection
  {
    re: /\bUNION\s+(?:ALL\s+)?SELECT\b/i,
    msg: 'UNION SELECT attack',
    confidence: 0.98,
  },
  // Stacked queries / batch injection
  {
    re: /;\s*(?:DROP|DELETE|INSERT|UPDATE|ALTER|EXEC|EXECUTE)\b/i,
    msg: 'stacked query injection',
    confidence: 0.95,
  },
  // SQL comment escapes
  {
    re: /(?:--|#|\/\*)\s*$/,
    msg: 'SQL comment escape at end of value',
    confidence: 0.8,
  },
  { re: /'[^']*--/, msg: 'SQL comment after quote escape', confidence: 0.85 },
  // Blind injection patterns
  {
    re: /\bAND\s+\d+\s*=\s*\d+\b/i,
    msg: 'blind boolean injection',
    confidence: 0.75,
  },
  {
    re: /\bAND\s+SLEEP\s*\(\d+\)/i,
    msg: 'time-based blind injection (SLEEP)',
    confidence: 0.98,
  },
  {
    re: /\bWAITFOR\s+DELAY\b/i,
    msg: 'time-based blind injection (WAITFOR)',
    confidence: 0.98,
  },
  {
    re: /\bBENCHMARK\s*\(/i,
    msg: 'time-based blind injection (BENCHMARK)',
    confidence: 0.95,
  },
  // Out-of-band exfiltration
  { re: /\bLOAD_FILE\s*\(/i, msg: 'LOAD_FILE file read', confidence: 0.9 },
  {
    re: /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i,
    msg: 'INTO OUTFILE exfiltration',
    confidence: 0.98,
  },
  { re: /\bxp_cmdshell\b/i, msg: 'xp_cmdshell execution', confidence: 1.0 },
  {
    re: /\bsp_executesql\b/i,
    msg: 'sp_executesql dynamic execution',
    confidence: 0.9,
  },
  // Encoding tricks
  {
    re: /(?:CHAR|CHR|NCHAR)\s*\(\s*\d+\s*\)/i,
    msg: 'character encoding bypass',
    confidence: 0.75,
  },
  { re: /0x[0-9a-f]{4,}/i, msg: 'hex-encoded SQL payload', confidence: 0.7 },
];

function evaluateSqlInjection(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'query-injection';
  const customPatterns = (cfg.customPatterns as string[]) || [];

  const detections: PolicyDetection[] = [];

  for (const { re, msg, confidence } of SQL_INJECTION_PATTERNS) {
    const match = re.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence,
        message: `SQL injection detected: ${msg}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  for (const patternStr of customPatterns) {
    const re = safeRegex(patternStr);
    if (re) {
      const match = re.exec(ctx.content);
      if (match) {
        const idx = match.index ?? 0;
        detections.push({
          type: label,
          confidence: 0.8,
          message: 'Custom SQL injection pattern matched',
          spans: [{ start: idx, end: idx + match[0].length }],
        });
      }
    } else {
      // Skip invalid regex
    }
  }

  return detections;
}

// ─── ddl-block ────────────────────────────────────────────────────────────────

/** DDL verbs that mutate schema. */
const DDL_PATTERNS: ReadonlyArray<{ re: RegExp; verb: string }> = [
  {
    re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|PROCEDURE|FUNCTION|TRIGGER)\b/i,
    verb: 'DROP',
  },
  {
    re: /\bALTER\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|PROCEDURE|FUNCTION)\b/i,
    verb: 'ALTER',
  },
  { re: /\bTRUNCATE\s+(?:TABLE\s+)?\w/i, verb: 'TRUNCATE' },
  {
    re: /\bCREATE\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|PROCEDURE|FUNCTION|TRIGGER)\b/i,
    verb: 'CREATE',
  },
  { re: /\bRENAME\s+(?:TABLE|COLUMN|DATABASE)\b/i, verb: 'RENAME' },
];

function evaluateDdlBlock(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'ddl-blocked';
  const allowedDdl = ((cfg.allowedDdl as string[]) || []).map((s) =>
    s.toUpperCase(),
  );

  const detections: PolicyDetection[] = [];

  for (const { re, verb } of DDL_PATTERNS) {
    // Check if this DDL verb is in the explicitly allowed list
    if (allowedDdl.some((a) => a.startsWith(verb))) continue;

    const match = re.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 0.97,
        message: `DDL operation blocked: ${verb}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  return detections;
}

// ─── db-read-only ─────────────────────────────────────────────────────────────

const WRITE_SQL_PATTERNS: ReadonlyArray<{ re: RegExp; verb: string }> = [
  { re: /\bINSERT\s+(?:INTO\s+)?\w/i, verb: 'INSERT' },
  { re: /\bUPDATE\s+\w+\s+SET\b/i, verb: 'UPDATE' },
  { re: /\bDELETE\s+FROM\s+\w/i, verb: 'DELETE' },
  { re: /\bREPLACE\s+INTO\s+\w/i, verb: 'REPLACE' },
  { re: /\bUPSERT\b/i, verb: 'UPSERT' },
  { re: /\bMERGE\s+INTO\s+\w/i, verb: 'MERGE' },
  { re: /\bCALL\s+\w+\s*\(/i, verb: 'CALL (stored procedure)' },
];

function evaluateDbReadOnly(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'write-blocked';

  const detections: PolicyDetection[] = [];

  for (const { re, verb } of WRITE_SQL_PATTERNS) {
    const match = re.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 0.97,
        message: `Write operation blocked in read-only mode: ${verb}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  return detections;
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class PolicyDatabaseEngine implements PolicyEngine {
  readonly name = 'policy-database-engine';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    switch (ctx.binding.policyType) {
      case 'query-injection':
        return evaluateSqlInjection(ctx);
      case 'ddl-block':
        return evaluateDdlBlock(ctx);
      case 'write-block':
        return evaluateDbReadOnly(ctx);
      default:
        return [];
    }
  }
}
