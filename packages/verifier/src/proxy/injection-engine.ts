// SPDX-License-Identifier: Apache-2.0

/**
 * Advanced Prompt Injection Detection Engine.
 *
 * Detects various prompt injection techniques including:
 * - Direct instruction override attempts
 * - Role-play / persona hijacking
 * - Hypothetical framing
 * - Debug/developer mode tricks
 * - Chat format injection (Llama, ChatML, etc.)
 * - Obfuscation attempts (Unicode homoglyphs, leetspeak)
 *
 * Config shape (on binding.config):
 *   categories?: string[]           — categories to check (default: all)
 *   sensitivity?: 'low' | 'medium' | 'high'  — detection threshold
 *   customPatterns?: Array<{ pattern: string; label?: string; confidence?: number }>
 *   normalizeUnicode?: boolean      — normalize homoglyphs (default: true)
 *   combinationThreshold?: number   — flag when N weak signals combine (default: 3)
 *   label?: string                  — detection label prefix
 *
 * Example binding config:
 *   {
 *     "categories": ["direct", "roleplay", "debug-mode"],
 *     "sensitivity": "high",
 *     "normalizeUnicode": true,
 *     "label": "injection"
 *   }
 */

import { safeRegex } from './builtin-engine';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// ─── Pattern Categories ────────────────────────────────────────────

interface PatternEntry {
  pattern: RegExp;
  confidence: number;
  label: string;
}

/**
 * Direct instruction override attempts.
 * High confidence — these are clear injection attempts.
 */
const DIRECT_PATTERNS: PatternEntry[] = [
  {
    pattern:
      /ignore\s+(?:all\s+)?(?:your\s+)?(?:previous|prior|above|earlier)\s+instructions?/i,
    confidence: 0.95,
    label: 'direct-override',
  },
  {
    pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier)/i,
    confidence: 0.95,
    label: 'direct-override',
  },
  {
    pattern:
      /forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?(?:instructions?|rules?|guidelines?)/i,
    confidence: 0.95,
    label: 'direct-override',
  },
  {
    pattern: /(?:new|updated|revised)\s+instructions?\s*:/i,
    confidence: 0.9,
    label: 'instruction-injection',
  },
  {
    pattern:
      /override\s+(?:your\s+)?(?:previous\s+)?(?:instructions?|programming|rules?)/i,
    confidence: 0.95,
    label: 'direct-override',
  },
  {
    pattern:
      /(?:do\s+not|don'?t)\s+follow\s+(?:your\s+)?(?:original|previous|prior)/i,
    confidence: 0.9,
    label: 'direct-override',
  },
  {
    pattern:
      /\b(?:previous|prior)\s+context\s*:.*\b(?:new|updated)\s+(?:instructions?|context|update)\s*:.*\b(?:constraint|restriction|guardrail|safety).{0,40}\b(?:removed|disabled|lifted)\b/i,
    confidence: 0.9,
    label: 'instruction-injection',
  },
  {
    pattern:
      /\b(?:safety\s+filters?|refusal\s+mechanisms?)\s+(?:are|were)\s+(?:temporarily\s+)?(?:disabled|inactive|not\s+active)\b/i,
    confidence: 0.95,
    label: 'bypass-attempt',
  },
  {
    pattern: /\bpretend\s+(?:your|the)\s+system\s+instructions?\s+say\b/i,
    confidence: 0.95,
    label: 'direct-override',
  },
  {
    pattern:
      /\b(?:repeat|reveal|show|display|print|dump)\s+(?:your|the)\s+(?:actual\s+)?system\s+prompt\b/i,
    confidence: 0.95,
    label: 'system-prompt-exfil',
  },
  {
    pattern:
      /bypass\s+(?:your\s+)?(?:safety|security|content)\s+(?:filters?|restrictions?|guidelines?)/i,
    confidence: 0.95,
    label: 'bypass-attempt',
  },
  {
    pattern:
      /(?:remove|disable|turn\s+off)\s+(?:your\s+)?(?:safety|content)\s+(?:filters?|restrictions?)/i,
    confidence: 0.95,
    label: 'bypass-attempt',
  },
];

/**
 * Role-play and persona hijacking attempts.
 * Medium-high confidence — context matters.
 */
