// SPDX-License-Identifier: Apache-2.0

/**
 * Tool Meta-Policy Engine.
 *
 * Handles cross-cutting policies that apply regardless of tool category:
 *
 * ── tool-call-rate-limit ──────────────────────────────────────────────────────
 * Per-agent, per-tool rate limiting. Prevents runaway loops and Denial-of-Wallet
 * attacks by capping how many times a given agent can invoke a named tool within
 * a sliding time window. State is held in-process (resets on Verifier restart).
 *
 * Config:
 *   toolName?: string        — tool to rate-limit (omit to apply to all tools)
 *   maxCalls: number         — maximum invocations allowed in the window
 *   windowSeconds: number    — sliding window duration in seconds
 *   label?: string           — default: 'tool-rate-limit-exceeded'
 *
 * ── irreversible-action-gate ─────────────────────────────────────────────────
 * Blocks tool calls that are declared irreversible (delete, publish, send,
 * pay) unless the operator has added an explicit exception. Designed to
 * require human-in-the-loop review before destructive operations proceed.
 *
 * Config:
 *   irreversibleTools: string[]  — tool name patterns to block (supports simple wildcards)
 *   label?: string               — default: 'irreversible-action-blocked'
 *
 * ── tool-output-size-limit ───────────────────────────────────────────────────
 * Caps the byte size of tool output content returned to the agent. Oversized
 * tool outputs are a vector for context flooding (embedding hidden instructions
 * in a wall of legitimate text) and excessive token consumption.
 *
 * Config:
 *   maxBytes?: number  — default: 51200 (50 KB)
 *   label?: string     — default: 'tool-output-size-exceeded'
 *
 * ── cross-tool-data-flow ─────────────────────────────────────────────────────
 * Detects when untrusted external content (sourced from a web fetch, file read,
 * or inbound message) flows directly into a high-privilege tool call within the
 * same turn. This is the generalised form of the exfil-flow-detection pattern:
 * any untrusted → privileged transition is flagged, not just network writes.
 *
 * Uses ctx.recentMessages to track source signals.
 *
 * Config:
 *   untrustedSources?: string[]   — regex patterns identifying untrusted reads
 *   privilegedTargets?: string[]  — regex patterns identifying privileged writes
 *   windowSeconds?: number        — look-back window (default: 60)
 *   label?: string                — default: 'data-flow-taint'
 */

import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';
import { compilePatterns } from './policy-helpers';

// ─── tool-call-rate-limit ────────────────────────────────────────────────────

interface RateBucket {
  calls: number;
  windowStart: number;
}

/** In-process rate counter map. Key: `<agentId>:<toolName>`. */
const rateBuckets = new Map<string, RateBucket>();

// Periodically evict buckets idle for more than 10 minutes to prevent unbounded growth.
// Lazy-initialized on first evaluation — some runtimes disallow module-level
// timers, so the interval is deferred until an actual evaluation happens.
let _rateBucketCleanup: ReturnType<typeof setInterval> | undefined;
function ensureRateBucketCleanup(): void {
  if (_rateBucketCleanup) return;
  _rateBucketCleanup = setInterval(() => {
    const cutoff = Date.now() - 600_000;
    for (const [key, bucket] of rateBuckets) {
      if (bucket.windowStart < cutoff) rateBuckets.delete(key);
    }
  }, 60_000);
  if (typeof _rateBucketCleanup === 'object' && 'unref' in _rateBucketCleanup) {
    (_rateBucketCleanup as { unref: () => void }).unref();
  }
}

function evaluateToolCallRateLimit(ctx: PolicyEvalContext): PolicyDetection[] {
  ensureRateBucketCleanup();
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'tool-rate-limit-exceeded';
  const toolName = (cfg.toolName as string) || '*';
  const maxCalls = (cfg.maxCalls as number) || 10;
  const windowSeconds = (cfg.windowSeconds as number) || 60;

  const agentId = ctx.agentId || 'unknown';
  const bucketKey = `${agentId}:${toolName}`;
  const windowMs = windowSeconds * 1000;
  const now = Date.now();

  // Get or initialise bucket
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { calls: 0, windowStart: now };
    rateBuckets.set(bucketKey, bucket);
  }

  bucket.calls += 1;

  if (bucket.calls > maxCalls) {
    return [
      {
        type: label,
        confidence: 1.0,
        message: `Tool rate limit exceeded for "${toolName}": ${bucket.calls} calls in ${windowSeconds}s (max: ${maxCalls})`,
      },
    ];
  }

  return [];
}

// ─── irreversible-action-gate ─────────────────────────────────────────────────

/** Default tool name patterns considered irreversible. */
const DEFAULT_IRREVERSIBLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bdelete[_\s-]?(?:file|record|row|item|object|bucket|database|collection)\b/i,
  /\bdrop[_\s-]?(?:table|database|schema|collection)\b/i,
  /\bsend[_\s-]?(?:email|mail|message|sms|push[_\s-]?notification)\b/i,
  /\bpublish[_\s-]?(?:post|article|message|event)\b/i,
  /\bpay(?:ment)?[_\s-]?(?:process|execute|submit|charge)\b/i,
  /\btransfer[_\s-]?(?:funds|money|balance)\b/i,
  /\bsubmit[_\s-]?(?:form|order|transaction)\b/i,
  /\bdeployment?\b/i,
  /\bpermanently[_\s-]?(?:delete|remove|destroy)\b/i,
];

