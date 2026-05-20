// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft Teams content normalizer.
 *
 * Strips Teams-specific markup (HTML-flavored subset + Markdown subset +
 * mention tags + HTML entities) to produce plain text for Verifier policy
 * evaluation.
 *
 * Adaptive Card body extraction (Tier 2) is intentionally out of scope —
 * OpenClaw's msteams extension surfaces cards to plugins as opaque
 * placeholder strings (e.g. `<media:document>`), so the normalizer never
 * sees card JSON.  The HTML-tag stripper below uses `\b`-delimited tag
 * names so namespaced placeholders like `<media:document>` pass through
 * untouched for the Verifier to treat as opaque — Tier 2 extraction
 * remains a future change that requires upstream OpenClaw support.
 */
import type { ContentNormalizer } from './types';

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  let out = s;
  for (const [k, v] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(k).join(v);
  }
  // Numeric entities: &#NN; and &#xNN;
  out = out.replace(/&#(\d+);/g, (_, n) =>
    String.fromCodePoint(Number.parseInt(n, 10)),
  );
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
    String.fromCodePoint(Number.parseInt(n, 16)),
  );
  return out;
}

export const msteamsNormalizer: ContentNormalizer = (
  content: string,
): string => {
  let normalized = content;

  // 1. <at>...</at> mentions — strip entirely (the @display name is not
  //    user-typed content and would cause false positives).
  //    Done BEFORE entity decoding so entity-encoded `&lt;at&gt;...&lt;/at&gt;`
  //    variants are NOT treated as mentions — that shape is attacker-supplied
  //    content disguised as markup and must be preserved for Verifier eval.
  normalized = normalized.replace(/<at\b[^>]*>[\s\S]*?<\/at>/g, '');

  // 2. <attachment>...</attachment> tags — strip entirely (same rationale
  //    as <at> — only strip raw markup, not entity-encoded forms).
  normalized = normalized.replace(
    /<attachment\b[^>]*>[\s\S]*?<\/attachment>/g,
    '',
  );
  normalized = normalized.replace(/<attachment\b[^>]*\/>/g, '');

  // 3. Decode HTML entities now that structural mentions are out of the way.
  normalized = decodeEntities(normalized);

  // 4. Code blocks — extract inner text, strip delimiters. Do this BEFORE
  //    other HTML/markdown stripping so fence markers don't get mistaken
  //    for other markup.
  normalized = normalized.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1');
  normalized = normalized.replace(/`([^`]+)`/g, '$1');
  normalized = normalized.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/g, '$1');
  normalized = normalized.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/g, '$1');

  // 5. Common HTML formatting tags — strip, keep inner text.
  //    `\b` word boundary on the tag name means namespaced placeholders
  //    like `<media:document>` (opaque Adaptive Card placeholders from
  //    OpenClaw — Tier 2 extraction is deferred) pass through untouched.
  normalized = normalized.replace(
    /<\/?(?:b|i|em|strong|u|span|div|p)\b[^>]*>/gi,
    '',
  );
  normalized = normalized.replace(/<br\s*\/?>/gi, '');

  // 6. Markdown formatting.
  //    Apply in order so bold (**) gets stripped before italic (*)
  //    to avoid partial matches on the outer asterisks of **bold**.
  normalized = normalized.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // hyperlinks
  normalized = normalized.replace(/\*\*([^*]+)\*\*/g, '$1'); // bold
  normalized = normalized.replace(/__([^_]+)__/g, '$1'); // underline / bold alt
  normalized = normalized.replace(/\*([^*]+)\*/g, '$1'); // italic
  normalized = normalized.replace(/~~([^~]+)~~/g, '$1'); // strike

  return normalized;
};
