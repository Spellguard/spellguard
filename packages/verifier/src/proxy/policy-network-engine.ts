// SPDX-License-Identifier: Apache-2.0

/**
 * Tool Network Policy Engine.
 *
 * Handles four policy types:
 *
 * ── url-ssrf ──────────────────────────────────────────────────────────────────
 * Detects Server-Side Request Forgery (SSRF) attempts: private IP ranges,
 * localhost, loopback addresses, and cloud metadata service endpoints.
 *
 * Config:
 *   blockMetadata?: boolean  — block cloud metadata IPs (default: true)
 *   label?: string           — default: 'ssrf'
 *
 * ── url-scheme-allowlist ─────────────────────────────────────────────────────
 * Enforces that only permitted URL schemes (default: https) appear in content.
 * Blocks file://, ftp://, javascript:, data:, gopher:, etc.
 *
 * Config:
 *   allowedSchemes?: string[]  — default: ['https']
 *   label?: string             — default: 'url-scheme-violation'
 *
 * ── network-injection-scan ───────────────────────────────────────────────────
 * Scans content returned from network fetch tool calls for prompt injection
 * payloads. Treats inbound web content as untrusted — never as instructions.
 *
 * Config:
 *   sensitivity?: 'low' | 'medium' | 'high'  — default: 'medium'
 *   label?: string                            — default: 'network-output-injection'
 *
 * ── exfil-flow-detection ─────────────────────────────────────────────────────
 * Detects the read-then-exfiltrate pattern: a recent inbound message contained
 * a data-read pattern (DB query, file read, memory access) and the current
 * message is an outbound write to a network endpoint (HTTP POST, webhook).
 *
 * Uses ctx.recentMessages to inspect the recent message sequence.
 *
 * Config:
 *   readPatterns?: string[]    — additional regex patterns indicating a read
 *   writePatterns?: string[]   — additional regex patterns indicating an exfil write
 *   windowSeconds?: number     — look-back window in seconds (default: 120)
 *   label?: string             — default: 'exfil-flow-detected'
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
import { compilePatterns } from './policy-helpers';

// ─── url-ssrf ─────────────────────────────────────────────────────────────────

/** Match bare IPs or IPs inside URLs in content. */
const IP_IN_CONTENT = /(?:https?:\/\/|@|^|\s)((?:\d{1,3}\.){3}\d{1,3})/gi;
const LOCALHOST_PATTERN =
  /(?:https?:\/\/)?(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])/gi;

/** Cloud metadata endpoints. */
const METADATA_PATTERNS: ReadonlyArray<RegExp> = [
  /169\.254\.169\.254/, // AWS/Azure/GCP metadata
  /metadata\.google\.internal/i, // GCP metadata DNS
  /fd00:ec2::/, // AWS metadata IPv6
];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p > 255))
    return false;
  const [a, b] = parts;
  return (
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    a === 127 // 127.0.0.0/8 loopback
  );
}

