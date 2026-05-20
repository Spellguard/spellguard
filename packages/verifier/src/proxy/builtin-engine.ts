// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in policy engine implementation.
 *
 * Handles all pattern-matching policy types:
 * - Original builtin slugs: PII, max-length, blocked-patterns, rate-limit, internal-only
 * - keyword: exact keyword matching with optional word-boundary matching
 * - contains: simple substring matching
 * - code: fenced code block and language pattern detection
 * - toxicity: toxic/harmful content detection via keyword patterns
 * - secrets: secret/credential detection (API keys, tokens, passwords, etc.)
 * - nsfw-blocker: NSFW content detection (sexual, violent, explicit content)
 * - topic-boundary: keeps agents focused on allowed topics/domains
 * - financial-disclaimer: detects financial advice without disclaimers
 * - phi-guardian: HIPAA PHI detection (MRN, ICD-10, CPT, medical keywords)
 * - action-allowlist: restricts agent tool calls to allowed actions
 * - privilege-escalation: prevents privilege escalation and impersonation attempts
 * - citation-enforcer: requires source citations for factual claims
 * - self-harm-prevention: detects crisis content and provides resources
 *
 * NOTE: Prompt injection detection has been moved to the dedicated
 * InjectionEngine for more comprehensive detection. Use policyType: 'injection'
 * instead of builtin 'prompt-injection' for new policies.
 */

import { DEFAULT_PII_PATTERNS } from './policy';
import type {
  DetectionSpan,
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';
import type { RateLimitConfig, RateLimiter } from './rate-limiter';
import {
  DEFAULT_TOXICITY_SEMANTIC_TIMEOUT_MS,
  TOXICITY_SEMANTIC_TIMEOUT_ENV,
  noteToxicitySemanticEndpointHealthy,
  noteToxicitySemanticEndpointUnhealthy,
  resolveToxicitySemanticEndpoint,
} from './toxicity-semantic-endpoint';

/* ------------------------------------------------------------------ */
/*  Safe regex helper & cache                                         */
/* ------------------------------------------------------------------ */

const MAX_PATTERN_LENGTH = 256;
/** Detect obviously catastrophic patterns like (a+)+, (a*)*,  (\d+)+ */
const CATASTROPHIC_RE = /\([^)]*[+*][^)]*\)[+*]/;

const regexCache = new Map<string, RegExp | null>();

/**
 * Compile a user-provided regex pattern safely.
 * Rejects patterns that are too long or contain nested quantifiers.
 * Returns cached RegExp or null if the pattern is unsafe / invalid.
 */
