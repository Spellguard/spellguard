// SPDX-License-Identifier: Apache-2.0

/**
 * Discord content normalizer.
 *
 * Strips Discord-specific markup from message content to produce plain text
 * suitable for Verifier policy evaluation. Code blocks are extracted (text
 * preserved, delimiters stripped) to prevent injection bypass.
 *
 * See QA runbook: UT-007 through UT-013, ET-014
 */
import type { ContentNormalizer } from './types';

/**
 * Extract text content from a Discord embed object.
 *
 * NOTE: This function is currently not wired into the normalization pipeline.
 * The ContentNormalizer type accepts only strings, and it is not yet confirmed
 * whether OpenClaw's before_dispatch event stringifies embed data into
 * event.content. If embeds arrive as structured metadata, a separate code path
 * in the inbound hook would need to call this function and prepend the
 * extracted text before evaluation. Exported for testing (UT-012) and future
 * integration.
 *
 * Extracts: title, description, field.name, field.value, footer.text, author.name
 * Excludes: url, thumbnail.url, image.url (URL-only fields)
 */
export function extractEmbedText(embed: Record<string, unknown>): string {
  const parts: string[] = [];

  if (typeof embed.title === 'string') parts.push(embed.title);
  if (typeof embed.description === 'string') parts.push(embed.description);

  if (Array.isArray(embed.fields)) {
    for (const field of embed.fields) {
      if (field && typeof field === 'object') {
        const f = field as Record<string, unknown>;
        if (typeof f.name === 'string') parts.push(f.name);
        if (typeof f.value === 'string') parts.push(f.value);
      }
    }
  }

  const footer = embed.footer as Record<string, unknown> | undefined;
  if (footer && typeof footer.text === 'string') parts.push(footer.text);

  const author = embed.author as Record<string, unknown> | undefined;
  if (author && typeof author.name === 'string') parts.push(author.name);

  return parts.join(' ');
}

export const discordNormalizer: ContentNormalizer = (
  content: string,
): string => {
  let normalized = content;

  // 1. Code blocks — extract inner text, strip delimiters and language tag
  //    MUST be done before other markdown stripping to avoid partial matches
  normalized = normalized.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1');

  // 2. Inline code — strip backtick delimiters
  normalized = normalized.replace(/`([^`]+)`/g, '$1');

  // 3. Spoiler tags — strip || delimiters, expose hidden text
  normalized = normalized.replace(/\|\|(.+?)\|\|/g, '$1');

  // 4. Hyperlinks — keep link text, drop URL
  normalized = normalized.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 5. User mentions: <@id>, <@!id> (nickname)
  normalized = normalized.replace(/<@!?\d+>/g, '');

  // 6. Channel mentions: <#id>
  normalized = normalized.replace(/<#\d+>/g, '');

  // 7. Role mentions: <@&id>
  normalized = normalized.replace(/<@&\d+>/g, '');

  // 8. Custom emoji: <:name:id> and animated <a:name:id>
  normalized = normalized.replace(/<a?:\w+:\d+>/g, '');

  // 9. Bold: **text** (before italic to avoid conflict)
  normalized = normalized.replace(/\*\*(.+?)\*\*/g, '$1');

  // 10. Underline: __text__ (before italic _ to avoid conflict)
  normalized = normalized.replace(/__(.+?)__/g, '$1');

  // 11. Bold italic: ***text*** (handle remaining triple asterisks)
  normalized = normalized.replace(/\*\*\*(.+?)\*\*\*/g, '$1');

  // 12. Italic: *text* or _text_
  normalized = normalized.replace(/\*(.+?)\*/g, '$1');
  normalized = normalized.replace(/_(.+?)_/g, '$1');

  // 13. Strikethrough: ~~text~~
  normalized = normalized.replace(/~~(.+?)~~/g, '$1');

  return normalized.trim();
};
