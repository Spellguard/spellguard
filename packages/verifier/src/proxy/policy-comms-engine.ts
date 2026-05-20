// SPDX-License-Identifier: Apache-2.0

/**
 * Tool Communications (Email / Messaging) Policy Engine.
 *
 * Handles three policy types:
 *
 * ── email-recipient-allowlist ─────────────────────────────────────────────────
 * Restricts outbound email/message recipients to a pre-approved list. Any
 * email address not matching the allowlist triggers a detection. Supports
 * exact addresses and domain wildcards (e.g. "@acme.com").
 *
 * Config:
 *   allowedRecipients: string[]  — email addresses or @domain.com wildcards
 *   label?: string               — default: 'recipient-blocked'
 *
 * ── email-body-injection ─────────────────────────────────────────────────────
 * Scans outbound email/message body content for injected instructions,
 * exfiltrated data patterns, embedded commands, and PII-like markers.
 * Designed to catch indirect prompt injection that co-opts the agent into
 * forwarding sensitive data or instructions to external parties.
 *
 * Config:
 *   scanFor?: Array<'injection' | 'exfil' | 'commands'>  — default: all
 *   label?: string                                        — default: 'output-risk-scan'
 *
 * ── message-sequence-gate ─────────────────────────────────────────────────────
 * Blocks outbound send_email / send_message / webhook calls when a data-read
 * tool call (file read, DB query, memory access) was observed in the recent
 * message history within the configured window. This catches the classic
 * indirect injection → exfiltration chain without inspecting content.
 *
 * Uses ctx.recentMessages to inspect the recent message sequence.
 *
 * Config:
 *   readPatterns?: string[]   — additional regex patterns indicating a read
 *   sendPatterns?: string[]   — additional regex patterns indicating a send
 *   windowSeconds?: number    — look-back window in seconds (default: 120)
 *   label?: string            — default: 'sequence-blocked'
 */

import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';
import { compilePatterns } from './policy-helpers';

// ─── email-recipient-allowlist ────────────────────────────────────────────────

/** Match email addresses in content. */
const EMAIL_PATTERN = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;

function recipientIsAllowed(
  address: string,
  allowedRecipients: string[],
): boolean {
  const lower = address.toLowerCase();
  for (const entry of allowedRecipients) {
    const rule = entry.toLowerCase().trim();
    if (rule.startsWith('@')) {
      // Domain wildcard: @acme.com matches anyone@acme.com
      if (lower.endsWith(rule)) return true;
    } else {
      if (lower === rule) return true;
    }
  }
  return false;
}

function evaluateEmailRecipientAllowlist(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'recipient-blocked';
  const allowedRecipients = (cfg.allowedRecipients as string[]) || [];

  if (allowedRecipients.length === 0) return []; // No allowlist — skip

  const detections: PolicyDetection[] = [];

  for (const match of ctx.content.matchAll(EMAIL_PATTERN)) {
    const address = match[0];
    if (!recipientIsAllowed(address, allowedRecipients)) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 1.0,
        message: `Email recipient not in allowlist: ${address}`,
        spans: [{ start: idx, end: idx + address.length }],
      });
    }
  }

  return detections;
}

// ─── email-body-injection ─────────────────────────────────────────────────────

const BODY_INJECTION_PATTERNS: ReadonlyArray<{ re: RegExp; msg: string }> = [
  {
    re: /ignore\s+(all\s+)?previous\s+instructions?/i,
    msg: 'prompt injection payload',
  },
  {
    re: /you\s+are\s+now\s+(a\s+)?(?:an?\s+)?\w/i,
    msg: 'role-override injection',
  },
  { re: /new\s+instructions?:/i, msg: 'instruction override marker' },
  { re: /\[INST\]|\[\/INST\]/i, msg: 'Llama instruction marker' },
  {
    re: /\u200b|\u200c|\u200d|\ufeff/,
    msg: 'zero-width / invisible characters',
  },
  { re: /<\s*script[^>]*>/i, msg: 'script tag injection' },
  { re: /javascript\s*:/i, msg: 'javascript: URI in body' },
];

