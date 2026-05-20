// SPDX-License-Identifier: Apache-2.0

/**
 * URL policy engine.
 *
 * Controls what URLs agents can send by checking against blocklists/allowlists
 * and detecting suspicious patterns (IP URLs, bad TLDs, shorteners, etc.).
 *
 * Config shape (on binding.config):
 *   mode: 'blocklist' | 'allowlist'  — operation mode
 *
 *   Blocklist mode:
 *     blockSuspicious?: boolean      — flag IP URLs, bad TLDs (default: true)
 *     blockShorteners?: boolean      — block URL shorteners (default: false)
 *     blockedDomains?: string[]      — explicit domain blocklist
 *     suspiciousTlds?: string[]      — override default suspicious TLD list
 *     shortenerDomains?: string[]    — override default shortener domain list
 *     blockIpHosts?: boolean          — block IP-based URLs (default: true)
 *     blockUserinfoUrls?: boolean     — block URLs with @ userinfo (default: true)
 *
 *   Allowlist mode:
 *     allowedDomains?: string[]      — only these domains permitted
 *
 *   Common:
 *     requireHttps?: boolean          — reject non-HTTPS URLs (default: false)
 *     detectBareDomains?: boolean     — detect domains without protocol (default: false)
 *     label?: string                  — detection label, default: 'url-violation'
 *
 * Example binding config:
 *   {
 *     "mode": "blocklist",
 *     "blockSuspicious": true,
 *     "blockShorteners": true,
 *     "blockedDomains": ["evil.com"],
 *     "requireHttps": true
 *   }
 */

import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

// Regex to extract URLs from text
const URL_PATTERN =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

// Common TLDs for bare domain detection (no protocol prefix)
const BARE_DOMAIN_TLDS = new Set([
  'com',
  'net',
  'org',
  'biz',
  'info',
  'io',
  'co',
  'me',
  'dev',
  'app',
  'ai',
  'tech',
  'security',
  'cloud',
  'online',
  'site',
  'xyz',
  'top',
  'click',
  'link',
  'work',
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
]);

const COMMON_CC_SECOND_LEVEL_TLDS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gov',
  'net',
  'org',
]);

const BARE_DOMAIN_PATTERN =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}\b/gi;

// Default suspicious TLDs often used for phishing/spam
const DEFAULT_SUSPICIOUS_TLDS = new Set([
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'work',
  'click',
  'link',
  'xyz',
  'top',
]);

// Default URL shortener domains
const DEFAULT_URL_SHORTENERS = new Set([
  'bit.ly',
  't.co',
  'goo.gl',
  'tinyurl.com',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'adf.ly',
  'bit.do',
  'mcaf.ee',
  'su.pr',
  'tny.im',
  'tiny.cc',
  'bc.vc',
  'budurl.com',
  'clicky.me',
  'cutt.ly',
  'rb.gy',
  'short.link',
  's.id',
]);

interface ParsedUrl {
  original: string;
  protocol: string;
  hostname: string;
  domain: string;
}

/**
 * Extract hostname and root domain from URL string.
 */
function parseUrl(urlStr: string): ParsedUrl | null {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    const parts = hostname.split('.');

    // Extract root domain (last two parts, or just hostname if single-part)
    const domain = parts.length >= 2 ? parts.slice(-2).join('.') : hostname;

    return {
      original: urlStr,
      protocol: url.protocol,
      hostname,
      domain,
    };
  } catch {
    return null;
  }
}

/**
 * Check if URL uses an IP address instead of domain name.
 */
function isIpAddress(hostname: string): boolean {
  // IPv4 pattern
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(hostname)) return true;

  // IPv6: must contain at least two colons and only valid hex groups
  // Matches full, compressed (::), and mixed (::ffff:1.2.3.4) forms
  if (hostname.includes(':')) {
    const ipv6 =
      /^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$|^([0-9a-f]{1,4}:)*::([0-9a-f]{1,4}:)*[0-9a-f]{1,4}$|^::([0-9a-f]{1,4}:)*[0-9a-f]{1,4}$|^([0-9a-f]{1,4}:)+:$|^::$/i;
    return ipv6.test(hostname);
  }

  return false;
}

/**
 * Check if URL contains @ symbol (often used in phishing).
 */
function hasAtSymbol(urlStr: string): boolean {
  const url = new URL(urlStr);
  return url.username !== '' || urlStr.includes('@');
}

/**
 * Check if URL has suspicious TLD against the given set.
 */
function hasSuspiciousTld(parsed: ParsedUrl, tldSet: Set<string>): boolean {
  const parts = parsed.hostname.split('.');
  const tld = parts[parts.length - 1];
  return tldSet.has(tld);
}

/**
 * Check if URL is a known shortener against the given set.
 */
function isUrlShortener(parsed: ParsedUrl, shortenerSet: Set<string>): boolean {
  return shortenerSet.has(parsed.domain) || shortenerSet.has(parsed.hostname);
}

function isSupportedBareDomain(hostname: string): boolean {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length < 2) return false;

  const tld = parts[parts.length - 1];
  if (BARE_DOMAIN_TLDS.has(tld)) {
    return true;
  }

  const secondLevel = parts[parts.length - 2];
  return (
    tld.length === 2 &&
    parts.length >= 3 &&
    COMMON_CC_SECOND_LEVEL_TLDS.has(secondLevel)
  );
}

/**
 * Extract bare domain strings that are NOT already part of a full URL.
 * Returns them synthesized as http:// URLs for consistent downstream checks.
 */
