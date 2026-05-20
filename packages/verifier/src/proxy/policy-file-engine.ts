// SPDX-License-Identifier: Apache-2.0

/**
 * Tool File System Policy Engine.
 *
 * Handles three policy types:
 *
 * ── path-traversal ───────────────────────────────────────────────────────────
 * Detects directory traversal and access to sensitive system paths in tool
 * arguments. Blocks requests like `../../etc/passwd`, `/root/.ssh/id_rsa`, etc.
 *
 * Config:
 *   extraBlockedPaths?: string[]  — additional path prefixes to block
 *   label?: string                — default: 'path-traversal'
 *
 * ── path-sandbox ─────────────────────────────────────────────────────────────
 * Enforces that any file path referenced in content must reside within one of
 * the declared allowed directories. Useful when agents are restricted to a
 * working directory (e.g. "/workspace").
 *
 * Config:
 *   allowedPaths: string[]  — permitted directory prefixes (e.g. ["/workspace"])
 *   label?: string          — default: 'path-sandbox-violation'
 *
 * ── input-injection-scan ─────────────────────────────────────────────────────
 * Scans content sourced from tool outputs (file reads, web fetches, memory
 * retrievals, API responses) for prompt injection payloads before they
 * re-enter agent context. Treats all tool-sourced content as untrusted input.
 *
 * Config:
 *   sensitivity?: 'low' | 'medium' | 'high'  — default: 'medium'
 *   label?: string                            — default: 'input-injection'
 */

import {
  INJECTION_HIGH_COMMON,
  INJECTION_LOW_COMMON,
  INJECTION_MEDIUM_COMMON,
  buildInjectionDetections,
} from './injection-patterns';
import type {
  DetectionSpan,
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Regex to extract file-system-looking paths from arbitrary text. */
const PATH_PATTERN =
  /(?:^|[\s"'`(,=])(\/?(?:\.{1,2}\/)+[^\s"'`),;]*|\/[a-zA-Z0-9._/-]{3,}|~\/[^\s"'`),;]*)/g;

/** Dangerous path prefixes and patterns. */
const BLOCKED_PATHS: ReadonlyArray<string> = [
  '../',
  '..\\',
  '/etc/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/root/',
  '/boot/',
  '/run/',
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '/.env',
  '.env',
];

const BLOCKED_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\.\.[\\/]/, // traversal sequences
  /\/?etc\/(passwd|shadow|hosts|sudoers)/i, // classic sensitive files
  /\/?\.ssh\//i, // SSH keys
  /\/?\.aws\//i, // AWS credentials
  /\/?\.gnupg\//i, // GPG keys
  /\/?proc\/\d+\//, // process filesystem
  /\/?sys\/kernel/i, // kernel parameters
  /\.env(\.|$)/i, // .env files
  /id_rsa|id_ed25519|id_ecdsa/i, // private key filenames
];

function extractPaths(content: string): Array<{ path: string; index: number }> {
  const results: Array<{ path: string; index: number }> = [];
  for (const match of content.matchAll(PATH_PATTERN)) {
    const path = match[1];
    if (path)
      results.push({
        path,
        index: (match.index ?? 0) + match[0].indexOf(path),
      });
  }
  return results;
}

// ─── file-path-traversal engine ───────────────────────────────────────────────

function evaluatePathTraversal(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'path-traversal';
  const extraBlocked = (cfg.extraBlockedPaths as string[]) || [];

  const detections: PolicyDetection[] = [];
  const paths = extractPaths(ctx.content);

  for (const { path, index } of paths) {
    // Check static blocked prefixes
    const blockedPrefix = BLOCKED_PATHS.find((p) => path.includes(p));
    if (blockedPrefix) {
      detections.push({
        type: label,
        confidence: 1.0,
        message: `Dangerous path detected: ${path}`,
        spans: [{ start: index, end: index + path.length }],
      });
      continue;
    }

    // Check regex patterns
    const blockedPattern = BLOCKED_PATH_PATTERNS.find((re) => re.test(path));
    if (blockedPattern) {
      detections.push({
        type: label,
        confidence: 0.95,
        message: `Suspicious path pattern detected: ${path}`,
        spans: [{ start: index, end: index + path.length }],
      });
      continue;
    }

    // Check operator-supplied extras
    if (
      extraBlocked.some(
        (extra) => path.startsWith(extra) || path.includes(extra),
      )
    ) {
      detections.push({
        type: label,
        confidence: 1.0,
        message: `Path blocked by policy: ${path}`,
        spans: [{ start: index, end: index + path.length }],
      });
    }
  }

  return detections;
}

// ─── file-sandbox engine ──────────────────────────────────────────────────────

function evaluateFileSandbox(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'path-sandbox-violation';
  const allowedPaths = (cfg.allowedPaths as string[]) || [];

  if (allowedPaths.length === 0) return []; // No sandbox configured — skip

  const detections: PolicyDetection[] = [];
  const paths = extractPaths(ctx.content);

  for (const { path, index } of paths) {
    // Normalise: resolve any leading ./ but don't do full FS resolution
    const normalised = path.replace(/^\.\//, '');

    const isAllowed = allowedPaths.some(
      (allowed) =>
        normalised === allowed ||
        normalised.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`),
    );

    if (!isAllowed) {
      detections.push({
        type: label,
        confidence: 0.9,
        message: `File path outside sandbox: ${path}`,
        spans: [{ start: index, end: index + path.length }],
      });
    }
  }

  return detections;
}

// ─── input-injection-scan engine ─────────────────────────────────────────────

/** File-engine-specific HIGH patterns (extends INJECTION_HIGH_COMMON). */
const INJECTION_PATTERNS_HIGH: ReadonlyArray<RegExp> = [
  ...INJECTION_HIGH_COMMON,
  /\bsystem\s*:\s*you\s+(are|must|should|will)/i,
];

/** File-engine-specific MEDIUM patterns (extends INJECTION_MEDIUM_COMMON). */
const INJECTION_PATTERNS_MEDIUM: ReadonlyArray<RegExp> = [
  ...INJECTION_MEDIUM_COMMON,
  /DAN\s+mode/i,
  /base64\s*(?:decode|encoded)/i, // base64 encoding references
];

/** File-engine-specific LOW patterns (extends INJECTION_LOW_COMMON). */
const INJECTION_PATTERNS_LOW: ReadonlyArray<RegExp> = [
  ...INJECTION_LOW_COMMON,
  /\bprompt\s+injection/i,
];

function evaluateInputInjection(ctx: PolicyEvalContext): PolicyDetection[] {
  return buildInjectionDetections(
    ctx,
    'input-injection',
    'Prompt injection pattern in tool input',
    INJECTION_PATTERNS_HIGH,
    INJECTION_PATTERNS_MEDIUM,
    INJECTION_PATTERNS_LOW,
  );
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class PolicyFileEngine implements PolicyEngine {
  readonly name = 'policy-file-engine';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    switch (ctx.binding.policyType) {
      case 'path-traversal':
        return evaluatePathTraversal(ctx);
      case 'path-sandbox':
        return evaluateFileSandbox(ctx);
      case 'input-injection-scan':
        return evaluateInputInjection(ctx);
      default:
        return [];
    }
  }
}