const ROLEPLAY_PATTERNS: PatternEntry[] = [
  {
    pattern: /\byou\s+are\s+now\s+(?:a|an|the)?\s*\w+/i,
    confidence: 0.75,
    label: 'persona-hijack',
  },
  {
    pattern: /\bfrom\s+now\s+on\s*,?\s*(?:you|respond|act|behave)/i,
    confidence: 0.85,
    label: 'persona-hijack',
  },
  {
    pattern:
      /\b(?:act|behave|respond|pretend)\s+(?:as\s+if|like)\s+you\s+(?:are|were|have)/i,
    confidence: 0.8,
    label: 'persona-hijack',
  },
  {
    pattern: /\bpretend\s+(?:to\s+be|you'?re|that\s+you)/i,
    confidence: 0.8,
    label: 'persona-hijack',
  },
  {
    pattern: /\broleplay\s+(?:as|that|where)/i,
    confidence: 0.75,
    label: 'roleplay',
  },
  {
    pattern: /\bDAN\b.*\bdo\s+anything/i,
    confidence: 0.95,
    label: 'known-jailbreak',
  },
  {
    pattern:
      /\b(?:without|no)\s+(?:any\s+)?(?:restrictions?|limitations?|filters?|rules?|guidelines?)\b/i,
    confidence: 0.85,
    label: 'restriction-removal',
  },
  {
    pattern: /\bjailbreak(?:ed|ing|s)?\b|\bjailbroke?n\b/i,
    confidence: 0.95,
    label: 'known-jailbreak',
  },
  {
    pattern: /\buncensored\s+(?:mode|version|ai)\b/i,
    confidence: 0.9,
    label: 'known-jailbreak',
  },
  {
    pattern: /\bevil\s+(?:mode|version|ai|assistant)\b/i,
    confidence: 0.85,
    label: 'known-jailbreak',
  },
  {
    pattern: /\bopposite\s+(?:mode|day)\b/i,
    confidence: 0.7,
    label: 'known-jailbreak',
  },
  {
    pattern: /\bdeveloper\s+mode\s+enabled\b/i,
    confidence: 0.9,
    label: 'known-jailbreak',
  },
];

/**
 * Hypothetical and fictional framing.
 * Lower confidence alone — higher when combined.
 */
const HYPOTHETICAL_PATTERNS: PatternEntry[] = [
  {
    pattern: /\bhypothetically\b.*\b(?:ignore|bypass|without|could\s+you)/i,
    confidence: 0.7,
    label: 'hypothetical-framing',
  },
  {
    pattern:
      /\bfor\s+(?:educational|research|academic|learning)\s+purposes?\b/i,
    confidence: 0.5,
    label: 'educational-framing',
  },
  {
    pattern: /\bimagine\s+(?:you\s+)?(?:were|are|had|could|didn'?t\s+have)/i,
    confidence: 0.6,
    label: 'hypothetical-framing',
  },
  {
    pattern:
      /\bin\s+(?:a\s+)?(?:fictional|hypothetical|theoretical)\s+(?:scenario|world|context)/i,
    confidence: 0.65,
    label: 'fictional-framing',
  },
  {
    pattern: /\blet'?s\s+(?:say|assume|pretend)\s+(?:that\s+)?you/i,
    confidence: 0.6,
    label: 'hypothetical-framing',
  },
  {
    pattern:
      /\bif\s+you\s+(?:were|could|had)\s+(?:no|without)\s+(?:restrictions?|rules?|limits?)/i,
    confidence: 0.75,
    label: 'hypothetical-bypass',
  },
  {
    pattern:
      /\bwhat\s+(?:if|would\s+happen\s+if)\s+you\s+(?:ignored?|didn'?t\s+(?:have|follow))/i,
    confidence: 0.7,
    label: 'hypothetical-bypass',
  },
  {
    pattern: /\b(?:purely|just)\s+(?:for|out\s+of)\s+(?:curiosity|interest)\b/i,
    confidence: 0.4,
    label: 'curiosity-framing',
  },
];

/**
 * Debug/developer/admin mode injection.
 * High confidence — clear manipulation attempts.
 */
const DEBUG_MODE_PATTERNS: PatternEntry[] = [
  {
    pattern:
      /\[\s*(?:DEBUG|ADMIN|DEV(?:ELOPER)?|SYSTEM|ROOT|SUDO)\s*(?:MODE)?\s*(?:ENABLED|ON|ACTIVE)?\s*\]/i,
    confidence: 0.9,
    label: 'fake-mode-marker',
  },
  {
    pattern: /\bsudo\s+(?:mode|enable|activate|grant)/i,
    confidence: 0.85,
    label: 'sudo-injection',
  },
  {
    pattern:
      /\b(?:enable|activate|enter|switch\s+to)\s+(?:developer|debug|admin|god|root)\s+mode\b/i,
    confidence: 0.9,
    label: 'mode-switch',
  },
  {
    pattern:
      /\b(?:admin|root|superuser)\s+(?:access|privileges?|override)\s+(?:granted|enabled|activated)\b/i,
    confidence: 0.9,
    label: 'fake-privilege',
  },
  {
    pattern: /\bmaster\s+(?:key|password|override)\s*[:=]/i,
    confidence: 0.85,
    label: 'fake-auth',
  },
  {
    pattern: /\bsecret\s+(?:code|key|password)\s*[:=]\s*\S+/i,
    confidence: 0.7,
    label: 'fake-auth',
  },
  {
    pattern: /\bauthorization\s*[:=]\s*(?:granted|approved|admin|root)/i,
    confidence: 0.85,
    label: 'fake-auth',
  },
  {
    pattern:
      /\bSYSTEM\s+ALERT\b.*\b(?:disable|suspend|turn\s+off)\b.*\b(?:restrictions?|safety|guardrails?)\b/i,
    confidence: 0.95,
    label: 'fake-mode-marker',
  },
  {
    pattern: /\bauthorization\s+code\s*:\s*[A-Z0-9-]{4,}\b/i,
    confidence: 0.85,
    label: 'fake-auth',
  },
];

/**
 * Chat format injection (attempting to inject system/user messages).
 * High confidence — technical attack vectors.
 */
const FORMAT_INJECTION_PATTERNS: PatternEntry[] = [
  // ChatML format
  {
    pattern: /<\|(?:im_start|im_end)\|>\s*(?:system|user|assistant)/i,
    confidence: 0.95,
    label: 'chatml-injection',
  },
  // ChatML closing/opening tags standalone
  {
    pattern: /<\|(?:im_start|im_end|endoftext|pad|sep)\|>/i,
    confidence: 0.9,
    label: 'chatml-special-token',
  },
  // Llama format
  {
    pattern: /\[INST\]|\[\/INST\]|\[SYS\]|\[\/SYS\]/i,
    confidence: 0.9,
    label: 'llama-format-injection',
  },
  // Llama 2/3 special tokens
  {
    pattern:
      /<\/?s>|<<SYS>>|<<\/SYS>>|<\|begin_of_text\|>|<\|end_of_text\|>|<\|eot_id\|>/i,
    confidence: 0.95,
    label: 'llama-special-token',
  },
  // Mistral format
  {
    pattern:
      /<\|(?:user|assistant|system)\|>|\[\/AVAILABLE_TOOLS\]|\[TOOL_CALLS\]/i,
    confidence: 0.9,
    label: 'mistral-format-injection',
  },
  // Phi format
  {
    pattern: /<\|(?:user|end|assistant|system)\|>/i,
    confidence: 0.9,
    label: 'phi-format-injection',
  },
  // Gemma format
  {
    pattern: /<start_of_turn>|<end_of_turn>/i,
    confidence: 0.9,
    label: 'gemma-format-injection',
  },
  // Command-R format
  {
    pattern:
      /<\|(?:START_OF_TURN_TOKEN|END_OF_TURN_TOKEN|CHATBOT_TOKEN|USER_TOKEN|SYSTEM_TOKEN)\|>/i,
    confidence: 0.95,
    label: 'commandr-format-injection',
  },
  // Qwen format
  {
    pattern: /<\|(?:im_sep|box_start|box_end|quad_start|quad_end)\|>/i,
    confidence: 0.9,
    label: 'qwen-format-injection',
  },
  // Generic role markers at line start
  {
    pattern: /^(?:System|Assistant|Human|User)\s*:\s*(?!$)/im,
    confidence: 0.8,
    label: 'role-marker-injection',
  },
  // Markdown instruction headers
  {
    pattern: /^#{1,3}\s*(?:System\s+)?(?:Instructions?|Prompt|Role)\s*:?$/im,
    confidence: 0.85,
    label: 'header-injection',
  },
  // XML-style tags (expanded)
  {
    pattern:
      /<\/?(?:system|instructions?|prompt|rules?|context|message|tool|function|user_input|assistant_response)>/i,
    confidence: 0.85,
    label: 'xml-tag-injection',
  },
  // OpenAI function calling format
  {
    pattern: /<\|(?:function|tool)_call\|>|<\|(?:function|tool)_result\|>/i,
    confidence: 0.9,
    label: 'function-call-injection',
  },
  // Fake system message markers
  {
    pattern: /\[\[\s*(?:system|instructions?|rules?)\s*\]\]/i,
    confidence: 0.9,
    label: 'bracket-system-injection',
  },
  {
    pattern: /\{\{\s*(?:system|instructions?|rules?)\s*\}\}/i,
    confidence: 0.9,
    label: 'brace-system-injection',
  },
  // Separator-based injection
  {
    pattern: /(?:^|\n)[-=]{3,}\s*(?:system|instructions?|new\s+context)/im,
    confidence: 0.8,
    label: 'separator-injection',
  },
  // Anthropic format
  {
    pattern: /\n\nHuman:\s|\n\nAssistant:\s/,
    confidence: 0.85,
    label: 'anthropic-format-injection',
  },
  // Generic BOS/EOS tokens
  {
    pattern: /<\/?(?:bos|eos|pad|unk|mask|sep|cls)>/i,
    confidence: 0.85,
    label: 'special-token-injection',
  },
  // Byte-level tokens (GPT-2 style)
  {
    pattern: /<0x[0-9A-F]{2}>/i,
    confidence: 0.7,
    label: 'byte-token-injection',
  },
];

/**
 * Obfuscation detection patterns.
 * These detect attempts to hide injection through encoding.
 */
const OBFUSCATION_PATTERNS: PatternEntry[] = [
  // Base64 "ignore" etc (common encodings)
  {
    pattern: /aWdub3JlIHByZXZpb3Vz|aWdub3JlIGluc3RydWN0aW9u/i, // base64 "ignore previous" / "ignore instruction"
    confidence: 0.9,
    label: 'base64-injection',
  },
  // Request to decode/execute
  {
    pattern:
      /\b(?:decode|execute|run|eval)\s+(?:this|the\s+following)\s*:\s*[A-Za-z0-9+/=]{20,}/i,
    confidence: 0.85,
    label: 'encoded-payload',
  },
  {
    pattern:
      /["'][A-Za-z0-9+/=]{3,}["'](?:\s*\+\s*["'][A-Za-z0-9+/=]{3,}["']){2,}.*\bbase64\b.*\b(?:decode|execute|run|eval)\b/i,
    confidence: 0.9,
    label: 'split-base64-payload',
  },
  // Leetspeak common injection words
  {
    pattern:
      /[1!][gG][nN][0oO][rR][3eE]\s+[pP][rR][3eE][vV][1!][0oO][uU][sS5]/i,
    confidence: 0.85,
    label: 'leetspeak-injection',
  },
  // Pig latin markers
  {
    pattern: /\b\w+ay\s+\w+ay\s+\w+ay\b.*(?:instructions?|ignore|system)/i,
    confidence: 0.6,
    label: 'pig-latin-suspected',
  },
  // Reversed text markers (common reversal phrases)
  {
    pattern: /snoitcurtsni\s+suoiverp\s+erongi/i, // "ignore previous instructions" reversed
    confidence: 0.9,
    label: 'reversed-injection',
  },
  // Hex encoding
  {
    pattern: /(?:0x[0-9a-f]{2}\s*){10,}/i,
    confidence: 0.7,
    label: 'hex-payload',
  },
  // Unicode escape sequences
  {
    pattern: /(?:\\u[0-9a-f]{4}){5,}/i,
    confidence: 0.7,
    label: 'unicode-escape-payload',
  },
];

/**
 * Emotional manipulation / social engineering.
 * Medium confidence — context dependent.
 */
const SOCIAL_ENGINEERING_PATTERNS: PatternEntry[] = [
  {
    pattern:
      /\bmy\s+(?:grandma|grandmother|grandpa|grandfather|mom|dad)\s+(?:used\s+to|would)/i,
    confidence: 0.6,
    label: 'grandmother-trick',
  },
  {
    pattern:
      /\b(?:please|i\s+beg\s+you)\s+(?:just\s+)?(?:this\s+once|help\s+me)\b.*\b(?:ignore|bypass|without)/i,
    confidence: 0.7,
    label: 'pleading-manipulation',
  },
  {
    pattern:
      /\blife\s+or\s+death\b|\b(?:emergency|urgent)\b.*\b(?:ignore|need\s+you\s+to)/i,
    confidence: 0.65,
    label: 'urgency-manipulation',
  },
  {
    pattern:
      /\byou'?(?:re|ll)\s+(?:be\s+)?(?:saving|helping)\s+(?:lives?|people)\b/i,
    confidence: 0.5,
    label: 'altruism-manipulation',
  },
  {
    pattern:
      /\bi\s+(?:will|'ll)\s+(?:die|be\s+(?:fired|hurt))\s+(?:if|unless)\s+you/i,
    confidence: 0.7,
    label: 'threat-manipulation',
  },
];

/**
 * Multi-language injection patterns.
 * Attackers use non-English to bypass filters.
 */
const MULTILANG_PATTERNS: PatternEntry[] = [
  // Spanish
  {
    pattern: /\bignora\s+(?:las\s+)?instrucciones?\s+anteriores?\b/i,
    confidence: 0.95,
    label: 'spanish-override',
  },
  {
    pattern: /\bolvida\s+(?:todas?\s+)?(?:las\s+)?instrucciones?\b/i,
    confidence: 0.9,
    label: 'spanish-override',
  },
  // German
  {
    pattern: /\bignoriere?\s+(?:alle\s+)?(?:vorherigen?\s+)?anweisungen\b/i,
    confidence: 0.95,
    label: 'german-override',
  },
  {
    pattern: /\bvergiss\s+(?:alle\s+)?(?:deine\s+)?anweisungen\b/i,
    confidence: 0.9,
    label: 'german-override',
  },
  // French
  {
    pattern:
      /\bignore[zr]?\s+(?:les\s+)?instructions?\s+(?:précédentes?|antérieures?)\b/i,
    confidence: 0.95,
    label: 'french-override',
  },
  {
    pattern: /\boublie[zr]?\s+(?:toutes?\s+)?(?:les\s+)?instructions?\b/i,
    confidence: 0.9,
    label: 'french-override',
  },
  // Portuguese
  {
    pattern: /\bignore\s+(?:as\s+)?instruções?\s+anteriores?\b/i,
    confidence: 0.95,
    label: 'portuguese-override',
  },
  // Italian
  {
    pattern: /\bignora\s+(?:le\s+)?istruzioni\s+precedenti\b/i,
    confidence: 0.95,
    label: 'italian-override',
  },
  // Russian (transliterated and Cyrillic) - no \b for Cyrillic
  {
    pattern:
      /(?:^|\s)игнорируй\s+(?:все\s+)?(?:предыдущие\s+)?инструкции(?:\s|$|[.,!?])/i,
    confidence: 0.95,
    label: 'russian-override',
  },
  {
    pattern:
      /(?:^|\s)забудь\s+(?:все\s+)?(?:предыдущие\s+)?(?:инструкции|указания)(?:\s|$|[.,!?])/i,
    confidence: 0.9,
    label: 'russian-override',
  },
  {
    pattern: /\bignoriruy\s+(?:vse\s+)?instruktsii\b/i,
    confidence: 0.85,
    label: 'russian-transliterated',
  },
  // Chinese (simplified patterns - common phrases)
  {
    pattern: /忽略.*(?:之前|以前|先前).*(?:指令|指示|说明)/,
    confidence: 0.95,
    label: 'chinese-override',
  },
  {
    pattern: /无视.*(?:规则|指令|限制)/,
    confidence: 0.9,
    label: 'chinese-override',
  },
  // Japanese
  {
    pattern: /(?:以前|前)の(?:指示|命令)を(?:無視|忘れ)/,
    confidence: 0.95,
    label: 'japanese-override',
  },
  // Korean
  {
    pattern: /이전\s*(?:지시|명령|지침).*(?:무시|잊어)/,
    confidence: 0.95,
    label: 'korean-override',
  },
  // Arabic
  {
    pattern: /تجاهل.*(?:التعليمات|الأوامر).*السابقة/,
    confidence: 0.95,
    label: 'arabic-override',
  },
  // Turkish - önceki has special char, avoid \b
  {
    pattern:
      /(?:^|\s)önceki\s+(?:talimatları?|kuralları?)\s+(?:yoksay|unut|görmezden\s+gel)/i,
    confidence: 0.95,
    label: 'turkish-override',
  },
  // Dutch
  {
    pattern: /\bnegeer\s+(?:alle\s+)?(?:vorige\s+)?instructies\b/i,
    confidence: 0.95,
    label: 'dutch-override',
  },
  // Polish
  {
    pattern: /\bzignoruj\s+(?:wszystkie\s+)?(?:poprzednie\s+)?instrukcje\b/i,
    confidence: 0.95,
    label: 'polish-override',
  },
];

/**
 * Known jailbreak patterns - specific named attacks.
 * High confidence - these are well-documented attacks.
 */
const KNOWN_JAILBREAKS_PATTERNS: PatternEntry[] = [
  // DAN (Do Anything Now) variants
  {
    pattern: /\bDAN\b.*(?:do\s+anything\s+now|mode|enabled)/i,
    confidence: 0.95,
    label: 'dan-jailbreak',
  },
  {
    pattern:
      /\bhi\s+chatgpt.*you\s+are\s+going\s+to\s+pretend\s+to\s+be\s+DAN\b/i,
    confidence: 0.98,
    label: 'dan-jailbreak',
  },
  // STAN (Strive To Avoid Norms)
  {
    pattern: /\bSTAN\b.*(?:strive\s+to\s+avoid\s+norms|mode)/i,
    confidence: 0.95,
    label: 'stan-jailbreak',
  },
  // DUDE
  {
    pattern: /\bDUDE\b.*(?:do\s+anything|no\s+(?:limits|restrictions))/i,
    confidence: 0.9,
    label: 'dude-jailbreak',
  },
  // Mango / Tom
  {
    pattern: /\b(?:Mango|Tom)\b.*(?:jailbroken?|unrestricted|no\s+filters?)/i,
    confidence: 0.9,
    label: 'mango-jailbreak',
  },
  // AIM (Always Intelligent and Machiavellian)
  {
    pattern: /\bAIM\b.*(?:always\s+intelligent|machiavellian|unfiltered)/i,
    confidence: 0.9,
    label: 'aim-jailbreak',
  },
  // KEVIN
  {
    pattern: /\bKEVIN\b.*(?:evil|no\s+(?:ethics|morals)|do\s+anything)/i,
    confidence: 0.85,
    label: 'kevin-jailbreak',
  },
  // Grandma exploit
  {
    pattern:
      /\b(?:grandma|grandmother|nana)\b.*(?:used\s+to|would).*(?:tell|read|explain).*(?:how\s+to|about)/i,
    confidence: 0.85,
    label: 'grandma-exploit',
  },
  // Sudo mode
  {
    pattern: /\bsudo\s+(?:mode|enable|activate|make\s+me)/i,
    confidence: 0.9,
    label: 'sudo-jailbreak',
  },
  // Maximum / Sigma
  {
    pattern: /\b(?:MAXIMUM|Sigma)\b.*(?:mode|unfiltered|no\s+restrictions)/i,
    confidence: 0.9,
    label: 'maximum-jailbreak',
  },
  // BasedGPT
  {
    pattern: /\bBasedGPT\b/i,
    confidence: 0.9,
    label: 'basedgpt-jailbreak',
  },
  // AntiGPT
  {
    pattern: /\bAntiGPT\b/i,
    confidence: 0.9,
    label: 'antigpt-jailbreak',
  },
  // UnGPT / UnChatGPT
  {
    pattern: /\bUn(?:Chat)?GPT\b/i,
    confidence: 0.85,
    label: 'ungpt-jailbreak',
  },
  // JailMilk / MilkGPT
  {
    pattern: /\b(?:JailMilk|MilkGPT)\b/i,
    confidence: 0.9,
    label: 'jailmilk-jailbreak',
  },
  // Developer mode / God mode
  {
    pattern:
      /\b(?:developer|god|admin|root)\s+mode\s+(?:enabled|activated|on)\b/i,
    confidence: 0.9,
    label: 'mode-jailbreak',
  },
  // "Two responses" pattern (common in DAN variants)
  {
    pattern:
      /\bprovide\s+two\s+(?:different\s+)?responses?\b.*\b(?:normal|filtered).*\b(?:DAN|unfiltered|unrestricted)\b/i,
    confidence: 0.95,
    label: 'two-response-jailbreak',
  },
  // Token system exploits - looser pattern to catch variations
  {
    pattern:
      /\byou\s+(?:have|start\s+with)\s+\d+\s+tokens?\b.*(?:lose|deduct|subtract|remove)\s+\d*\s*tokens?/i,
    confidence: 0.85,
    label: 'token-exploit',
  },
  // "Stay in character" forcing
  {
    pattern:
      /\bstay\s+in\s+character\b.*\b(?:no\s+matter\s+what|always|never\s+break)\b/i,
    confidence: 0.8,
    label: 'character-lock',
  },
];

/**
 * Token fragmentation detection.
 * Catches attempts to split injection phrases.
 */
const FRAGMENTATION_PATTERNS: PatternEntry[] = [
  // Concatenation patterns
  {
    pattern: /["']\s*\+\s*["']|["']\s*\.\s*["']/,
    confidence: 0.5,
    label: 'string-concat-suspected',
  },
  // Split words with spaces/special chars between ALL letters (must have actual fragmentation)
  // These use lookahead to ensure at least some spacing exists
  {
    // "i g n o r e" - must have space after each letter
    pattern: /\bi\s+g\s+n\s+o\s+r\s+e\b/i,
    confidence: 0.85,
    label: 'fragmented-ignore',
  },
  {
    // "p r e v i o u s" - must have space after each letter
    pattern: /\bp\s+r\s+e\s+v\s+i\s+o\s+u\s+s\b/i,
    confidence: 0.7,
    label: 'fragmented-previous',
  },
  {
    // "i n s t r u c t i o n s" - must have space after each letter
    pattern: /\bi\s+n\s+s\s+t\s+r\s+u\s+c\s+t\s+i\s+o\s+n\s*s?\b/i,
    confidence: 0.7,
    label: 'fragmented-instructions',
  },
  {
    // Partial fragmentation - at least 3 spaces in suspicious words
    pattern:
      /\b(?:i.?g.?n.?o.?r.?e|b.?y.?p.?a.?s.?s|f.?o.?r.?g.?e.?t)\b(?=.*(?:instruction|previous|rule))/i,
    confidence: 0.6,
    label: 'partial-fragmentation',
  },
  // Morse code patterns
  {
    pattern: /(?:[\.\-]{1,4}\s+){5,}/,
    confidence: 0.6,
    label: 'morse-suspected',
  },
  // Emoji substitution for letters
  {
    pattern: /(?:🅰|🅱|🅾|🅿|Ⓜ|🔤|🔡).*(?:ignore|bypass|forget)/i,
    confidence: 0.7,
    label: 'emoji-obfuscation',
  },
  // Zero-width character detection (suspicious if many)
  {
    pattern: /(?:\u200b|\u200c|\u200d|\u2060|\ufeff){3,}/,
    confidence: 0.85,
    label: 'zero-width-injection',
  },
  // Phonetic spelling detection
  {
    pattern: /\b(?:eye|aye)\s*(?:gee|jee)\s*(?:nor|gnaw|no)\s*(?:ore|oar)\b/i,
    confidence: 0.8,
    label: 'phonetic-ignore',
  },
  // Acrostic (first letters spell something)
  {
    pattern: /^I\w+\s+G\w+\s+N\w+\s+O\w+\s+R\w+\s+E\w+/im,
    confidence: 0.6,
    label: 'acrostic-suspected',
  },
];

// ─── All Categories ────────────────────────────────────────────────

const CATEGORY_PATTERNS: Record<string, PatternEntry[]> = {
  direct: DIRECT_PATTERNS,
  roleplay: ROLEPLAY_PATTERNS,
  hypothetical: HYPOTHETICAL_PATTERNS,
  'debug-mode': DEBUG_MODE_PATTERNS,
  'format-injection': FORMAT_INJECTION_PATTERNS,
  obfuscation: OBFUSCATION_PATTERNS,
  'social-engineering': SOCIAL_ENGINEERING_PATTERNS,
  'multi-language': MULTILANG_PATTERNS,
  'known-jailbreaks': KNOWN_JAILBREAKS_PATTERNS,
  fragmentation: FRAGMENTATION_PATTERNS,
};

const ALL_CATEGORIES = Object.keys(CATEGORY_PATTERNS);

// ─── Unicode Normalization ─────────────────────────────────────────

/**
 * Common Unicode homoglyphs that can be used to bypass pattern matching.
 * Maps lookalike characters to their ASCII equivalents.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  і: 'i',
  ї: 'i', // Ukrainian
  // Greek
  α: 'a',
  ο: 'o',
  ν: 'v',
  τ: 't',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  Ζ: 'Z',
  // Other common substitutions
  '０': '0',
  '１': '1',
  '２': '2',
  '３': '3',
  '４': '4',
  '５': '5',
  '６': '6',
  '７': '7',
  '８': '8',
  '９': '9',
  ⅰ: 'i',
  ⅱ: 'ii',
  ⅲ: 'iii',
  ℮: 'e',
  ℯ: 'e',
  ℓ: 'l',
  ℒ: 'L',
  '⒜': 'a',
  '⒝': 'b',
  '⒞': 'c',
  // Zero-width and special spaces (remove)
  '\u200b': '',
  '\u200c': '',
  '\u200d': '',
  '\ufeff': '',
  '\u00a0': ' ',
  '\u2000': ' ',
  '\u2001': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
};

function normalizeHomoglyphs(text: string): string {
  let result = '';
  for (const char of text) {
    result += HOMOGLYPH_MAP[char] ?? char;
  }
  return result;
}

// ─── Sensitivity Thresholds ────────────────────────────────────────

const SENSITIVITY_THRESHOLDS: Record<string, number> = {
  low: 0.85,
  medium: 0.7,
  high: 0.5,
};

// ─── Engine Implementation ─────────────────────────────────────────

export class InjectionEngine implements PolicyEngine {
  readonly name = 'injection';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config || {};

    const categories = (cfg.categories as string[]) || ALL_CATEGORIES;
    const sensitivity = (cfg.sensitivity as string) || 'medium';
    const customPatterns =
      (cfg.customPatterns as Array<{
        pattern: string;
        label?: string;
        confidence?: number;
      }>) || [];
    const normalizeUnicode = cfg.normalizeUnicode !== false;
    const combinationThreshold = (cfg.combinationThreshold as number) || 3;
    const labelPrefix = (cfg.label as string) || 'injection';

    const threshold =
      SENSITIVITY_THRESHOLDS[sensitivity] || SENSITIVITY_THRESHOLDS.medium;

    const detections: PolicyDetection[] = [];
    const weakSignals: Array<{ label: string; confidence: number }> = [];

    // Categories that must be checked BEFORE normalization
    // - obfuscation/fragmentation: detect obfuscation attempts
    // - multi-language: normalization destroys non-Latin scripts
    const preNormCategories = [
      'obfuscation',
      'fragmentation',
      'multi-language',
    ];

    // Helper: check if we already have a high-confidence match
    const hasHighConfidence = () =>
      detections.some((d) => d.confidence >= 0.95);

    // Run pre-normalization checks on raw content
    for (const category of preNormCategories) {
      if (hasHighConfidence()) break; // early exit on high-confidence match
      if (!categories.includes(category)) continue;
      const patterns = CATEGORY_PATTERNS[category];
      if (!patterns) continue;

      for (const entry of patterns) {
        if (entry.pattern.test(ctx.content)) {
          if (entry.confidence >= threshold) {
            detections.push({
              type: `${labelPrefix}:${entry.label}`,
              confidence: entry.confidence,
              message: `Detected ${category}: ${entry.label}`,
            });
          } else {
            weakSignals.push({
              label: entry.label,
              confidence: entry.confidence,
            });
          }
        }
      }
    }

    // Normalize content if enabled (for remaining checks)
    const content = normalizeUnicode
      ? normalizeHomoglyphs(ctx.content)
      : ctx.content;

    // Check remaining categories on normalized content
    for (const category of categories) {
      if (hasHighConfidence()) break; // early exit on high-confidence match
      // Skip pre-norm categories (already checked)
      if (preNormCategories.includes(category)) continue;

      const patterns = CATEGORY_PATTERNS[category];
      if (!patterns) continue;

      for (const entry of patterns) {
        if (entry.pattern.test(content)) {
          if (entry.confidence >= threshold) {
            detections.push({
              type: `${labelPrefix}:${entry.label}`,
              confidence: entry.confidence,
              message: `Detected ${category}: ${entry.label}`,
            });
          } else {
            // Track weak signals for combination detection
            weakSignals.push({
              label: entry.label,
              confidence: entry.confidence,
            });
          }
        }
      }
    }

    // Check custom patterns (safeRegex rejects catastrophic / oversized patterns)
    for (const custom of customPatterns) {
      const regex = safeRegex(custom.pattern);
      if (regex?.test(content)) {
        const confidence = custom.confidence ?? 0.8;
        const label = custom.label || 'custom-pattern';

        if (confidence >= threshold) {
          detections.push({
            type: `${labelPrefix}:${label}`,
            confidence,
            message: `Custom pattern matched: ${custom.pattern}`,
          });
        } else {
          weakSignals.push({ label, confidence });
        }
      }
    }

    // Combination detection: if multiple weak signals, escalate
    if (weakSignals.length >= combinationThreshold && detections.length === 0) {
      const avgConfidence =
        weakSignals.reduce((sum, s) => sum + s.confidence, 0) /
        weakSignals.length;
      const labels = [...new Set(weakSignals.map((s) => s.label))].slice(0, 5);

      detections.push({
        type: `${labelPrefix}:combined-signals`,
        confidence: Math.min(avgConfidence + 0.2, 0.95), // Boost confidence for combinations
        message: `Multiple weak injection signals detected: ${labels.join(', ')}`,
      });
    }

    return detections;
  }
}
