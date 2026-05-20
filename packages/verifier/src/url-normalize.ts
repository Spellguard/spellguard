// SPDX-License-Identifier: Apache-2.0

/**
 * Normalize a URL for safe comparison.
 *
 * - Strips trailing slashes from the pathname
 * - Removes default ports (443 for HTTPS, 80 for HTTP)
 * - Returns `origin + pathname` so query strings / fragments are ignored
 *
 * Falls back to the original string when the input is not a valid URL.
 */
export function normalizeAgentUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slashes from pathname
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    // Remove default ports
    if (
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    ) {
      parsed.port = '';
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}