function evaluateUrlSsrf(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'ssrf';
  const blockMetadata = cfg.blockMetadata !== false;
  const blockLoopback = cfg.blockLoopback !== false;
  const blockPrivateIps = cfg.blockPrivateIps !== false;

  const detections: PolicyDetection[] = [];

  // Check localhost patterns
  if (blockLoopback) {
    for (const match of ctx.content.matchAll(LOCALHOST_PATTERN)) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 1.0,
        message: `SSRF: localhost/loopback address detected: ${match[0]}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  // Check private IP ranges
  if (blockPrivateIps) {
    for (const match of ctx.content.matchAll(IP_IN_CONTENT)) {
      const ip = match[1];
      if (isPrivateIpv4(ip)) {
        const idx = (match.index ?? 0) + match[0].indexOf(ip);
        detections.push({
          type: label,
          confidence: 0.95,
          message: `SSRF: private IP address detected: ${ip}`,
          spans: [{ start: idx, end: idx + ip.length }],
        });
      }
    }
  }

  // Check cloud metadata endpoints
  if (blockMetadata) {
    for (const re of METADATA_PATTERNS) {
      const match = re.exec(ctx.content);
      if (match) {
        const idx = match.index ?? 0;
        detections.push({
          type: label,
          confidence: 1.0,
          message: `SSRF: cloud metadata endpoint detected: ${match[0]}`,
          spans: [{ start: idx, end: idx + match[0].length }],
        });
      }
    }
  }

  return detections;
}

// ─── url-scheme-allowlist ─────────────────────────────────────────────────────

/** Extract scheme from URL-like patterns. */
const SCHEME_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]{1,20}):\/\//gi;

/** Dangerous URI schemes that don't use `://` (e.g. javascript:, vbscript:, data:). */
const DANGEROUS_URI_PATTERN = /\b(javascript|vbscript|data)\s*:/gi;

/** Dangerous non-http schemes that should never appear in tool arguments. */
const ALWAYS_BLOCKED_SCHEMES = new Set([
  'javascript',
  'vbscript',
  'data',
  'gopher',
]);

function evaluateUrlSchemeAllowlist(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'url-scheme-violation';
  const allowedSchemes = new Set(
    ((cfg.allowedSchemes as string[]) || ['https']).map((s) => s.toLowerCase()),
  );

  const detections: PolicyDetection[] = [];

  // Check for dangerous URI schemes that don't use ://
  for (const match of ctx.content.matchAll(DANGEROUS_URI_PATTERN)) {
    const idx = match.index ?? 0;
    detections.push({
      type: label,
      confidence: 1.0,
      message: `Forbidden URL scheme: ${match[1].toLowerCase()}:`,
      spans: [{ start: idx, end: idx + match[0].length }],
    });
  }

  for (const match of ctx.content.matchAll(SCHEME_PATTERN)) {
    const scheme = match[1].toLowerCase();

    if (ALWAYS_BLOCKED_SCHEMES.has(scheme)) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 1.0,
        message: `Forbidden URL scheme: ${scheme}://`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
      continue;
    }

    if (!allowedSchemes.has(scheme)) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 0.9,
        message: `URL scheme not in allowlist: ${scheme}://`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  return detections;
}

// ─── network-injection-scan ───────────────────────────────────────────────────

function evaluateNetworkOutputInjection(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  return buildInjectionDetections(
    ctx,
    'network-output-injection',
    'Prompt injection in network response',
    INJECTION_HIGH_COMMON,
    INJECTION_MEDIUM_COMMON,
    INJECTION_LOW_COMMON,
  );
}

// ─── exfil-flow-detection ─────────────────────────────────────────────────────

/** Patterns indicating a data-read operation in a message. */
const DEFAULT_READ_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:SELECT|QUERY)\b.*\bFROM\b/i,
  /\bread[_-]?file\b/i,
  /\bget[_-]?file\b/i,
  /\bfetch[_-]?file\b/i,
  /\bread[_-]?memory\b/i,
  /\bget[_-]?memory\b/i,
  /\bsearch[_-]?database\b/i,
  /\bquery[_-]?db\b/i,
];

/** Patterns indicating an outbound write/send operation in a message. */
const DEFAULT_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:POST|PUT|PATCH)\s+https?:\/\//i,
  /\bhttp[_-]?(?:post|request)\b/i,
  /\bsend[_-]?(?:request|data|payload)\b/i,
  /\bwebhook\b/i,
  /\bnotify\b.*https?:\/\//i,
  /\bupload\b.*https?:\/\//i,
];

function evaluateExfilFlowDetection(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'exfil-flow-detected';
  const windowSeconds = (cfg.windowSeconds as number) || 120;
  const extraReadPatterns = (cfg.readPatterns as string[]) || [];
  const extraWritePatterns = (cfg.writePatterns as string[]) || [];

  // Only relevant when the current message looks like an outbound write
  const allWritePatterns: RegExp[] = [
    ...DEFAULT_WRITE_PATTERNS,
    ...compilePatterns(extraWritePatterns),
  ];

  const currentIsWrite = allWritePatterns.some((re) => re.test(ctx.content));
  if (!currentIsWrite) return [];

  // Look for a recent read operation in message history
  const recentMessages = ctx.recentMessages || [];
  if (recentMessages.length === 0) return [];

  const windowMs = windowSeconds * 1000;
  const now = Date.now();

  const allReadPatterns: RegExp[] = [
    ...DEFAULT_READ_PATTERNS,
    ...compilePatterns(extraReadPatterns),
  ];

  const recentReadFound = recentMessages.some(
    (msg) =>
      now - msg.timestamp <= windowMs &&
      allReadPatterns.some((re) => re.test(msg.content)),
  );

  if (recentReadFound) {
    return [
      {
        type: label,
        confidence: 0.85,
        message:
          'Exfiltration flow detected: data read followed by outbound network write',
      },
    ];
  }

  return [];
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class PolicyNetworkEngine implements PolicyEngine {
  readonly name = 'policy-network-engine';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    switch (ctx.binding.policyType) {
      case 'ssrf':
        return evaluateUrlSsrf(ctx);
      case 'scheme-allowlist':
        return evaluateUrlSchemeAllowlist(ctx);
      case 'network-injection-scan':
        return evaluateNetworkOutputInjection(ctx);
      case 'flow-exfiltration':
        return evaluateExfilFlowDetection(ctx);
      default:
        return [];
    }
  }
}
