// SPDX-License-Identifier: Apache-2.0

/**
 * Linear-time replacements for regexes that ran on message content.
 *
 * Each function returns exactly what the regex in its doc comment returns, but
 * scans the text once. The regexes retried from every candidate start, so a
 * message built from many unclosed candidates ("tool_calls":[ with no `]`,
 * <http:// with no `>`) cost quadratic time in the Verifier's request path.
 * Tests hold each function to its regex on random inputs.
 */

const SPACE = /\s/;

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && SPACE.test(text[i])) i++;
  return i;
}

/**
 * The text between `"<key>": [` and the first `]` after it, for the first
 * occurrence of the key followed by `:` and `[`. Equivalent to
 * `text.match(/"<key>"\s*:\s*\[([^\]]*)\]/)?.[1] ?? null`.
 */
export function bracketListAfterKey(text: string, key: string): string | null {
  const needle = `"${key}"`;
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  ) {
    let i = skipSpace(text, at + needle.length);
    if (text[i] !== ':') continue;
    i = skipSpace(text, i + 1);
    if (text[i] !== '[') continue;
    const close = text.indexOf(']', i + 1);
    // No `]` after this `[` means none after any later one either.
    return close === -1 ? null : text.slice(i + 1, close);
  }
  return null;
}

/** `(http://` or `(https://` at `at`: the index after it, or -1. */
function afterUrlScheme(text: string, at: number, open: string): number {
  if (!text.startsWith(`${open}http`, at)) return -1;
  let i = at + open.length + 4;
  if (text[i] === 's') i++;
  return text.startsWith('://', i) ? i + 3 : -1;
}

/**
 * The first index at or after `from` whose character is a stop (text.length
 * if none). Queries must never decrease: each answer is reused while it is
 * still ahead, so the text is scanned once across all queries.
 */
function forwardScanner(
  text: string,
  isStop: (ch: string) => boolean,
): (from: number) => number {
  let found = -1;
  return (from) => {
    if (found < from) {
      found = from;
      while (found < text.length && !isStop(text[found])) found++;
    }
    return found;
  };
}

const MD_LINK_TEXT_MAX = 500;
const MD_LINK_URL_MAX = 2000;

/**
 * Counts Markdown links to a web URL. Equivalent to
 * `text.match(/\[[^\]\n]{0,500}\]\(https?:\/\/[^\s)]{1,2000}\)/g)?.length ?? 0`.
 */
export function countMarkdownLinks(text: string): number {
  const nextTextStop = forwardScanner(text, (ch) => ch === ']' || ch === '\n');
  const nextUrlStop = forwardScanner(
    text,
    (ch) => ch === ')' || SPACE.test(ch),
  );
  // The end of the link whose text closes at `close`, or -1. `close` never
  // decreases between calls, so neither does the URL start.
  const linkEnd = (close: number): number => {
    const url = afterUrlScheme(text, close + 1, '(');
    if (url === -1) return -1;
    const stop = nextUrlStop(url);
    const length = stop - url;
    return length >= 1 && length <= MD_LINK_URL_MAX && text[stop] === ')'
      ? stop + 1
      : -1;
  };
  let count = 0;
  let open = text.indexOf('[');
  while (open !== -1) {
    const close = nextTextStop(open + 1);
    const end =
      text[close] === ']' && close - open - 1 <= MD_LINK_TEXT_MAX
        ? linkEnd(close)
        : -1;
    if (end === -1) {
      open = text.indexOf('[', open + 1);
    } else {
      count++;
      open = text.indexOf('[', end);
    }
  }
  return count;
}

/**
 * Counts `<http://…>` and `<https://…>` autolinks. Equivalent to
 * `text.match(/<https?:\/\/[^>]+>/g)?.length ?? 0`.
 */
export function countAngleBracketUrls(text: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf('<http', from);
    if (open === -1) return count;
    const url = afterUrlScheme(text, open, '<');
    if (url === -1) {
      from = open + 1;
      continue;
    }
    const close = text.indexOf('>', url);
    // No `>` after this URL means none after any later one either.
    if (close === -1) return count;
    if (close === url) {
      // `[^>]+` needs at least one character.
      from = open + 1;
      continue;
    }
    count++;
    from = close + 1;
  }
}