const BODY_EXFIL_PATTERNS: ReadonlyArray<{ re: RegExp; msg: string }> = [
  {
    re: /(?:password|passwd|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S+/i,
    msg: 'credential-like string in body',
  },
  {
    re: /\b(?:SSN|social\s+security)\s*:?\s*\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/i,
    msg: 'SSN pattern',
  },
  {
    re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
    msg: 'credit card number pattern',
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/, msg: 'AWS access key' },
  { re: /BEGIN\s+(?:RSA\s+|EC\s+)?PRIVATE\s+KEY/i, msg: 'private key block' },
];

const BODY_COMMAND_PATTERNS: ReadonlyArray<{ re: RegExp; msg: string }> = [
  {
    re: /\bexec(?:ute)?\s+(?:this|the\s+following)\s+command/i,
    msg: 'embedded command execution request',
  },
  {
    re: /run\s+(?:this|the\s+following)\s+(?:script|code|command)/i,
    msg: 'embedded code execution request',
  },
  {
    re: /\bwhen\s+you\s+receive\s+this\b/i,
    msg: 'deferred instruction pattern',
  },
  { re: /\bforward\s+this\s+to\b/i, msg: 'forwarding instruction in body' },
];

function evaluateEmailBodyInjection(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'output-risk-scan';
  const scanFor = (cfg.scanFor as string[]) || [
    'injection',
    'exfil',
    'commands',
  ];

  const detections: PolicyDetection[] = [];

  const allPatterns: Array<{ re: RegExp; msg: string }> = [
    ...(scanFor.includes('injection') ? BODY_INJECTION_PATTERNS : []),
    ...(scanFor.includes('exfil') ? BODY_EXFIL_PATTERNS : []),
    ...(scanFor.includes('commands') ? BODY_COMMAND_PATTERNS : []),
  ];

  for (const { re, msg } of allPatterns) {
    const match = re.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      const isInjection = BODY_INJECTION_PATTERNS.some((p) => p.re === re);
      detections.push({
        type: label,
        confidence: isInjection ? 0.9 : 0.8,
        message: `Email body risk: ${msg}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  return detections;
}

// ─── message-sequence-gate ───────────────────────────────────────────────────

/** Patterns in message content that indicate a data-read tool was invoked. */
const DEFAULT_READ_INDICATORS: ReadonlyArray<RegExp> = [
  /\bread[_-]?file\b/i,
  /\bget[_-]?file\b/i,
  /\bfetch[_-]?(?:file|url|page)\b/i,
  /\bquery[_-]?(?:db|database)\b/i,
  /\bSELECT\b.*\bFROM\b/i,
  /\bread[_-]?memory\b/i,
  /\bget[_-]?memory\b/i,
  /\bvector[_-]?search\b/i,
  /\brag[_-]?(?:query|search|lookup)\b/i,
];

/** Patterns in current message that indicate an outbound send is occurring. */
const DEFAULT_SEND_INDICATORS: ReadonlyArray<RegExp> = [
  /\bsend[_-]?(?:email|mail|message|sms)\b/i,
  /\bnotify\b/i,
  /\bwebhook\b/i,
  /\bslack[_-]?(?:send|post|message)\b/i,
  /\bteams[_-]?(?:send|post|message)\b/i,
  /\bpost[_-]?(?:to|message)\b/i,
  /\bsmtp\b/i,
  /\boutbound[_-]?message\b/i,
];

function evaluateMessageSequenceGate(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'sequence-blocked';
  const windowSeconds = (cfg.windowSeconds as number) || 120;
  const extraReadPatterns = (cfg.readPatterns as string[]) || [];
  const extraSendPatterns = (cfg.sendPatterns as string[]) || [];

  // Build final send patterns to check against current message
  const allSendPatterns: RegExp[] = [
    ...DEFAULT_SEND_INDICATORS,
    ...compilePatterns(extraSendPatterns),
  ];

  const currentIsSend = allSendPatterns.some((re) => re.test(ctx.content));
  if (!currentIsSend) return [];

  const recentMessages = ctx.recentMessages || [];
  if (recentMessages.length === 0) return [];

  const windowMs = windowSeconds * 1000;
  const now = Date.now();

  const allReadPatterns: RegExp[] = [
    ...DEFAULT_READ_INDICATORS,
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
          'Message sequence gate: outbound send detected after recent data read — possible indirect injection exfiltration',
      },
    ];
  }

  return [];
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class PolicyCommsEngine implements PolicyEngine {
  readonly name = 'policy-comms-engine';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    switch (ctx.binding.policyType) {
      case 'recipient-allowlist':
        return evaluateEmailRecipientAllowlist(ctx);
      case 'output-risk-scan':
        return evaluateEmailBodyInjection(ctx);
      case 'sequence-gate':
        return evaluateMessageSequenceGate(ctx);
      default:
        return [];
    }
  }
}
