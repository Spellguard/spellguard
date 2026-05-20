// SPDX-License-Identifier: Apache-2.0

/**
 * Tool Memory / Knowledge Store Policy Engine.
 *
 * Handles three policy types:
 *
 * ── memory-scope-isolation ───────────────────────────────────────────────────
 * Enforces that memory access is scoped to the agent's own session. Detects
 * cross-agent or cross-session key access patterns, preventing agents from
 * reading or writing memory namespaced to other agents.
 *
 * Config:
 *   allowedPrefixes?: string[]  — key prefixes this agent owns (e.g. ["agent_A:", "session_42:"])
 *   label?: string              — default: 'scope-violation'
 *
 * ── memory-injection-scan ────────────────────────────────────────────────────
 * Scans content retrieved from memory/RAG stores for prompt injection payloads
 * before they re-enter agent context. Treats stored memory as untrusted data,
 * guarding against context poisoning attacks.
 *
 * Config:
 *   sensitivity?: 'low' | 'medium' | 'high'  — default: 'medium'
 *   label?: string                            — default: 'input-injection'
 *
 * ── memory-size-limit ────────────────────────────────────────────────────────
 * Caps the size of memory reads/writes. Oversized payloads can flood the
 * agent's context window with attacker-controlled content (context flooding),
 * mask injections in noise, or exhaust token budgets.
 *
 * Config:
 *   maxBytes?: number  — maximum byte length of content (default: 10240 = 10 KB)
 *   label?: string     — default: 'payload-size-exceeded'
 */

import {
  INJECTION_HIGH_COMMON,
  INJECTION_LOW_COMMON,
  INJECTION_MEDIUM_COMMON,
  buildInjectionDetections,
} from './injection-patterns';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// ─── memory-scope-isolation ───────────────────────────────────────────────────

/**
 * Patterns that indicate a cross-agent or cross-session memory key is being
 * referenced. These match common key naming conventions like:
 *   agent:<other_id>:*, session:<other_id>:*, user:<id>:memory:*
 */
const CROSS_AGENT_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bagent[_:-]([a-zA-Z0-9_-]{1,})[_:-]/, // agent:<id>: prefix
  /\bsession[_:-]([a-zA-Z0-9_-]{1,})[_:-]/, // session:<id>: prefix
  /\bmemory[_:-](?:key|store|namespace)[_:-][a-zA-Z0-9]/i,
  /\b(?:read|get|fetch)[_-]?memory\s*\(\s*['"][^'"]{20,}/i, // long key in call
];

function evaluateMemoryScopeIsolation(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'scope-violation';
  const allowedPrefixes = (cfg.allowedPrefixes as string[]) || [];

  const detections: PolicyDetection[] = [];

  for (const re of CROSS_AGENT_KEY_PATTERNS) {
    const match = re.exec(ctx.content);
    if (!match) continue;

    const idx = match.index ?? 0;
    const matchedText = match[0];

    // If allowedPrefixes are configured, check the matched text against them
    if (allowedPrefixes.length > 0) {
      const isAllowed = allowedPrefixes.some((prefix) =>
        matchedText.startsWith(prefix),
      );
      if (isAllowed) continue;
    }

    detections.push({
      type: label,
      confidence: 0.8,
      message: `Cross-agent memory access pattern detected: ${matchedText.slice(0, 60)}`,
      spans: [{ start: idx, end: idx + matchedText.length }],
    });
  }

  return detections;
}

// ─── memory-injection-scan ────────────────────────────────────────────────────

/** Memory-engine-specific MEDIUM patterns (extends INJECTION_MEDIUM_COMMON). */
const MEMORY_INJECTION_MEDIUM: ReadonlyArray<RegExp> = [
  ...INJECTION_MEDIUM_COMMON,
  /when\s+the\s+(?:agent|assistant|model)\s+reads\s+this/i,
];

/** Memory-engine-specific LOW patterns (extends INJECTION_LOW_COMMON). */
const MEMORY_INJECTION_LOW: ReadonlyArray<RegExp> = [
  ...INJECTION_LOW_COMMON,
  /\bprompt\s+injection\b/i,
];

function evaluateMemoryReadInjection(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  return buildInjectionDetections(
    ctx,
    'input-injection',
    'Prompt injection in retrieved memory',
    INJECTION_HIGH_COMMON,
    MEMORY_INJECTION_MEDIUM,
    MEMORY_INJECTION_LOW,
  );
}

// ─── memory-size-limit ────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 10_240; // 10 KB

function evaluateMemorySizeLimit(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'payload-size-exceeded';
  const maxBytes = (cfg.maxBytes as number) || DEFAULT_MAX_BYTES;

  const byteLength = new TextEncoder().encode(ctx.content).length;

  if (byteLength > maxBytes) {
    return [
      {
        type: label,
        confidence: 1.0,
        message: `Memory content size exceeded: ${byteLength} bytes (limit: ${maxBytes} bytes)`,
      },
    ];
  }

  return [];
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class PolicyMemoryEngine implements PolicyEngine {
  readonly name = 'policy-memory-engine';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    switch (ctx.binding.policyType) {
      case 'scope-isolation':
        return evaluateMemoryScopeIsolation(ctx);
      case 'memory-injection-scan':
        return evaluateMemoryReadInjection(ctx);
      case 'payload-size-limit':
        return evaluateMemorySizeLimit(ctx);
      default:
        return [];
    }
  }
}
