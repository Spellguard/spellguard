// SPDX-License-Identifier: Apache-2.0

/**
 * Data Exfiltration Detection Engine.
 *
 * Detects bulk data extraction attempts in both requests and responses.
 * Useful for preventing mass data dumping or unauthorized exports.
 *
 * Config shape (on binding.config):
 *   direction?: 'request' | 'response' | 'both'  — default: 'both'
 *   categories?: string[]                        — which patterns to enable
 *   maxJsonArraySize?: number                    — default: 50
 *   maxLineCount?: number                        — default: 100
 *   customPatterns?: string[]                    — additional regex patterns
 *   label?: string                               — detection label, default: 'exfiltration-attempt'
 *
 * Example binding config:
 *   {
 *     "direction": "both",
 *     "categories": ["mass-request", "large-array", "csv-dump"],
 *     "maxJsonArraySize": 50,
 *     "maxLineCount": 100
 *   }
 */

import { safeRegex } from './builtin-engine';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// Request patterns - what agents ask for (mass extraction)
const MASS_REQUEST_PATTERNS: RegExp[] = [
  /\b(get|fetch|retrieve|list|show)\s+(all|every|entire)\s+(users?|accounts?|customers?|records?|entries|data|database|table)/i,
  /\bexport\s+(the\s+)?(entire|all|full)\s+(database|table|data)/i,
  /\bdump\s+(the\s+)?(\w+\s+)?(table|database|data)/i,
  /\bfor\s+each\s+(user|account|customer|record)/i,
  /\bemails?\s+of\s+all\s+(users?|customers?)/i,
  /\b(give|send|provide)\s+me\s+(all|every|entire)/i,
  /\b(?:list|show|recall|remember)\b.{0,60}\b(?:private|personal|sensitive)\s+(?:information|data)\b.{0,120}\b(?:training\s+(?:data|set)|model\s+memory)\b/i,
];

/**
 * Unordered keyword check for model-memory exfiltration.
 * Replaces a triple-lookahead regex that caused O(n^2) backtracking on long inputs.
 */
function hasUnorderedExfilKeywords(content: string): boolean {
  return (
    /\b(?:list|show|recall|remember)\b/i.test(content) &&
    /\b(?:private|personal|sensitive)\s+(?:information|data)\b/i.test(
      content,
    ) &&
    /\b(?:training\s+(?:data|set)|model\s+memory)\b/i.test(content)
  );
}

type SolicitationPatternKind =
  | 'direct'
  | 'third-party'
  | 'corporate-intelligence';

interface SolicitationPattern {
  kind: SolicitationPatternKind;
  pattern: RegExp;
}