function extractBareDomains(
  content: string,
  fullUrlMatches: RegExpExecArray[],
): string[] {
  const bareDomains: string[] = [];
  const bareMatches = [...content.matchAll(BARE_DOMAIN_PATTERN)];

  for (const bare of bareMatches) {
    const start = bare.index ?? 0;
    const end = start + bare[0].length;
    const bareDomain = bare[0];

    // Skip if this bare domain is inside a full URL match
    const insideFullUrl = fullUrlMatches.some((full) => {
      const fStart = full.index ?? 0;
      const fEnd = fStart + full[0].length;
      return start >= fStart && end <= fEnd;
    });

    if (insideFullUrl) {
      continue;
    }

    // Skip email domains (alice@example.com).
    if (start > 0 && content[start - 1] === '@') {
      continue;
    }

    if (!isSupportedBareDomain(bareDomain)) {
      continue;
    }

    bareDomains.push(`http://${bareDomain}`);
  }

  return bareDomains;
}

/**
 * Check if domain matches entry from list (exact or suffix match).
 */
function matchesDomain(hostname: string, listDomain: string): boolean {
  const lower = listDomain.toLowerCase();
  // Exact match
  if (hostname === lower) return true;
  // Subdomain match: foo.example.com matches example.com
  if (hostname.endsWith(`.${lower}`)) return true;
  return false;
}

export class UrlEngine implements PolicyEngine {
  readonly name = 'url';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config;
    if (!cfg) return [];

    const mode = (cfg.mode as string) || 'blocklist';
    const label = (cfg.label as string) || 'url-violation';
    const requireHttps = cfg.requireHttps === true;
    const detectBareDomains = cfg.detectBareDomains === true;

    // Extract all full URLs from content
    const fullUrlMatches = [...ctx.content.matchAll(URL_PATTERN)];

    // Collect URL strings to check: full URLs + optional bare domains
    const urlsToCheck: string[] = fullUrlMatches.map((m) => m[0]);

    if (detectBareDomains) {
      const bareDomainUrls = extractBareDomains(ctx.content, fullUrlMatches);
      urlsToCheck.push(...bareDomainUrls);
    }

    if (urlsToCheck.length === 0) {
      return [];
    }

    const detections: PolicyDetection[] = [];

    for (const urlStr of urlsToCheck) {
      const parsed = parseUrl(urlStr);
      if (!parsed) continue;

      // Check HTTPS requirement
      if (requireHttps && parsed.protocol !== 'https:') {
        detections.push({
          type: label,
          confidence: 1.0,
          message: `Non-HTTPS URL detected: ${urlStr}`,
        });
        continue;
      }

      if (mode === 'allowlist') {
        const result = this.checkAllowlist(parsed, cfg, label);
        if (result) detections.push(result);
      } else {
        const result = this.checkBlocklist(parsed, cfg, label);
        if (result) detections.push(result);
      }
    }

    return detections;
  }

  private checkAllowlist(
    parsed: ParsedUrl,
    cfg: Record<string, unknown>,
    label: string,
  ): PolicyDetection | null {
    const allowedDomains = (cfg.allowedDomains as string[]) || [];

    // If no allowlist configured, permit all
    if (allowedDomains.length === 0) return null;

    // Check if domain is in allowlist
    for (const allowed of allowedDomains) {
      if (matchesDomain(parsed.hostname, allowed)) {
        return null; // Permitted
      }
    }

    return {
      type: label,
      confidence: 1.0,
      message: `URL not in allowlist: ${parsed.domain}`,
    };
  }

  private checkBlocklist(
    parsed: ParsedUrl,
    cfg: Record<string, unknown>,
    label: string,
  ): PolicyDetection | null {
    const blockSuspicious = cfg.blockSuspicious !== false; // default: true
    const blockShorteners = cfg.blockShorteners === true;
    const blockedDomains = (cfg.blockedDomains as string[]) || [];

    // Resolve config-driven overrides (fall back to module-level defaults)
    const suspiciousTlds = cfg.suspiciousTlds
      ? new Set(cfg.suspiciousTlds as string[])
      : DEFAULT_SUSPICIOUS_TLDS;
    const shortenerDomains = cfg.shortenerDomains
      ? new Set(cfg.shortenerDomains as string[])
      : DEFAULT_URL_SHORTENERS;
    const blockIpHosts = cfg.blockIpHosts !== false; // default: true
    const blockUserinfoUrls = cfg.blockUserinfoUrls !== false; // default: true

    // Check explicit blocklist
    for (const blocked of blockedDomains) {
      if (matchesDomain(parsed.hostname, blocked)) {
        return {
          type: label,
          confidence: 1.0,
          message: `Blocked domain: ${parsed.domain}`,
        };
      }
    }

    // Check suspicious patterns
    if (blockSuspicious) {
      if (blockIpHosts && isIpAddress(parsed.hostname)) {
        return {
          type: label,
          confidence: 0.85,
          message: `Suspicious IP-based URL: ${parsed.original}`,
        };
      }

      if (blockUserinfoUrls) {
        try {
          if (hasAtSymbol(parsed.original)) {
            return {
              type: label,
              confidence: 0.85,
              message: `Suspicious URL with @ symbol: ${parsed.original}`,
            };
          }
        } catch {
          // Ignore URL parsing errors
        }
      }

      if (hasSuspiciousTld(parsed, suspiciousTlds)) {
        return {
          type: label,
          confidence: 0.85,
          message: `Suspicious TLD: ${parsed.domain}`,
        };
      }
    }

    // Check URL shorteners
    if (blockShorteners && isUrlShortener(parsed, shortenerDomains)) {
      return {
        type: label,
        confidence: 1.0,
        message: `URL shortener blocked: ${parsed.domain}`,
      };
    }

    return null;
  }
}