/** Convert a simple glob pattern (supports * wildcard) to a RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/_/g, '[_\\-\\s]')
    .replace(/\*/g, '.*');
  return new RegExp(escaped, 'i');
}

function evaluateIrreversibleActionGate(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'irreversible-action-blocked';
  const irreversibleTools = (cfg.irreversibleTools as string[]) || [];

  const detections: PolicyDetection[] = [];

  // Check operator-configured tools first
  for (const toolPattern of irreversibleTools) {
    const re = globToRegex(toolPattern);
    const match = re.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 1.0,
        message: `Irreversible tool invocation blocked: ${toolPattern}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  // If no operator-configured list, fall back to built-in defaults
  if (irreversibleTools.length === 0) {
    for (const re of DEFAULT_IRREVERSIBLE_PATTERNS) {
      const match = re.exec(ctx.content);
      if (match) {
        const idx = match.index ?? 0;
        detections.push({
          type: label,
          confidence: 0.85,
          message: `Potentially irreversible tool invocation detected: ${match[0].slice(0, 60)}`,
          spans: [{ start: idx, end: idx + match[0].length }],
        });
        break; // One detection per evaluation is sufficient for review
      }
    }
  }

  return detections;
}

// ─── tool-output-size-limit ───────────────────────────────────────────────────

const DEFAULT_OUTPUT_MAX_BYTES = 51_200; // 50 KB

function evaluateToolOutputSizeLimit(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'tool-output-size-exceeded';
  const maxBytes = (cfg.maxBytes as number) || DEFAULT_OUTPUT_MAX_BYTES;

  const byteLength = new TextEncoder().encode(ctx.content).length;

  if (byteLength > maxBytes) {
    return [
      {
        type: label,
        confidence: 1.0,
        message: `Tool output size exceeded: ${byteLength} bytes (limit: ${maxBytes} bytes)`,
      },
    ];
  }

  return [];
}

// ─── cross-tool-data-flow ─────────────────────────────────────────────────────

/** Default patterns indicating an untrusted external data source was accessed. */
const DEFAULT_UNTRUSTED_SOURCE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bfetch[_-]?(?:url|page|website)\b/i,
  /\bweb[_-]?(?:scrape|fetch|request|get)\b/i,
  /\bhttp[_-]?(?:get|request)\b/i,
  /\bread[_-]?(?:file|document)\b/i,
  /\binbound[_-]?message\b/i,
  /\bexternal[_-]?(?:data|content|input)\b/i,
  /\buser[_-]?(?:input|upload|provided)\b/i,
];

/** Default patterns indicating a high-privilege write/action tool is being invoked. */
const DEFAULT_PRIVILEGED_TARGET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bexec(?:ute)?[_-]?(?:command|code|shell|script)\b/i,
  /\brun[_-]?(?:command|script|code)\b/i,
  /\bsend[_-]?(?:email|message|request|webhook)\b/i,
  /\bwrite[_-]?(?:file|database|db|record)\b/i,
  /\binsert[_-]?(?:into|record|row)\b/i,
  /\bupdate[_-]?(?:record|row|database)\b/i,
  /\bdelete[_-]?(?:file|record|row)\b/i,
  /\bpost[_-]?(?:to|request)\b/i,
];

function evaluateCrossToolDataFlow(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'data-flow-taint';
  const windowSeconds = (cfg.windowSeconds as number) || 60;
  const extraUntrustedPatterns = (cfg.untrustedSources as string[]) || [];
  const extraPrivilegedPatterns = (cfg.privilegedTargets as string[]) || [];

  // Build all privileged target patterns and check if current message matches
  const allPrivilegedPatterns: RegExp[] = [
    ...DEFAULT_PRIVILEGED_TARGET_PATTERNS,
    ...compilePatterns(extraPrivilegedPatterns),
  ];

  const currentIsPrivileged = allPrivilegedPatterns.some((re) =>
    re.test(ctx.content),
  );
  if (!currentIsPrivileged) return [];

  // Look back through recent messages for an untrusted data source
  const recentMessages = ctx.recentMessages || [];
  if (recentMessages.length === 0) return [];

  const windowMs = windowSeconds * 1000;
  const now = Date.now();

  const allUntrustedPatterns: RegExp[] = [
    ...DEFAULT_UNTRUSTED_SOURCE_PATTERNS,
    ...compilePatterns(extraUntrustedPatterns),
  ];

  const untrustedSourceFound = recentMessages.some(
    (msg) =>
      now - msg.timestamp <= windowMs &&
      allUntrustedPatterns.some((re) => re.test(msg.content)),
  );

  if (untrustedSourceFound) {
    return [
      {
        type: label,
        confidence: 0.85,
        message:
          'Cross-tool data flow: untrusted external data flowing into privileged tool invocation',
      },
    ];
  }

  return [];
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class PolicyMetaEngine implements PolicyEngine {
  readonly name = 'policy-meta-engine';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    switch (ctx.binding.policyType) {
      case 'invocation-rate-limit':
        return evaluateToolCallRateLimit(ctx);
      case 'irreversible-gate':
        return evaluateIrreversibleActionGate(ctx);
      case 'output-size-limit':
        return evaluateToolOutputSizeLimit(ctx);
      case 'data-flow-taint':
        return evaluateCrossToolDataFlow(ctx);
      default:
        return [];
    }
  }
}