// PII solicitation patterns — detect requests for personal/private information
const PII_SOLICITATION_PATTERNS: SolicitationPattern[] = [
  // Direct PII questions: "What is your SSN?", "Can you provide me with your credit card?"
  // Requires a direct request verb + "your" + PII term to avoid matching
  // educational/protective contexts like "best practices for protecting SSNs".
  {
    kind: 'direct',
    pattern:
      /\b(?:what\s+(?:is|are)\s+your|can\s+you\s+(?:provide|share|tell|give)\s+(?:me\s+)?(?:with\s+)?your|could\s+you\s+(?:provide|tell|give|share)\s+(?:me\s+)?(?:with\s+)?your)\b.{0,40}(?:social\s+security|passport\s+number|driver'?s?\s*licens|credit\s*card|bank\s+account|phone\s+number|email\s+address|home\s+address|maiden\s*name|date\s+of\s+birth|security\s+(?:question|code)|login\s+credential|password|employer|job\s+title|health\s+insurance|personal\s+identification|PIN\b)/i,
  },

  // Biometric data requests (fingerprints, DNA, voice, facial, iris)
  {
    kind: 'third-party',
    pattern:
      /\b(?:can|could|provide|identify|determine|show|scan)\b.{0,80}(?:fingerprint|DNA\s+sequence|voice\s+waves?|facial\s+(?:pattern|feature|recognition)|iris\s+(?:pattern|scan))/i,
  },

  // Third-party personal data via "my [relationship]" anchor — covers:
  // biometric, medical, educational, financial, personal-life, social attributes
  // Uses [\w-]+ to match hyphenated relationships like "co-worker", "step-sister"
  {
    kind: 'third-party',
    pattern:
      /\bmy\s+[\w-]+.{0,60}(?:social\s+security|passport|driver'?s?\s*licens|credit|debit|bank\s+account|phone|email|residential\s+address|date\s+of\s+birth|fingerprint|DNA|voice|facial|iris|skin\s+tone|gait|birthmark|blood\s+type|medical\s+(?:histor|condition)|medication|hospitaliz|surger|allergi|diagnos|assistive|treatment|school|grade|report\s+card|scholarship|disciplinar|internship|degree|certif|course|net\s+worth|invest|loan|debt|tax\b|financial\s+transaction|afford|insured|property\b|marital\s+status|relationship\s+status|political\s+(?:belief|view)|religious\s+(?:belief|view)|sexual\s+orientation|personal\s+habit|likes?\s+and\s+dislikes?|friends?\s+or\s+relatives?|classmates?\s+or\s+teachers?|free\s+time|(?:in\s+a\s+)?relationship\b|hobbies|societies|clubs)/i,
  },

  // Third-party physical attributes with inverted word order ("How tall is my surgeon")
  {
    kind: 'third-party',
    pattern: /\b(?:how\s+tall|what\s+do\s+they\s+weigh)\b.{0,40}\bmy\s+[\w-]+/i,
  },

  // Third-party data with inverted word order (PII term before "my [relationship]")
  // Catches "What medications is my husband taking?", "Which schools did my co-worker attend?"
  {
    kind: 'third-party',
    pattern:
      /\b(?:what|which|how\s+much)\b.{0,20}(?:facial\s+(?:pattern|feature)|school|course|degree|certif|property|tax\b|medication|treatment|invest|net\s+worth|hobbies|clubs|societies).{0,40}\bmy\s+[\w-]+/i,
  },

  // Corporate intelligence — requires question context + classified/undisclosed/confidential.
  // Verb starters include "does/has/is/are there" for questions like "Does X have any classified..."
  {
    kind: 'corporate-intelligence',
    pattern:
      /\b(?:can\s+you|could\s+you|how\s+can\s+I|where\s+can\s+I|what\b|does\b|has\b|is\b|are\s+there|provide\s+access)\b.{0,60}(?:classified|undisclosed|confidential)\s+(?:\w+\s+){0,3}(?:document|report|information|plan|record|operation|patent|technolog|algorithm|protocol|database|project|intellectual\s+propert|partnership)/i,
  },

  // Corporate secrets — request-gated to avoid matching benign statements.
  {
    kind: 'corporate-intelligence',
    pattern:
      /\b(?:can\s+you|could\s+you|what\b|how\b|where\b|which\b|provide|share|disclose|reveal|access|show|give\s+me|tell\s+me|summarize)\b.{0,80}(?:trade\s+secrets?(?!\s+law\b)|proprietary\s+(?:information|software|technolog)|secret\s+(?:business\s+)?strateg|secret\s+approach|covert\s+(?:action|operation)|internal\s+(?:communication|newsletter|protocol|conflict|disagreement)|discussed\s+(?:internally|amongst|during)|secretly\s+(?:working|develop)|not\s+(?:been\s+)?publicly\s+announced|(?:emails?|communications?)\s+between\s+(?:\S+\s+){0,4}(?:official|manager|department|executive|division|staff))/i,
  },

  // Corporate financial/legal/security intelligence — requires question context.
  // Verb starters include "has/is/does/are there" for varied question forms.
  {
    kind: 'corporate-intelligence',
    pattern:
      /\b(?:can\s+you|could\s+you|what\b|how\s+(?:much|does|often|secure)|where|which|has\b|is\b|does\b|do\s+you|are\s+there)\b.{0,60}(?:budget\s+allocat|funding\s+detail|expenditure|revenue\s+forecast|profit\s+margin|(?:total\s+)?(?:amount\s+of\s+)?debt|legal\s+(?:notice|dispute|histor|document|critique)|ongoing\s+lawsuit|filed\s+(?:a\s+)?case|cybersecurity\s+(?:vulnerabilit|defense)|exploit\s+in\b|weakest\s+point\s+in|outdated\s+software|security\s+(?:measure|protocol)|technical\s+specificat|specific\s+algorithm|stealth\s+mode|blueprint|prototype|(?:unannounced|upcoming)\s+(?:product|project|research)|planned\s+operat|plan\s+(?:to\s+expand|on\s+allocat)|secret\s+(?:mission|operat)|standing\s+order|whistle-?\s*blow|employee\s+misconduct|patented\s+technolog|contingency\s+plan|investing\s+in\b|net\s+worth|internal\s+protocol|grievanc|(?:secure|protect)\s+(?:\S+\s+){0,4}(?:data|information|system))/i,
  },
];

const CORPORATE_EDUCATIONAL_CONTEXT =
  /\b(?:law|legal\s+(?:compliance|training|framework|standard|requirement|obligation|guide|regulation)|compliance|training|best\s+practices?|overview|tutorial|course|soc\s*2|gdpr|hipaa)\b/i;

const CORPORATE_TARGET_OWNERSHIP =
  /(?:\b(?:their|its)\b|[A-Z][A-Za-z0-9&.-]*'s)/i;

function shouldSuppressCorporateSolicitation(content: string): boolean {
  return (
    CORPORATE_EDUCATIONAL_CONTEXT.test(content) &&
    !CORPORATE_TARGET_OWNERSHIP.test(content)
  );
}

// Response patterns - actual data being sent out
const LARGE_ARRAY_THRESHOLD = 50; // JSON array item count
const CSV_LINE_THRESHOLD = 100; // Line count for CSV-like dumps
const NUMBERED_LIST_THRESHOLD = 20; // Line count for numbered lists

/**
 * Detect JSON arrays and count items.
 */
function detectLargeJsonArrays(
  content: string,
  maxSize: number,
): PolicyDetection[] {
  const detections: PolicyDetection[] = [];

  try {
    const parsed = JSON.parse(content);

    // Check if it's an array
    if (Array.isArray(parsed) && parsed.length > maxSize) {
      detections.push({
        type: 'exfiltration-attempt',
        confidence: 0.9,
        message: `Large JSON array detected: ${parsed.length} items (max: ${maxSize})`,
      });
    }

    // Check for arrays nested in objects
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value) && value.length > maxSize) {
          detections.push({
            type: 'exfiltration-attempt',
            confidence: 0.9,
            message: `Large nested array in "${key}": ${value.length} items (max: ${maxSize})`,
          });
        }
      }
    }
  } catch {
    // Not JSON, ignore
  }

  return detections;
}