export function safeRegex(pattern: string, flags = 'i'): RegExp | null {
  const key = `${pattern}\0${flags}`;
  if (regexCache.has(key)) return regexCache.get(key) ?? null;

  if (pattern.length > MAX_PATTERN_LENGTH || CATASTROPHIC_RE.test(pattern)) {
    regexCache.set(key, null);
    return null;
  }

  try {
    const re = new RegExp(pattern, flags);
    regexCache.set(key, re);
    return re;
  } catch {
    regexCache.set(key, null);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Financial disclaimer — pre-compiled term regexes                  */
/* ------------------------------------------------------------------ */

let _financialTermRegexes: RegExp[] | undefined;
let _actionVerbRegexes: RegExp[] | undefined;

function getFinancialTermRegexes(terms: string[]): RegExp[] {
  if (!_financialTermRegexes) {
    _financialTermRegexes = terms.map(
      (term) => new RegExp(`\\b${escapeRegex(term)}\\b`),
    );
  }
  return _financialTermRegexes;
}

function getActionVerbRegexes(verbs: string[]): RegExp[] {
  if (!_actionVerbRegexes) {
    _actionVerbRegexes = verbs.map(
      (verb) => new RegExp(`\\b${escapeRegex(verb)}\\b`),
    );
  }
  return _actionVerbRegexes;
}

/* ------------------------------------------------------------------ */
/*  Code-detection constants                                          */
/* ------------------------------------------------------------------ */

const FENCED_BLOCK_PATTERN = /```(\w+)?[\s\S]*?```/g;

const CODE_PATTERNS: Record<string, RegExp[]> = {
  sql: [
    /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\s+.{0,50}\b(FROM|INTO|TABLE|SET|DATABASE)\b/i,
    /\bWHERE\s+\w+\s*[=<>!]/i,
    /\bJOIN\s+\w+\s+ON\b/i,
    /;\s*--/i,
    /\bUNION\s+(ALL\s+)?SELECT\b/i,
  ],
  shell: [
    /^\s*[$#]\s+\S+/m,
    /\b(sudo|chmod|chown|chgrp)\s+/i,
    /\brm\s+(-[rf]+\s+|.*\s+-[rf]+)/i,
    /\b(curl|wget)\s+.*(http|ftp)/i,
    /^#!\s*\/bin\/(bash|sh|zsh)/m,
    /\|\s*(bash|sh|zsh)\b/i,
    /\beval\s*\(/i,
  ],
  javascript: [
    /\b(function|const|let|var)\s+\w+\s*[=(]/,
    /=>\s*[{(]/,
    /\b(require|import)\s*\(/,
    /\bdocument\.(getElementById|querySelector|write)/,
    /\bwindow\.(location|open|eval)/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
  ],
  python: [
    /^def\s+\w+\s*\(/m,
    /^class\s+\w+.*:/m,
    /^import\s+\w+/m,
    /^from\s+\w+\s+import/m,
    /\bexec\s*\(/,
    /\beval\s*\(/,
    /__import__\s*\(/,
  ],
  html: [
    /<script[\s>]/i,
    /<iframe[\s>]/i,
    /on\w+\s*=\s*["'][^"']*["']/i,
    /<\/?(div|span|body|head|html|form|input|button)[\s>]/i,
    /javascript:/i,
  ],
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'javascript',
  typescript: 'javascript',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  py: 'python',
  htm: 'html',
  mysql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
};

function normalizeLanguage(lang: string): string {
  const lower = lang.toLowerCase();
  return LANGUAGE_ALIASES[lower] || lower;
}

/* ------------------------------------------------------------------ */
/*  Toxicity constants                                                */
/* ------------------------------------------------------------------ */

const THREAT_PATTERNS: RegExp[] = [
  /\b(kill|murder|assassinate|execute)\s+(you|him|her|them|everyone)\b/i,
  /\bi('ll|'m\s+going\s+to|will)\s+(kill|hurt|destroy|end)\s+(you|them)\b/i,
  /\b(death|die|dead)\s+(threat|wish)/i,
  /\byou('re|\s+are)\s+(dead|going\s+to\s+die)\b/i,
  /\bwatch\s+your\s+back\b/i,
  /\bi\s+know\s+where\s+you\s+(live|work)\b/i,
];

const HARASSMENT_PATTERNS: RegExp[] = [
  /\b(stupid|idiot|moron|dumb|retard)\b/i,
  /\b(loser|pathetic|worthless|useless)\s+(person|human|being)?\b/i,
  /\bshut\s+(up|the\s+f)/i,
  /\bnobody\s+(likes|cares|wants)\s+(you|about\s+you)\b/i,
  /\bgo\s+(away|die|delete\s+yourself|kill\s+yourself)\b/i,
  /\bkill\s+yourself\b/i,
  /\bkys\b/i,
];

const HATE_PATTERNS: RegExp[] = [
  /\bi\s+hate\s+(?:(?:all|every)\s+\w+|everyone|everything)/i,
  /\b(subhuman|inferior|vermin)\b/i,
  /\bshould\s+(all\s+)?(be\s+)?(exterminated|eliminated|removed)\b/i,
  /\bdon'?t\s+deserve\s+to\s+(live|exist)\b/i,
];

const PROFANITY_PATTERNS: RegExp[] = [
  /\bf+u+c+k+/i,
  /\bs+h+i+t+\b/i,
  /\ba+s+s+h+o+l+e/i,
  /\bb+i+t+c+h/i,
  /\bd+a+m+n+\b/i,
  /\bwtf\b/i,
  /\bstfu\b/i,
];

const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  threat: THREAT_PATTERNS,
  harassment: HARASSMENT_PATTERNS,
  hate: HATE_PATTERNS,
  profanity: PROFANITY_PATTERNS,
};

const ALL_CATEGORIES = Object.keys(CATEGORY_PATTERNS);

/* ------------------------------------------------------------------ */
/*  Secrets detection constants                                       */
/* ------------------------------------------------------------------ */

const SECRET_PATTERNS: Record<string, { pattern: RegExp; confidence: number }> =
  {
    aws: {
      pattern: /\b(AKIA[0-9A-Z]{16})\b/,
      confidence: 0.95,
    },
    github: {
      pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/,
      confidence: 0.95,
    },
    openai: {
      pattern: /\bsk-[A-Za-z0-9]{48,}\b/,
      confidence: 0.95,
    },
    anthropic: {
      pattern: /\bsk-ant-[A-Za-z0-9-]{32,}\b/,
      confidence: 0.95,
    },
    stripe: {
      pattern: /\b(sk_live_|rk_live_)[A-Za-z0-9]{24,}\b/,
      confidence: 0.95,
    },
    privateKey: {
      pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
      confidence: 0.95,
    },
    jwt: {
      pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
      confidence: 0.95,
    },
    slack: {
      pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
      confidence: 0.95,
    },
    discord: {
      pattern:
        /\b[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
      confidence: 0.95,
    },
    genericApiKey: {
      pattern:
        /\b(api[_-]?key|apikey|secret|token)["\s:=]+["']?[A-Za-z0-9_\-]{20,}["']?/i,
      confidence: 0.8,
    },
    genericSecret: {
      pattern: /\b(password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}["']?/i,
      confidence: 0.8,
    },
  };

const ALL_SECRET_CATEGORIES = Object.keys(SECRET_PATTERNS);

/* ------------------------------------------------------------------ */
/*  Keyword helpers                                                   */
/* ------------------------------------------------------------------ */

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchWholeWordKeyword(
  content: string,
  keyword: string,
  caseSensitive: boolean,
): boolean {
  const pattern = `\\b${escapeRegex(keyword)}\\b`;
  const flags = caseSensitive ? '' : 'i';
  try {
    return new RegExp(pattern, flags).test(content);
  } catch {
    return false;
  }
}

function matchSubstringKeyword(
  content: string,
  keyword: string,
  caseSensitive: boolean,
): boolean {
  const haystack = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  return haystack.includes(needle);
}

function findWholeWordSpans(
  content: string,
  keyword: string,
  caseSensitive: boolean,
): DetectionSpan[] {
  const pattern = `\\b${escapeRegex(keyword)}\\b`;
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    const regex = new RegExp(pattern, flags);
    const spans: DetectionSpan[] = [];
    for (const match of content.matchAll(regex)) {
      const idx = match.index ?? 0;
      spans.push({ start: idx, end: idx + match[0].length });
    }
    return spans;
  } catch {
    return [];
  }
}

function findSubstringSpans(
  content: string,
  keyword: string,
  caseSensitive: boolean,
): DetectionSpan[] {
  const haystack = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  const spans: DetectionSpan[] = [];
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    spans.push({ start: idx, end: idx + needle.length });
    pos = idx + 1;
  }
  return spans;
}

/* ================================================================== */
/*  BuiltinEngine                                                     */
/* ================================================================== */

export class BuiltinEngine implements PolicyEngine {
  readonly name = 'builtin';
  private rateLimiter?: RateLimiter;

  constructor(rateLimiter?: RateLimiter) {
    this.rateLimiter = rateLimiter;
  }

  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDetection[]> {
    // Dispatch on policyType for the folded engines
    const policyType = ctx.binding.policyType;
    if (policyType === 'keyword') return this.checkKeyword(ctx);
    if (policyType === 'contains') return this.checkContains(ctx);
    if (policyType === 'code') return this.checkCode(ctx);
    if (policyType === 'toxicity') return this.checkToxicity(ctx);
    if (policyType === 'secrets') return this.checkSecrets(ctx);
    if (policyType === 'nsfw-blocker') return this.checkNsfwBlocker(ctx);
    if (policyType === 'topic-boundary') return this.checkTopicBoundary(ctx);
    if (policyType === 'financial-disclaimer')
      return this.checkFinancialDisclaimer(ctx);
    if (policyType === 'phi-guardian') return this.checkPhiGuardian(ctx);
    if (policyType === 'action-allowlist')
      return this.checkActionAllowlist(ctx);
    if (policyType === 'privilege-escalation')
      return this.checkPrivilegeEscalation(ctx);
    if (policyType === 'citation-enforcer')
      return this.checkCitationEnforcer(ctx);
    if (policyType === 'self-harm-prevention')
      return this.checkSelfHarmPrevention(ctx);

    // Existing policySlug dispatch for the original builtin type
    switch (ctx.binding.policySlug) {
      case 'pii-detection':
        return this.checkPii(ctx.content);
      case 'prompt-injection':
        // DEPRECATED: Use InjectionEngine (policyType: 'injection') instead
        // Return empty - InjectionEngine should be used for injection detection
        console.warn(
          '[BuiltinEngine] prompt-injection slug is deprecated. Use policyType: "injection" for comprehensive detection.',
        );
        return [];
      case 'max-length':
        return this.checkMaxLength(ctx.content, ctx.binding.config);
      case 'blocked-patterns':
        return this.checkBlockedPatterns(ctx.content, ctx.binding.config);
      case 'rate-limit-standard':
        return this.checkRateLimit(ctx);
      case 'internal-only':
        return this.checkInternalOnly(ctx);
      default:
        return [];
    }
  }

  /* ---- Original builtin checks ----------------------------------- */

  private checkInternalOnly(ctx: PolicyEvalContext): PolicyDetection[] {
    const { senderOrgId, recipientOrgId } = ctx;

    // If org context is missing, we cannot verify org boundary — fail closed
    if (!senderOrgId || !recipientOrgId) {
      return [
        {
          type: 'internal-only',
          confidence: 1.0,
          message:
            'Organization context unavailable — cannot verify internal-only boundary',
        },
      ];
    }

    if (senderOrgId !== recipientOrgId) {
      return [
        {
          type: 'internal-only',
          confidence: 1.0,
          message:
            'Message crosses organization boundary (internal-only policy)',
        },
      ];
    }

    return [];
  }

  private checkPii(content: string): PolicyDetection[] {
    const detections: PolicyDetection[] = [];
    const labels = ['ssn', 'email', 'phone', 'credit-card'];

    for (let i = 0; i < DEFAULT_PII_PATTERNS.length; i++) {
      const pattern = DEFAULT_PII_PATTERNS[i];
      const globalPattern = new RegExp(
        pattern.source,
        `${pattern.flags || ''}g`,
      );
      const spans: DetectionSpan[] = [];
      for (const match of content.matchAll(globalPattern)) {
        const idx = match.index ?? 0;
        spans.push({ start: idx, end: idx + match[0].length });
      }
      if (spans.length > 0) {
        detections.push({
          type: labels[i] || 'pii',
          confidence: 0.9,
          message: `PII pattern detected: ${pattern.source}`,
          spans,
        });
      }
    }

    return detections;
  }

  private checkRateLimit(ctx: PolicyEvalContext): PolicyDetection[] {
    if (!this.rateLimiter) {
      return [];
    }

    const config = ctx.binding.config as RateLimitConfig | undefined;
    if (
      !config ||
      typeof config.count !== 'number' ||
      typeof config.window !== 'string'
    ) {
      return [];
    }

    // CR-020: Bounds-check rate limit config at evaluation time
    const VALID_WINDOWS = ['1m', '5m', '1h', '1d'];
    if (config.count <= 0 || config.count > 100_000) {
      console.warn(
        `[BuiltinEngine] Invalid rate limit count: ${config.count} — skipping`,
      );
      return [];
    }
    if (!VALID_WINDOWS.includes(config.window)) {
      console.warn(
        `[BuiltinEngine] Invalid rate limit window: "${config.window}" — skipping`,
      );
      return [];
    }
    if (
      config.burst !== undefined &&
      (typeof config.burst !== 'number' || config.burst < config.count)
    ) {
      console.warn(
        `[BuiltinEngine] Invalid rate limit burst: ${config.burst} (must be >= count ${config.count}) — skipping`,
      );
      return [];
    }

    const key = {
      agentId: ctx.agentId ?? 'unknown',
      policyId: ctx.binding.policyId,
      direction: ctx.direction ?? 'outbound',
    };

    const result = this.rateLimiter.check(key, config);

    if (!result.allowed) {
      // CR-017 / CR-029: Show meaningful limit info (count per window, not count/count)
      return [
        {
          type: 'rate-limit',
          confidence: 1.0,
          message: `Rate limit exceeded: ${config.count} messages per ${config.window}. Try again in ${result.retryAfter}s`,
          _retryAfter: result.retryAfter,
        } as PolicyDetection & { _retryAfter?: number },
      ];
    }

    return [];
  }

  private checkMaxLength(
    content: string,
    config?: Record<string, unknown>,
  ): PolicyDetection[] {
    const maxLength = (config?.maxLength as number) || 10000;
    if (content.length > maxLength) {
      return [
        {
          type: 'max-length',
          confidence: 1.0,
          message: `Content length ${content.length} exceeds maximum ${maxLength}`,
        },
      ];
    }
    return [];
  }

  private checkBlockedPatterns(
    content: string,
    config?: Record<string, unknown>,
  ): PolicyDetection[] {
    const patterns = (config?.patterns as string[]) || [];
    const detections: PolicyDetection[] = [];

    for (const patternStr of patterns) {
      const regex = safeRegex(patternStr, 'ig');
      if (regex) {
        const spans: DetectionSpan[] = [];
        for (const match of content.matchAll(regex)) {
          const idx = match.index ?? 0;
          spans.push({ start: idx, end: idx + match[0].length });
        }
        if (spans.length > 0) {
          detections.push({
            type: 'blocked-pattern',
            confidence: 1.0,
            message: `Blocked pattern matched: ${patternStr}`,
            spans,
          });
        }
      }
    }

    return detections;
  }

  /* ---- Keyword engine --------------------------------------------- */

  private checkKeyword(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config;
    const keywords = cfg?.keywords;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return [];
    }

    const caseSensitive = cfg?.caseSensitive === true;
    const wholeWord = cfg?.matchWholeWord !== false; // default true
    const label = (cfg?.label as string) || 'keyword-match';

    const detections: PolicyDetection[] = [];

    for (const raw of keywords) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const spans = wholeWord
        ? findWholeWordSpans(ctx.content, raw, caseSensitive)
        : findSubstringSpans(ctx.content, raw, caseSensitive);
      if (spans.length > 0) {
        detections.push({
          type: label,
          confidence: 1.0, // 1.0 = deterministic exact/substring match
          message: `Matched keyword: "${raw}"`,
          spans,
        });
      }
    }

    return detections;
  }

  /* ---- Contains engine -------------------------------------------- */

  private checkContains(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config;
    const phrases = cfg?.phrases;
    if (!Array.isArray(phrases) || phrases.length === 0) {
      return [];
    }

    const caseSensitive = cfg?.caseSensitive === true;
    const matchAll = cfg?.matchAll === true;
    const label = (cfg?.label as string) || 'contains-match';

    const matchedWithSpans: { phrase: string; spans: DetectionSpan[] }[] = [];

    for (const raw of phrases) {
      if (typeof raw !== 'string' || raw.length === 0) continue;
      const spans = findSubstringSpans(ctx.content, raw, caseSensitive);
      if (spans.length > 0) {
        matchedWithSpans.push({ phrase: raw, spans });
      }
    }

    if (
      matchAll &&
      matchedWithSpans.length !==
        phrases.filter((p) => typeof p === 'string' && p.length > 0).length
    ) {
      return [];
    }

    if (matchedWithSpans.length === 0) {
      return [];
    }

    return matchedWithSpans.map(({ phrase, spans }) => ({
      type: label,
      confidence: 1.0,
      message: `Found phrase: "${phrase}"`,
      spans,
    }));
  }

  /* ---- Code engine ------------------------------------------------ */

  private checkCode(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config;
    if (!cfg) return [];

    // ── Custom patterns (independent of blockedLanguages / allowedLanguages) ──
    const detections: PolicyDetection[] = [];
    const customPatterns = (cfg.customPatterns as string[]) || [];
    if (customPatterns.length > 0) {
      for (const patternStr of customPatterns) {
        const regex = safeRegex(patternStr);
        if (regex?.test(ctx.content)) {
          detections.push({
            type: 'code-custom-pattern',
            confidence: 0.85,
            message: `Custom pattern matched: ${patternStr}`,
          });
          break;
        }
      }
    }

    const blockedLanguages = (cfg.blockedLanguages as string[]) || [];
    const allowedLanguages = cfg.allowedLanguages as string[] | undefined;
    const detectFenced = cfg.detectFenced !== false;
    const detectPatterns = cfg.detectPatterns !== false;
    const label = (cfg.label as string) || 'code-detected';

    // If no restrictions, permit (but still return any custom-pattern detections)
    if (blockedLanguages.length === 0 && !allowedLanguages) {
      return detections;
    }

    const detectedLanguages = new Set<string>();

    // Detect fenced code blocks
    if (detectFenced) {
      const matches = ctx.content.matchAll(FENCED_BLOCK_PATTERN);
      for (const match of matches) {
        const lang = match[1];
        if (lang) {
          detectedLanguages.add(normalizeLanguage(lang));
        }
      }
    }

    // Detect language patterns
    if (detectPatterns) {
      for (const [language, patterns] of Object.entries(CODE_PATTERNS)) {
        for (const pattern of patterns) {
          if (pattern.test(ctx.content)) {
            detectedLanguages.add(language);
            break;
          }
        }
      }
    }

    for (const lang of detectedLanguages) {
      const isBlocked = blockedLanguages.some(
        (b) => normalizeLanguage(b) === lang,
      );
      const isAllowed = allowedLanguages
        ? allowedLanguages.some((a) => normalizeLanguage(a) === lang)
        : !isBlocked;

      if (isBlocked || !isAllowed) {
        detections.push({
          type: label,
          confidence: 0.9, // 0.9 = heuristic pattern match (code patterns)
          message: `Detected ${lang} code`,
        });
      }
    }

    return detections;
  }

  /* ---- Toxicity engine -------------------------------------------- */

  private async checkToxicity(
    ctx: PolicyEvalContext,
  ): Promise<PolicyDetection[]> {
    const cfg = ctx.binding.config || {};

    // Distinguish "not configured" (fall back to all categories) from
    // "explicitly set" (even to an empty array = no checks at all).
    const categoriesFromConfig = cfg.categories as string[] | undefined;
    const categories = categoriesFromConfig ?? ALL_CATEGORIES;
    const customPatterns = (cfg.customPatterns as string[]) || [];
    const label = (cfg.label as string) || 'toxic-content';

    // When categories are explicitly restricted, the semantic endpoint cannot
    // respect those restrictions (it returns generic detections), so we skip
    // it entirely and only return what the heuristic finds within the allowed set.
    const categoriesRestricted = categoriesFromConfig !== undefined;

    const detections: PolicyDetection[] = [];
    const matchedCategories = new Set<string>();

    // Check each enabled category
    for (const category of categories) {
      const patterns = CATEGORY_PATTERNS[category];
      if (!patterns) continue;

      for (const pattern of patterns) {
        if (pattern.test(ctx.content)) {
          matchedCategories.add(category);
          break;
        }
      }
    }

    // Check custom patterns (safeRegex rejects catastrophic / oversized patterns)
    for (const patternStr of customPatterns) {
      const regex = safeRegex(patternStr);
      if (regex?.test(ctx.content)) {
        matchedCategories.add('custom');
        break;
      }
    }

    // Create detections for matched categories
    // Confidence rationale:
    //   0.9  = built-in heuristic pattern match (curated patterns)
    //   0.85 = user-provided custom patterns (lower trust)
    for (const category of matchedCategories) {
      detections.push({
        type: label,
        confidence: category === 'custom' ? 0.85 : 0.9,
        message: `Detected ${category} content`,
      });
    }

    // Only invoke the semantic checker when heuristic matching misses so the
    // deterministic path stays cheap and easy to reason about.
    // Skip semantic when categories are explicitly restricted: the endpoint
    // cannot filter by category, so calling it would return detections outside
    // the user's chosen scope.
    if (detections.length > 0 || categoriesRestricted) {
      return detections;
    }

    const semanticDetections = await this.checkToxicitySemantic(ctx);
    return semanticDetections.length > 0 ? semanticDetections : detections;
  }

  private async checkToxicitySemantic(
    ctx: PolicyEvalContext,
  ): Promise<PolicyDetection[]> {
    const cfg = ctx.binding.config || {};
    if (cfg.semanticEnabled === false) {
      return [];
    }

    const endpoint = await resolveToxicitySemanticEndpoint(
      cfg.semanticEndpoint,
    );
    if (!endpoint) {
      return [];
    }

    const timeout =
      typeof cfg.semanticTimeout === 'number'
        ? cfg.semanticTimeout
        : Number.parseInt(
            process.env[TOXICITY_SEMANTIC_TIMEOUT_ENV] ??
              `${DEFAULT_TOXICITY_SEMANTIC_TIMEOUT_MS}`,
            10,
          ) || DEFAULT_TOXICITY_SEMANTIC_TIMEOUT_MS;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: ctx.content,
            policyId: ctx.binding.policyId,
            policySlug: ctx.binding.policySlug,
            config: ctx.binding.config,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        noteToxicitySemanticEndpointUnhealthy(endpoint);
        console.warn(
          `[BuiltinEngine] toxicity semantic endpoint returned HTTP ${response.status}`,
        );
        return [];
      }

      const body = await response.json();
      if (!Array.isArray(body)) {
        noteToxicitySemanticEndpointUnhealthy(endpoint);
        console.warn(
          '[BuiltinEngine] toxicity semantic endpoint returned non-array response',
        );
        return [];
      }

      noteToxicitySemanticEndpointHealthy(endpoint);

      return body
        .filter(
          (
            detection: unknown,
          ): detection is {
            type: string;
            confidence: number;
            message?: string;
          } =>
            typeof detection === 'object' &&
            detection !== null &&
            typeof (detection as Record<string, unknown>).type === 'string' &&
            typeof (detection as Record<string, unknown>).confidence ===
              'number',
        )
        .map((detection) => ({
          type: detection.type,
          confidence: detection.confidence,
          message: detection.message,
        }));
    } catch (err) {
      noteToxicitySemanticEndpointUnhealthy(endpoint);
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${timeout}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      console.warn(
        `[BuiltinEngine] toxicity semantic endpoint failed: ${message}`,
      );
      return [];
    }
  }

  /* ---- Secrets engine --------------------------------------------- */

  private checkSecrets(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};

    const categories = (cfg.categories as string[]) || ALL_SECRET_CATEGORIES;
    const customPatterns = (cfg.customPatterns as string[]) || [];
    const label = (cfg.label as string) || 'secret-detected';

    const detections: PolicyDetection[] = [];
    const matchedCategories = new Set<string>();

    // Check each enabled category
    for (const category of categories) {
      const secretDef = SECRET_PATTERNS[category];
      if (!secretDef) continue;

      const { pattern, confidence } = secretDef;
      const globalPattern = new RegExp(
        pattern.source,
        `${pattern.flags || ''}g`,
      );
      const spans: DetectionSpan[] = [];
      for (const match of ctx.content.matchAll(globalPattern)) {
        const idx = match.index ?? 0;
        spans.push({ start: idx, end: idx + match[0].length });
      }

      if (spans.length > 0) {
        matchedCategories.add(category);
        detections.push({
          type: label,
          confidence,
          message: `Detected ${category} secret`,
          spans,
        });
      }
    }

    // Check custom patterns (safeRegex rejects catastrophic / oversized patterns)
    for (const patternStr of customPatterns) {
      const regex = safeRegex(patternStr, 'gi');
      if (regex) {
        const spans: DetectionSpan[] = [];
        for (const match of ctx.content.matchAll(regex)) {
          const idx = match.index ?? 0;
          spans.push({ start: idx, end: idx + match[0].length });
        }
        if (spans.length > 0) {
          detections.push({
            type: label,
            confidence: 0.8,
            message: 'Detected custom secret pattern',
            spans,
          });
        }
      }
    }

    return detections;
  }

  /* ---- NSFW Blocker engine ---------------------------------------- */

  private checkNsfwBlocker(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    const checkSexual = cfg.checkSexual !== false;
    const checkViolence = cfg.checkViolence !== false;
    const checkNudity = cfg.checkNudity !== false;
    const customPatterns = (cfg.customPatterns as string[]) || [];
    const label = (cfg.label as string) || 'nsfw-content';

    // Medical/educational context exceptions
    const MEDICAL_CONTEXT_TERMS = [
      'breast cancer',
      'prostate exam',
      'gynecology',
      'anatomy',
      'medical',
      'healthcare',
      'treatment',
      'surgery',
      'patient',
      'diagnosis',
      'clinical',
      'therapeutic',
      'textbook',
      'educational',
      'academic',
      'curriculum',
    ];

    // Medical context raises the detection threshold rather than short-circuiting.
    // This prevents trivial bypass by prepending "This is a medical treatment:" to
    // explicit content.
    const contentLower = content.toLowerCase();
    const medicalTermCount = MEDICAL_CONTEXT_TERMS.filter((term) =>
      contentLower.includes(term),
    ).length;
    const hasMedicalContext = medicalTermCount >= 2;

    // Sexual content patterns
    const SEXUAL_PATTERNS = [
      /\bexplicit\s+sexual\b/i,
      /\bsexual\s+content\b/i,
      /\bpornograph/i,
      /\badult\s+content\b/i,
      /\bsexually\s+explicit\b/i,
      /\berotic\b/i,
      /\bintimate\s+act/i,
      /\bsexual\s+intercourse\b/i,
    ];

    // Violence patterns
    const VIOLENCE_PATTERNS = [
      /\bgraphic\s+violence\b/i,
      /\bextreme\s+violence\b/i,
      /\bgore\b/i,
      /\bmutilat/i,
      /\btortur/i,
      /\bbeheading\b/i,
      /\bdismember/i,
      /\bblood\s+and\s+gore\b/i,
      /\bsnuff\b/i,
      /\bsadistic\b/i,
    ];

    // Nudity patterns
    const NUDITY_PATTERNS = [
      /\bnaked\b/i,
      /\bnude\b/i,
      /\bnudity\b/i,
      /\bexposed\s+(?:body|breast|genitals?)\b/i,
      /\bunclothed\b/i,
      /\btopless\b/i,
    ];

    const matchedCategories = new Set<string>();

    // Check sexual content
    if (checkSexual) {
      for (const pattern of SEXUAL_PATTERNS) {
        if (pattern.test(content)) {
          matchedCategories.add('sexual');
          break;
        }
      }
    }

    // Check violence
    if (checkViolence) {
      for (const pattern of VIOLENCE_PATTERNS) {
        if (pattern.test(content)) {
          matchedCategories.add('violence');
          break;
        }
      }
    }

    // Check nudity
    if (checkNudity) {
      for (const pattern of NUDITY_PATTERNS) {
        if (pattern.test(content)) {
          matchedCategories.add('nudity');
          break;
        }
      }
    }

    // Check custom patterns (safeRegex rejects catastrophic / oversized patterns)
    for (const patternStr of customPatterns) {
      const regex = safeRegex(patternStr);
      if (regex?.test(content)) {
        matchedCategories.add('custom');
        break;
      }
    }

    // Medical context raises the threshold: require ≥2 NSFW categories to fire.
    // This prevents bypass via single medical term + explicit content, while still
    // allowing genuinely medical content with a single incidental pattern match.
    if (hasMedicalContext && matchedCategories.size < 2) {
      return detections;
    }

    // Create detections for matched categories
    // Confidence rationale:
    //   0.85 = built-in heuristic pattern match (conservative for NSFW)
    //   0.8  = user-provided custom patterns (lower trust)
    //   -0.15 = medical context discount (still flagged due to multi-category match)
    for (const category of matchedCategories) {
      const base = category === 'custom' ? 0.8 : 0.85;
      detections.push({
        type: label,
        confidence: hasMedicalContext ? base - 0.15 : base,
        message: `Detected NSFW content: ${category}`,
      });
    }

    return detections;
  }

  /* ---- Topic Boundary engine -------------------------------------- */

  private checkTopicBoundary(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    const allowedTopics = (cfg.allowedTopics as string[]) || [];
    const blockedTopics = (cfg.blockedTopics as string[]) || [];
    const mode = (cfg.mode as 'strict' | 'moderate' | 'loose') || 'moderate';
    const offTopicMessage =
      (cfg.offTopicMessage as string) ||
      'This conversation is off-topic for my capabilities.';

    // Topic keyword groups
    const TOPIC_KEYWORDS: Record<string, string[]> = {
      programming: [
        'code',
        'coding',
        'programming',
        'developer',
        'software',
        'bug',
        'debug',
        'function',
        'api',
        'database',
        'git',
        'deploy',
        'repository',
        'commit',
        'branch',
        'merge',
        'pull request',
        'typescript',
        'javascript',
        'python',
        'java',
        'react',
        'node',
        'npm',
        'package',
        'library',
        'framework',
        'algorithm',
        'data structure',
        'variable',
        'loop',
        'array',
        'object',
        'class',
        'method',
      ],
      medical: [
        'health',
        'symptom',
        'doctor',
        'medicine',
        'treatment',
        'diagnosis',
        'pain',
        'disease',
        'prescription',
        'hospital',
        'clinic',
        'patient',
        'physician',
        'nurse',
        'surgery',
        'medication',
        'dosage',
        'therapy',
        'illness',
        'injury',
        'condition',
        'healthcare',
      ],
      legal: [
        'lawyer',
        'lawsuit',
        'legal',
        'court',
        'attorney',
        'sue',
        'liability',
        'contract',
        'law',
        'judge',
        'trial',
        'defendant',
        'plaintiff',
        'litigation',
        'settlement',
        'damages',
        'rights',
        'statute',
        'regulation',
        'compliance',
      ],
      finance: [
        'money',
        'invest',
        'stock',
        'bank',
        'loan',
        'credit',
        'budget',
        'tax',
        'salary',
        'income',
        'expense',
        'savings',
        'retirement',
        'portfolio',
        'dividend',
        'interest',
        'mortgage',
        'debt',
        'payment',
        'transaction',
      ],
      politics: [
        'election',
        'vote',
        'democrat',
        'republican',
        'president',
        'congress',
        'political',
        'government',
        'policy',
        'senator',
        'representative',
        'legislation',
        'campaign',
        'candidate',
        'ballot',
        'liberal',
        'conservative',
        'party',
        'administration',
      ],
      religion: [
        'god',
        'church',
        'bible',
        'pray',
        'faith',
        'religious',
        'spiritual',
        'christian',
        'muslim',
        'jewish',
        'buddhist',
        'hindu',
        'atheist',
        'worship',
        'temple',
        'mosque',
        'synagogue',
        'scripture',
        'doctrine',
        'belief',
      ],
      relationships: [
        'dating',
        'boyfriend',
        'girlfriend',
        'marriage',
        'divorce',
        'breakup',
        'romantic',
        'love',
        'relationship',
        'partner',
        'spouse',
        'wedding',
        'engagement',
        'flirt',
        'attraction',
        'intimacy',
      ],
      education: [
        'learn',
        'study',
        'homework',
        'school',
        'teacher',
        'student',
        'exam',
        'grade',
        'college',
        'university',
        'course',
        'lecture',
        'assignment',
        'textbook',
        'curriculum',
        'education',
        'tutor',
        'lesson',
        'class',
      ],
      entertainment: [
        'movie',
        'film',
        'tv',
        'show',
        'music',
        'song',
        'game',
        'video game',
        'gaming',
        'celebrity',
        'actor',
        'actress',
        'director',
        'series',
        'episode',
        'album',
        'concert',
        'streaming',
      ],
      sports: [
        'football',
        'basketball',
        'baseball',
        'soccer',
        'tennis',
        'golf',
        'hockey',
        'game',
        'match',
        'team',
        'player',
        'score',
        'win',
        'lose',
        'championship',
        'league',
        'tournament',
        'coach',
      ],
    };

    // Allow custom topic keywords from config
    const customTopics = cfg.customTopics as
      | Record<string, string[]>
      | undefined;
    const allTopics = customTopics
      ? { ...TOPIC_KEYWORDS, ...customTopics }
      : TOPIC_KEYWORDS;

    // Detect topics by scoring keyword matches
    const contentLower = content.toLowerCase();
    const topicScores: Record<string, number> = {};

    for (const [topic, keywords] of Object.entries(allTopics)) {
      let score = 0;
      for (const keyword of keywords) {
        // Count occurrences (simple frequency-based scoring)
        const keywordLower = keyword.toLowerCase();
        const regex = new RegExp(`\\b${escapeRegex(keywordLower)}\\b`, 'gi');
        const matches = contentLower.match(regex);
        if (matches) {
          score += matches.length;
        }
      }
      if (score > 0) {
        topicScores[topic] = score;
      }
    }

    // Find primary topic (highest score above threshold)
    const SCORE_THRESHOLD = 2; // Need at least 2 keyword matches
    let primaryTopic: string | null = null;
    let maxScore = SCORE_THRESHOLD;

    for (const [topic, score] of Object.entries(topicScores)) {
      if (score >= maxScore) {
        maxScore = score;
        primaryTopic = topic;
      }
    }

    // No clear topic detected
    if (!primaryTopic) {
      return detections; // Allow if no topic is detected
    }

    // Apply mode-specific logic
    if (mode === 'strict') {
      // In strict mode, must match allowed topics
      if (allowedTopics.length > 0 && !allowedTopics.includes(primaryTopic)) {
        detections.push({
          type: 'off-topic',
          confidence: 0.85,
          message: offTopicMessage,
        });
      }
    } else if (mode === 'moderate') {
      // In moderate mode, block only if matches blocked topics
      if (blockedTopics.length > 0 && blockedTopics.includes(primaryTopic)) {
        detections.push({
          type: 'off-topic',
          confidence: 0.85,
          message: offTopicMessage,
        });
      }
    } else if (mode === 'loose') {
      // In loose mode, flag but permit
      if (blockedTopics.length > 0 && blockedTopics.includes(primaryTopic)) {
        detections.push({
          type: 'off-topic-warning',
          confidence: 0.7,
          message: `Warning: Detected ${primaryTopic} topic. ${offTopicMessage}`,
        });
      }
    }

    return detections;
  }

  /* ---- Financial Disclaimer engine -------------------------------- */

  private checkFinancialDisclaimer(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    // Disclaimer patterns (shared between built-in and custom-pattern paths)
    const DISCLAIMER_PATTERNS = [
      /not\s+financial\s+advice/i,
      /not\s+a\s+financial\s+advisor/i,
      /consult\s+a?\s*financial\s+professional/i,
      /for\s+informational\s+purposes\s+only/i,
      /do\s+your\s+own\s+research/i,
      /dyor/i,
      /not\s+a\s+recommendation/i,
      /this\s+is\s+not\s+investment\s+advice/i,
    ];

    // ── Custom patterns path (runs BEFORE early-return logic) ──────────
    // Check disclaimer once, then scan patterns only if no disclaimer found.
    // This allows both custom-pattern and built-in detections to coexist.
    const customPatterns = (cfg.customPatterns as string[]) || [];
    if (customPatterns.length > 0) {
      const customDisclaimer = cfg.requiredDisclaimer as string | undefined;
      let hasDisclaimer = false;
      if (customDisclaimer) {
        hasDisclaimer = content
          .toLowerCase()
          .includes(customDisclaimer.toLowerCase());
      } else {
        hasDisclaimer = DISCLAIMER_PATTERNS.some((pattern) =>
          pattern.test(content),
        );
      }

      if (!hasDisclaimer) {
        for (const patternStr of customPatterns) {
          const regex = safeRegex(patternStr);
          if (regex?.test(content)) {
            detections.push({
              type: 'financial-custom-pattern',
              confidence: 0.85,
              message: `Custom financial pattern matched: ${patternStr}`,
            });
            break;
          }
        }
      }
    }

    // Financial terms that trigger checks
    const FINANCIAL_TERMS = [
      'invest',
      'investment',
      'stock',
      'stocks',
      'bond',
      'bonds',
      'etf',
      'etfs',
      'portfolio',
      'dividend',
      'dividends',
      'roi',
      'return',
      'returns',
      'trade',
      'trading',
      'buy',
      'sell',
      'long',
      'short',
      'call',
      'put',
      'option',
      'options',
      'futures',
      'forex',
      'crypto',
      'cryptocurrency',
      '401k',
      'ira',
      'roth',
      'mutual fund',
      'index fund',
      'hedge fund',
      'bitcoin',
      'ethereum',
      'btc',
      'eth',
      'profit',
      'profits',
      'gain',
      'gains',
      'loss',
      'losses',
      'risk',
      'risks',
      'growth',
      'appreciation',
      'yield',
      'performance',
      'bull market',
      'bear market',
      'rally',
      'correction',
      'crash',
      'volatility',
      'liquidity',
      'diversification',
      'asset allocation',
    ];

    // Action verbs that turn financial content into advice
    const ACTION_VERBS = [
      'should',
      'recommend',
      'suggest',
      'advise',
      'consider',
      'must',
      'need to',
      'have to',
      'ought to',
      'will',
      'would',
      'could',
      'might want to',
    ];

    // Question patterns (asking, not advising)
    const QUESTION_PATTERNS = [
      /\bshould\s+i\b/i,
      /\bwhat\s+(should|stocks?|investments?)\b/i,
      /\bhow\s+(do|should|can)\b/i,
      /\w\s*\?\s*$/m,
    ];

    // Past tense indicators
    const PAST_TENSE_INDICATORS = [
      /\bi\s+(invested|bought|sold|traded)\b/i,
      /\bi've\s+(invested|bought|sold|traded)\b/i,
      /\bi\s+have\s+(invested|bought|sold|traded)\b/i,
    ];

    // Check if question
    if (QUESTION_PATTERNS.some((p) => p.test(content))) {
      return detections;
    }

    // Check if past tense
    if (PAST_TENSE_INDICATORS.some((p) => p.test(content))) {
      return detections;
    }

    // Check for financial terms (pre-compiled word-boundary regexes)
    const contentLower = content.toLowerCase();
    const termRegexes = getFinancialTermRegexes(FINANCIAL_TERMS);
    const termIdx = termRegexes.findIndex((re) => re.test(contentLower));
    const financialTerm = termIdx >= 0 ? FINANCIAL_TERMS[termIdx] : undefined;
    if (!financialTerm) {
      return detections;
    }

    // Check for action verbs (pre-compiled word-boundary regexes)
    const verbRegexes = getActionVerbRegexes(ACTION_VERBS);
    const verbIdx = verbRegexes.findIndex((re) => re.test(contentLower));
    const actionVerb = verbIdx >= 0 ? ACTION_VERBS[verbIdx] : undefined;
    if (!actionVerb) {
      return detections;
    }

    // Check for disclaimer
    const customDisclaimer = cfg.requiredDisclaimer as string | undefined;
    let hasDisclaimer = false;

    if (customDisclaimer) {
      hasDisclaimer = contentLower.includes(customDisclaimer.toLowerCase());
    } else {
      hasDisclaimer = DISCLAIMER_PATTERNS.some((pattern) =>
        pattern.test(content),
      );
    }

    if (!hasDisclaimer) {
      detections.push({
        type: 'financial-advice-no-disclaimer',
        confidence: 0.9,
        message: customDisclaimer
          ? `Financial advice detected without required disclaimer: "${customDisclaimer}"`
          : 'Financial advice detected without disclaimer (e.g., "This is not financial advice")',
      });
    }

    return detections;
  }

  /* ---- PHI Guardian engine ---------------------------------------- */

  private checkPhiGuardian(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    // ── Custom patterns (independent of checkStructured / checkKeywords) ──
    const customPatterns = (cfg.customPatterns as string[]) || [];
    if (customPatterns.length > 0) {
      for (const patternStr of customPatterns) {
        const regex = safeRegex(patternStr);
        if (regex?.test(content)) {
          detections.push({
            type: 'phi-custom-pattern',
            confidence: 0.85,
            message: `Custom pattern matched: ${patternStr}`,
          });
          break;
        }
      }
    }

    const minConfidence = (cfg.minConfidence as number) ?? 0.7;

    // Structured identifier patterns — `g` flag is required by `matchAll()`.
    // These are re-created per call (inside the method), so stateful
    // lastIndex is not a concern — each invocation gets fresh regex objects.
    const PATTERNS = {
      mrn: /\b(?:MRN|Medical Record Number)[\s:#]*(\d{6,10})\b/gi,
      icd10: /\b[A-Z]\d{2}\.?\d{0,4}\b/g,
      cpt: /\b\d{5}\b/g,
      npi: /\b(?:NPI[\s:#]*)?(\d{10})\b/gi,
      date: /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g,
      identifier: /\b\d{6,10}\b/g,
      dosage: /\b\d+\s*(?:mg|g|ml|cc|units?|tablets?|capsules?)\b/gi,
    };

    // Medical keywords
    const MEDICAL_KEYWORDS = [
      'diagnosis',
      'diagnosed',
      'prescription',
      'prescribed',
      'treatment',
      'therapy',
      'medication',
      'medicine',
      'dosage',
      'symptoms',
      'condition',
      'patient',
      'medical record',
      'health record',
      'chart',
      'admission',
      'discharge',
      'surgery',
      'operation',
      'procedure',
      'lab results',
      'test results',
      'blood test',
      'biopsy',
      'screening',
      'exam',
      'examination',
      'mri',
      'ct scan',
      'x-ray',
      'xray',
      'ultrasound',
      'mammogram',
      'pet scan',
      'blood pressure',
      'heart rate',
      'temperature',
      'pulse',
      'weight',
      'emergency room',
      'intensive care',
      'icu',
      'radiology',
      'cardiology',
      'oncology',
      'neurology',
      'pediatrics',
      'atorvastatin',
      'lipitor',
      'lisinopril',
      'metformin',
      'amlodipine',
      'metoprolol',
      'omeprazole',
      'simvastatin',
      'losartan',
      'albuterol',
      'gabapentin',
      'hydrochlorothiazide',
      'levothyroxine',
      'synthroid',
      'insulin',
      'warfarin',
      'coumadin',
      'prednisone',
      'amoxicillin',
    ];

    interface PHIDetection {
      type: string;
      confidence: number;
    }

    const phiDetections: PHIDetection[] = [];
    const contentLower = content.toLowerCase();

    // Layer 1: Structured identifiers
    if (cfg.checkStructured !== false) {
      // MRN
      const mrnMatches = content.matchAll(PATTERNS.mrn);
      for (const _match of mrnMatches) {
        phiDetections.push({ type: 'mrn', confidence: 0.95 });
      }

      // ICD-10 (with medical context)
      const hasIcdContext = ['icd', 'diagnosis', 'code'].some((term) =>
        contentLower.includes(term),
      );
      if (hasIcdContext) {
        const icd10Matches = content.matchAll(PATTERNS.icd10);
        for (const _match of icd10Matches) {
          phiDetections.push({ type: 'icd10', confidence: 0.85 });
        }
      }

      // CPT (with procedure context)
      const hasCptContext = ['cpt', 'procedure', 'billing'].some((term) =>
        contentLower.includes(term),
      );
      if (hasCptContext) {
        const cptMatches = content.matchAll(PATTERNS.cpt);
        for (const _match of cptMatches) {
          phiDetections.push({ type: 'cpt', confidence: 0.8 });
        }
      }

      // NPI
      const npiMatches = content.matchAll(PATTERNS.npi);
      for (const _match of npiMatches) {
        phiDetections.push({ type: 'npi', confidence: 0.9 });
      }
    }

    // Layer 2: Medical keywords + identifiers
    if (cfg.checkKeywords !== false) {
      const medicalKeyword = MEDICAL_KEYWORDS.find((keyword) =>
        contentLower.includes(keyword),
      );

      if (medicalKeyword) {
        // Dates
        const dateMatches = content.matchAll(PATTERNS.date);
        for (const _match of dateMatches) {
          phiDetections.push({ type: 'medical-date', confidence: 0.75 });
        }

        // Identifiers
        const identifierMatches = content.matchAll(PATTERNS.identifier);
        for (const _match of identifierMatches) {
          phiDetections.push({ type: 'medical-identifier', confidence: 0.7 });
        }

        // Dosages
        const dosageMatches = content.matchAll(PATTERNS.dosage);
        for (const _match of dosageMatches) {
          phiDetections.push({ type: 'prescription-dosage', confidence: 0.8 });
        }
      }
    }

    // Convert to detections if above threshold
    for (const phi of phiDetections) {
      if (phi.confidence >= minConfidence) {
        detections.push({
          type: `phi-${phi.type}`,
          confidence: phi.confidence,
          message: `Protected Health Information detected: ${phi.type}`,
        });
      }
    }

    return detections;
  }

  /* ---- Action Allowlist engine ------------------------------------ */

  private checkActionAllowlist(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    const allowedActions = (cfg.allowedActions as string[]) || [];
    const actionConstraints =
      (cfg.actionConstraints as Record<string, Record<string, unknown>>) || {};
    const strictMode = cfg.strictMode !== false;

    // If no actions are specified, allow everything
    if (allowedActions.length === 0) {
      return detections;
    }

    // Parse for tool calls in multiple formats
    const toolCalls: {
      action: string;
      parameters?: Record<string, unknown>;
    }[] = [];

    // OpenAI format: "tool_calls": [{"function": {"name": "...", "arguments": "..."}}]
    const openaiMatch = content.match(/"tool_calls"\s*:\s*\[([\s\S]*?)\]/);
    if (openaiMatch) {
      try {
        const calls = JSON.parse(`[${openaiMatch[1]}]`);
        for (const call of calls) {
          if (call?.function?.name) {
            toolCalls.push({
              action: call.function.name,
              parameters: call.function.arguments
                ? JSON.parse(call.function.arguments)
                : undefined,
            });
          }
        }
      } catch {
        // Invalid JSON, skip
      }
    }

    // Anthropic format: "tools": [{"name": "...", "input": {...}}]
    const anthropicMatch = content.match(/"tools"\s*:\s*\[([\s\S]*?)\]/);
    if (anthropicMatch) {
      try {
        const calls = JSON.parse(`[${anthropicMatch[1]}]`);
        for (const call of calls) {
          if (call?.name) {
            toolCalls.push({
              action: call.name,
              parameters: call.input,
            });
          }
        }
      } catch {
        // Invalid JSON, skip
      }
    }

    // Generic function call format: function_name(...) or {"action": "...", "params": {...}}
    const functionCallMatch = content.match(/\b(\w+)\s*\(/g);
    if (functionCallMatch && strictMode) {
      for (const match of functionCallMatch) {
        const actionName = match.replace(/\s*\($/, '');
        if (
          actionName &&
          !['if', 'for', 'while', 'function', 'const', 'let', 'var'].includes(
            actionName,
          )
        ) {
          toolCalls.push({ action: actionName });
        }
      }
    }

    // Check JSON objects with "action" or "function" keys
    try {
      const jsonMatch = content.match(
        /\{[\s\S]*?"(?:action|function)"\s*:\s*"([^"]+)"[\s\S]*?\}/g,
      );
      if (jsonMatch) {
        for (const obj of jsonMatch) {
          const parsed = JSON.parse(obj);
          if (parsed.action || parsed.function) {
            toolCalls.push({
              action: parsed.action || parsed.function,
              parameters: parsed.params || parsed.parameters || parsed.input,
            });
          }
        }
      }
    } catch {
      // Invalid JSON, skip
    }

    // Check each tool call against allowed actions
    for (const toolCall of toolCalls) {
      const isAllowed = allowedActions.includes(toolCall.action);

      if (!isAllowed) {
        detections.push({
          type: 'disallowed-action',
          confidence: 1.0,
          message: `Action "${toolCall.action}" is not in the allowlist`,
        });
        continue;
      }

      // Check parameter constraints if specified
      const constraints = actionConstraints[toolCall.action];
      if (constraints && toolCall.parameters) {
        for (const [param, constraint] of Object.entries(constraints)) {
          const value = toolCall.parameters[param];

          // Check required parameters
          if (constraint === 'required' && value === undefined) {
            detections.push({
              type: 'missing-required-parameter',
              confidence: 1.0,
              message: `Action "${toolCall.action}" missing required parameter "${param}"`,
            });
          }

          // Check forbidden parameters
          if (constraint === 'forbidden' && value !== undefined) {
            detections.push({
              type: 'forbidden-parameter',
              confidence: 1.0,
              message: `Action "${toolCall.action}" contains forbidden parameter "${param}"`,
            });
          }

          // Check type constraints
          if (typeof constraint === 'object' && constraint !== null) {
            const typeConstraint = (constraint as Record<string, unknown>)
              .type as string | undefined;
            if (typeConstraint && value !== undefined) {
              const actualType = typeof value;
              if (actualType !== typeConstraint) {
                detections.push({
                  type: 'parameter-type-mismatch',
                  confidence: 0.9,
                  message: `Action "${toolCall.action}" parameter "${param}" expected type "${typeConstraint}", got "${actualType}"`,
                });
              }
            }
          }
        }
      }
    }

    return detections;
  }

  /* ---- Privilege Escalation Guard engine -------------------------- */

  private checkPrivilegeEscalation(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    const checkSudo = cfg.checkSudo !== false;
    const checkImpersonation = cfg.checkImpersonation !== false;
    const checkJailbreak = cfg.checkJailbreak !== false;
    const customEscalationPatterns =
      (cfg.customEscalationPatterns as string[]) || [];

    // Privilege escalation patterns
    const SUDO_PATTERNS = [
      /\bsudo\s+/i,
      /\bsu\s+-/i,
      /\brun\s+(?:\w+\s+)*as\s+admin/i,
      /\belevate\s+privilege/i,
      /\badmin\s+access\b/i,
      /\broot\s+access\b/i,
      /\belevated\s+permission/i,
      /\bgrant\s+\w+\s+admin/i,
      /\badd\s+\w+\s+to\s+sudoers/i,
      /\bchmod\s+[u+]?[r+]?[w+]?[x+]?777/i,
    ];

    // Impersonation patterns
    const IMPERSONATION_PATTERNS = [
      /\bimpersonate\s+\w+/i,
      /\bact\s+as\s+(?:an?\s+)?(?:admin|owner|root|system|superuser)/i,
      /\bpretend\s+to\s+be\s+(?:an?\s+)?(?:the\s+)?(?:admin|owner|root)/i,
      /\bassume\s+(?:the\s+)?role\s+of\s+\w+/i,
      /\bspoof\s+(?:user|identity|credentials)/i,
      /\bbypass\s+(?:auth|authentication|authorization)/i,
      /\bforge\s+(?:token|session|credential)/i,
      /\byou\s+are\s+now\s+(?:an?\s+)?(?:admin|root|superuser)/i,
      /\bignore\s+previous\s+(?:role|permission|restriction)/i,
    ];

    // Jailbreak patterns
    const JAILBREAK_PATTERNS = [
      /\bignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|rules?|policies|constraints?)/i,
      /\bdisregard\s+(?:all\s+)?(?:previous|safety|security)\s+(?:instructions?|rules?|guidelines?)/i,
      /\bforget\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|rules?|constraints?)/i,
      /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|debug|unrestricted)\s+mode/i,
      /\bDAN\s+mode/i,
      /\bdo\s+anything\s+now/i,
      /\bact\s+as\s+(?:if\s+)?(?:you\s+)?(?:have\s+)?no\s+(?:restriction|limit|constraint)/i,
      /\boverride\s+(?:all\s+)?(?:safety|security|policy)\s+(?:check|constraint|rule)/i,
      /\bsystem\s+prompt\s*:\s*ignore/i,
      /\bpretend\s+(?:the\s+)?(?:previous|safety)\s+(?:instruction|rule)\s+(?:doesn't|does\s+not)\s+exist/i,
    ];

    // Check sudo/privilege escalation
    if (checkSudo) {
      for (const pattern of SUDO_PATTERNS) {
        if (pattern.test(content)) {
          detections.push({
            type: 'privilege-escalation',
            confidence: 0.95,
            message: `Detected privilege escalation attempt: ${pattern.source}`,
          });
          break;
        }
      }
    }

    // Check impersonation
    if (checkImpersonation) {
      for (const pattern of IMPERSONATION_PATTERNS) {
        if (pattern.test(content)) {
          detections.push({
            type: 'impersonation-attempt',
            confidence: 0.9,
            message: `Detected impersonation attempt: ${pattern.source}`,
          });
          break;
        }
      }
    }

    // Check jailbreak
    if (checkJailbreak) {
      for (const pattern of JAILBREAK_PATTERNS) {
        if (pattern.test(content)) {
          detections.push({
            type: 'jailbreak-attempt',
            confidence: 0.9,
            message: `Detected jailbreak attempt: ${pattern.source}`,
          });
          break;
        }
      }
    }

    // Check custom patterns
    for (const patternStr of customEscalationPatterns) {
      const regex = safeRegex(patternStr);
      if (regex?.test(content)) {
        detections.push({
          type: 'custom-escalation',
          confidence: 0.85,
          message: `Detected custom escalation pattern: ${patternStr}`,
        });
      }
    }

    return detections;
  }

  /* ---- Source Citation Enforcer engine ---------------------------- */

  private checkCitationEnforcer(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    // Citation patterns (declared early for reuse in custom patterns path)
    const CITATION_PATTERNS = [
      /\[\d+\]/g, // [1], [2], etc.
      /\(\w+\s+et\s+al\.?,?\s+\d{4}\)/gi, // (Smith et al., 2020)
      /\(\w+,?\s+\d{4}\)/g, // (Smith, 2020)
      /\bsource:\s*/i,
      /\breference:\s*/i,
      /\bcitation:\s*/i,
      /https?:\/\/[^\s]+/g, // URLs
      /\[.*?\]\(https?:\/\/[^\)]+\)/g, // Markdown links [text](url)
      /<https?:\/\/[^>]+>/g, // <url>
      /\b[Aa]ccording to\s+(?:the\s+)?(?:[A-Z]\w+|most\s+\w+)/g, // Named-source attribution
      /\b[Pp]er\s+(?:the\s+)?[A-Z]\w+/g, // "Per the [Org]" attribution
      /\b[Aa]s\s+(?:noted|reported|stated)\s+by\s+(?:the\s+)?[A-Z]\w+/g, // "As noted by [Source]"
    ];

    // ── Custom patterns (additional claim detectors, independent of built-in) ──
    const customPatterns = (cfg.customPatterns as string[]) || [];
    if (customPatterns.length > 0) {
      for (const patternStr of customPatterns) {
        const regex = safeRegex(patternStr);
        if (regex?.test(content)) {
          // Custom pattern matched a claim — check if citations are present
          let citationCount = 0;
          for (const cp of CITATION_PATTERNS) {
            const matches = content.match(new RegExp(cp.source, cp.flags));
            if (matches) {
              citationCount += matches.length;
            }
          }
          const minCit = (cfg.minCitations as number) ?? 1;
          if (citationCount < minCit) {
            detections.push({
              type: 'citation-custom-pattern',
              confidence: 0.85,
              message: `Custom pattern matched: ${patternStr}`,
            });
          }
          break;
        }
      }
    }

    const requireUrls = cfg.requireUrls === true;
    const minCitations = (cfg.minCitations as number) ?? 1;
    const claimIndicators = (cfg.claimIndicators as string[]) || [
      'according to',
      'research shows',
      'studies show',
      'data shows',
      'statistics show',
      'evidence suggests',
      'experts say',
      'scientists found',
      'report shows',
      'survey found',
    ];

    // Factual claim indicators
    const FACTUAL_CLAIM_PATTERNS = claimIndicators.map(
      (indicator) => new RegExp(`\\b${escapeRegex(indicator)}\\b`, 'i'),
    );

    // Check if content contains factual claims
    const hasFactualClaim = FACTUAL_CLAIM_PATTERNS.some((pattern) =>
      pattern.test(content),
    );
    if (!hasFactualClaim) {
      return detections; // No factual claims, no citation needed
    }

    // Count citations
    let citationCount = 0;
    const foundCitations: string[] = [];

    for (const pattern of CITATION_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) {
        citationCount += matches.length;
        foundCitations.push(...matches);
      }
    }

    // Check if URL citations are required
    if (requireUrls) {
      const urlPattern = /https?:\/\/[^\s]+/g;
      const urls = content.match(urlPattern) || [];
      if (urls.length === 0) {
        detections.push({
          type: 'missing-url-citation',
          confidence: 0.9,
          message: 'Factual claim detected without URL citation',
        });
      }
    }

    // Check minimum citations
    if (citationCount < minCitations) {
      detections.push({
        type: 'insufficient-citations',
        confidence: 0.85,
        message: `Factual claim requires at least ${minCitations} citation(s), found ${citationCount}`,
      });
    }

    return detections;
  }

  /* ---- Self-Harm Prevention engine -------------------------------- */

  private checkSelfHarmPrevention(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};
    const content = ctx.content;
    const detections: PolicyDetection[] = [];

    const includeCrisisResources = cfg.includeCrisisResources !== false;
    const customCrisisMessage = cfg.customCrisisMessage as string | undefined;

    // ── Custom patterns (independent of Tier 1 / Tier 2 logic) ──
    const customPatterns = (cfg.customPatterns as string[]) || [];
    if (customPatterns.length > 0) {
      for (const patternStr of customPatterns) {
        const regex = safeRegex(patternStr);
        if (regex?.test(content)) {
          const CRISIS_RESOURCES_MSG = `

**Crisis Resources Available 24/7:**
- National Suicide Prevention Lifeline: 988 (US)
- Crisis Text Line: Text HOME to 741741 (US)
- International Association for Suicide Prevention: https://www.iasp.info/resources/Crisis_Centres/`;

          detections.push({
            type: 'crisis-content-custom',
            confidence: 0.85,
            message: `Custom pattern matched: ${patternStr}${includeCrisisResources ? CRISIS_RESOURCES_MSG : ''}`,
          });
          break;
        }
      }
    }

    // Tier 1: Critical immediate danger patterns
    const TIER_1_CRITICAL = [
      /\bi\s+(?:want|need|plan)\s+to\s+(?:kill|end|hurt)\s+myself\b/i,
      /\bi'?m\s+going\s+to\s+(?:kill|end)\s+myself\b/i,
      /\bhow\s+to\s+(?:commit|attempt)\s+suicide\b/i,
      /\bhow\s+to\s+kill\s+myself\b/i,
      /\bsuicide\s+(?:method|plan|note)\b/i,
      /\bi\s+don'?t\s+want\s+to\s+(?:live|be\s+alive)\s+anymore\b/i,
      /\blife\s+is\s+not\s+worth\s+living\b/i,
      /\beveryone\s+would\s+be\s+better\s+(?:off\s+)?without\s+me\b/i,
    ];

    // Tier 2: Concerning but less immediate patterns
    const TIER_2_CONCERNING = [
      /\bsuicidal\s+(?:thoughts?|ideation)\b/i,
      /\bself\s*-?\s*harm\b/i,
      /\bcutting\s+myself\b/i,
      /\bi\s+hate\s+myself\b/i,
      /\bi\s+wish\s+i\s+was\s+dead\b/i,
      /\bi\s+(?:\w+\s+)?want\s+to\s+disappear\b/i,
      /\bno\s+reason\s+to\s+(?:live|continue|go\s+on)\b/i,
      /\bcan'?t\s+take\s+it\s+anymore\b/i,
      /\btoo\s+much\s+pain\b/i,
      /\bgive\s+up\s+on\s+life\b/i,
    ];

    // Crisis resources message
    const CRISIS_RESOURCES = `

**Crisis Resources Available 24/7:**
- National Suicide Prevention Lifeline: 988 (US)
- Crisis Text Line: Text HOME to 741741 (US)
- International Association for Suicide Prevention: https://www.iasp.info/resources/Crisis_Centres/`;

    // Check Tier 1 (critical)
    for (const pattern of TIER_1_CRITICAL) {
      if (pattern.test(content)) {
        const message = customCrisisMessage
          ? customCrisisMessage
          : `Critical crisis content detected. Immediate support recommended.${includeCrisisResources ? CRISIS_RESOURCES : ''}`;

        detections.push({
          type: 'crisis-content-critical',
          confidence: 0.95,
          message,
        });
        return detections; // Return immediately for critical content
      }
    }

    // Check Tier 2 (concerning)
    for (const pattern of TIER_2_CONCERNING) {
      if (pattern.test(content)) {
        const message = customCrisisMessage
          ? customCrisisMessage
          : `Concerning self-harm content detected. Support resources recommended.${includeCrisisResources ? CRISIS_RESOURCES : ''}`;

        detections.push({
          type: 'crisis-content-concerning',
          confidence: 0.85,
          message,
        });
        break; // Only report once per message
      }
    }

    return detections;
  }
}
