// SPDX-License-Identifier: Apache-2.0

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * The environment a wrapped MCP server starts with (#1501).
 *
 * The wrapped server is third-party code. It must never see the guard's own
 * Spellguard credentials, and it should not see the rest of the host's
 * environment either: an MCP host often starts the guard with its full
 * environment (cloud keys, model API keys, tokens for other servers). So the
 * server gets an allowlist, the same way MCP hosts start servers themselves:
 *
 * - the MCP SDK's default set (PATH, HOME, USER, LOGNAME, SHELL, TERM, and
 *   the Windows equivalents), which is what `npx`-launched servers need;
 * - locale, time zone, proxy and CA settings, so the server behaves and
 *   connects like the host does;
 * - every variable the operator names with `--pass-env` (for example the
 *   server's own API token).
 *
 * Anything named `SPELLGUARD_*` is never passed, even when listed.
 */

const BASELINE_PREFIXES = ['LC_'];
const BASELINE_NAMES = [
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

export const RESERVED_PREFIX = 'SPELLGUARD_';

export function isReservedName(name: string): boolean {
  return name.toUpperCase().startsWith(RESERVED_PREFIX);
}

/** A valid environment variable name for `--pass-env`. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function buildChildEnv(
  parent: Record<string, string | undefined>,
  passEnv: readonly string[],
  defaults: Record<string, string> = getDefaultEnvironment(),
): Record<string, string> {
  const env: Record<string, string> = {};
  const take = (name: string) => {
    if (isReservedName(name)) return;
    const value = parent[name];
    if (value === undefined) return;
    // Exported shell functions are a known injection vector; the SDK skips
    // them for the same reason.
    if (value.startsWith('()')) return;
    env[name] = value;
  };

  for (const [name, value] of Object.entries(defaults)) {
    if (!isReservedName(name)) env[name] = value;
  }
  for (const name of BASELINE_NAMES) take(name);
  for (const name of Object.keys(parent)) {
    if (BASELINE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      take(name);
    }
  }
  for (const name of passEnv) take(name);
  return env;
}