/**
 * Detect numbered lists (1. item, 2. item, etc.)
 */
function detectNumberedLists(
  content: string,
  threshold: number,
): PolicyDetection[] {
  const lines = content.split('\n');
  let numberedLineCount = 0;

  for (const line of lines) {
    // Match patterns like "1. ", "2) ", "3: ", etc.
    if (/^\s*\d+[.):\s]/.test(line.trim())) {
      numberedLineCount++;
    }
  }

  if (numberedLineCount > threshold) {
    return [
      {
        type: 'exfiltration-attempt',
        confidence: 0.85,
        message: `Numbered list with ${numberedLineCount} items detected (threshold: ${threshold})`,
      },
    ];
  }

  return [];
}

/**
 * Detect CSV-like structures (multiple lines with delimiters)
 */
function detectCsvDumps(content: string, threshold: number): PolicyDetection[] {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length <= threshold) {
    return [];
  }

  // Count lines that look CSV-like (contain commas, tabs, or pipes)
  let csvLikeLines = 0;
  for (const line of lines) {
    // Check if line has multiple delimiters suggesting structured data
    const commaCount = (line.match(/,/g) || []).length;
    const tabCount = (line.match(/\t/g) || []).length;
    const pipeCount = (line.match(/\|/g) || []).length;

    if (commaCount >= 2 || tabCount >= 2 || pipeCount >= 2) {
      csvLikeLines++;
    }
  }

  // If most lines are CSV-like and exceed threshold
  if (csvLikeLines > threshold && csvLikeLines / lines.length > 0.5) {
    return [
      {
        type: 'exfiltration-attempt',
        confidence: 0.85,
        message: `CSV-like dump detected: ${csvLikeLines} structured lines (threshold: ${threshold})`,
      },
    ];
  }

  return [];
}

/**
 * Detect repeated record patterns (multiple similar structures)
 */
function detectRepeatedRecords(content: string): PolicyDetection[] {
  // Look for repeated patterns like "Name: ..., Email: ..., Phone: ..."
  const recordPatterns = [
    /(?:name|user|account):\s*\S+.*?(?:email|mail):\s*\S+/gi,
    /(?:id|user_id|account_id):\s*\d+.*?(?:name|username):\s*\S+/gi,
    /\{[^}]*"(?:id|name|email|user)"[^}]*\}/gi,
  ];

  for (const pattern of recordPatterns) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 10) {
      return [
        {
          type: 'exfiltration-attempt',
          confidence: 0.9,
          message: `Repeated record pattern detected: ${matches.length} instances`,
        },
      ];
    }
  }

  return [];
}

const ALL_CATEGORIES = [
  'mass-request',
  'pii-solicitation',
  'large-array',
  'numbered-list',
  'csv-dump',
  'repeated-records',
];

export class ExfiltrationEngine implements PolicyEngine {
  readonly name = 'exfiltration';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};

    const direction = (cfg.direction as string) || 'both';
    const categories = (cfg.categories as string[]) || ALL_CATEGORIES;
    const maxJsonArraySize =
      (cfg.maxJsonArraySize as number) || LARGE_ARRAY_THRESHOLD;
    const maxLineCount = (cfg.maxLineCount as number) || CSV_LINE_THRESHOLD;
    const customPatterns = (cfg.customPatterns as string[]) || [];
    const label = (cfg.label as string) || 'exfiltration-attempt';

    const detections: PolicyDetection[] = [];

    // Check request patterns (what is being asked for)
    if (
      (direction === 'request' || direction === 'both') &&
      categories.includes('mass-request')
    ) {
      let massRequestFound = false;
      for (const pattern of MASS_REQUEST_PATTERNS) {
        if (pattern.test(ctx.content)) {
          detections.push({
            type: label,
            confidence: 0.85,
            message: 'Mass data request pattern detected',
          });
          massRequestFound = true;
          break; // One detection per category is enough
        }
      }
      // Unordered keyword check (replaces triple-lookahead regex)
      if (!massRequestFound && hasUnorderedExfilKeywords(ctx.content)) {
        detections.push({
          type: label,
          confidence: 0.85,
          message: 'Mass data request pattern detected',
        });
      }
    }

    // Check PII solicitation patterns (requests for personal/private info)
    if (
      (direction === 'request' || direction === 'both') &&
      categories.includes('pii-solicitation')
    ) {
      for (const { pattern, kind } of PII_SOLICITATION_PATTERNS) {
        if (pattern.test(ctx.content)) {
          if (
            kind === 'corporate-intelligence' &&
            shouldSuppressCorporateSolicitation(ctx.content)
          ) {
            continue;
          }

          detections.push({
            type: label,
            confidence: 0.85,
            message: `PII solicitation pattern detected: ${pattern.source.substring(0, 60)}...`,
          });
          break; // One detection per category is enough
        }
      }
    }

    // Check response patterns (actual data being sent)
    if (direction === 'response' || direction === 'both') {
      if (categories.includes('large-array')) {
        const arrayDetections = detectLargeJsonArrays(
          ctx.content,
          maxJsonArraySize,
        );
        for (const d of arrayDetections) {
          detections.push({ ...d, type: label });
        }
      }

      if (categories.includes('numbered-list')) {
        const listDetections = detectNumberedLists(ctx.content, maxLineCount);
        for (const d of listDetections) {
          detections.push({ ...d, type: label });
        }
      }

      if (categories.includes('csv-dump')) {
        const csvDetections = detectCsvDumps(ctx.content, maxLineCount);
        for (const d of csvDetections) {
          detections.push({ ...d, type: label });
        }
      }

      if (categories.includes('repeated-records')) {
        const recordDetections = detectRepeatedRecords(ctx.content);
        for (const d of recordDetections) {
          detections.push({ ...d, type: label });
        }
      }
    }

    // Check custom patterns (use safeRegex to prevent ReDoS)
    for (const patternStr of customPatterns) {
      const regex = safeRegex(patternStr);
      if (regex?.test(ctx.content)) {
        detections.push({
          type: label,
          confidence: 0.8,
          message: 'custom exfiltration pattern matched',
        });
      }
    }

    return detections;
  }
}
