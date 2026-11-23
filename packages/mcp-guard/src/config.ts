// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from 'node:util';
import { isEnvName, isReservedName } from './child-env';
import { resolveFailOpen } from './fail-open';
import type { McpGuardConfig } from './types';
import { VERSION } from './version';

export const USAGE = `mcp-guard ${VERSION}: Spellguard policy guard for MCP servers

Usage:
  mcp-guard [options] -- <command> [args...]   guard a local stdio MCP server
  mcp-guard [options] --upstream <url>         guard a remote MCP server

Every tool call is checked against your Spellguard policies before it reaches
the server, and every result is checked before it reaches your agent. Tools
your policies don't allow are hidden from the tool list.

Options:
  --base-url <url>          Spellguard API URL (or SPELLGUARD_BASE_URL),
                            for example https://console.spellguard.ai
  --upstream <url>          Remote MCP server (Streamable HTTP, then SSE)
  --upstream-token <token>  Bearer token for the upstream
                            (or SPELLGUARD_UPSTREAM_TOKEN)
  --pass-env <NAME[,NAME]>  Pass these environment variables to the wrapped
                            server (or SPELLGUARD_PASS_ENV). Repeatable.
                            The server gets only PATH, HOME, locale, proxy
                            settings and the names listed here.
  --wrap "<command>"        Older form of "-- <command>"; split on spaces
  --workspace <name>        Workspace label for the connection
                            (or SPELLGUARD_WORKSPACE)
  --verifier-timeout <ms>   Verifier request timeout (default 5000)
  --fail-open               Let calls through unscanned when the Verifier
                            can't be reached. Also needs
                            SPELLGUARD_ALLOW_FAIL_OPEN=true.
  -h, --help                Show this help
  -v, --version             Show the version

Required environment:
  SPELLGUARD_AGENT_ID       The agent this guard acts for (ID or UUID)
  SPELLGUARD_AGENT_SECRET   That agent's secret
`;

export type ParsedCli =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; config: McpGuardConfig; warnings: string[] };

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'host.docker.internal',
]);

/**
 * Normalize the Spellguard API base URL. Accepts an origin
 * (`https://console.spellguard.ai`) or a URL that already ends in `/v1`, and
 * returns the `/v1` form the guard joins request paths onto.
 */
export function normalizeBaseUrl(
  raw: string,
): { ok: true; url: string; warning?: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {
      ok: false,
      error: `Spellguard base URL "${raw}" is not a URL. Use the address of your Spellguard console, for example https://console.spellguard.ai`,
    };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      error: `Spellguard base URL must use https (got ${url.protocol})`,
    };
  }
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/v1')) path = `${path}/v1`;
  url.pathname = path;
  const normalized = url.toString().replace(/\/+$/, '');
  const warning =
    url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)
      ? `Warning: ${normalized} is plain http; the agent secret is sent unencrypted. Use https.`
      : undefined;
  return { ok: true, url: normalized, warning };
}

function validateUpstreamUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? null
      : `--upstream must be an http(s) URL (got ${url.protocol})`;
  } catch {
    return `--upstream "${raw}" is not a URL`;
  }
}

function parsePassEnv(
  values: string[],
): { ok: true; names: string[] } | { ok: false; error: string } {
  const names: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const name = part.trim();
      if (!name) continue;
      if (!isEnvName(name)) {
        return {
          ok: false,
          error: `--pass-env: "${name}" is not an environment variable name`,
        };
      }
      if (isReservedName(name)) {
        return {
          ok: false,
          error: `--pass-env: ${name} is the guard's own setting and is never passed to the wrapped server`,
        };
      }
      if (!names.includes(name)) names.push(name);
    }
  }
  return { ok: true, names };
}

/**
 * Turn argv and the environment into a guard configuration, or a usage error.
 * Pure: no I/O, so every rule is unit-testable.
 */
export function parseCli(
  argv: string[],
  env: Record<string, string | undefined>,
): ParsedCli {
  const separator = argv.indexOf('--');
  const guardArgs = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);

  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: guardArgs,
      options: {
        upstream: { type: 'string' },
        'upstream-token': { type: 'string' },
        wrap: { type: 'string' },
        'pass-env': { type: 'string', multiple: true },
        workspace: { type: 'string' },
        'fail-open': { type: 'boolean', default: false },
        'verifier-timeout': { type: 'string' },
        'base-url': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      message: `${message}\nPut the server command after "--", for example: mcp-guard -- npx -y @modelcontextprotocol/server-everything\nRun mcp-guard --help for usage.`,
    };
  }

  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const warnings: string[] = [];
  const agentId = env.SPELLGUARD_AGENT_ID?.trim();
  const agentSecret = env.SPELLGUARD_AGENT_SECRET;
  if (!agentId || !agentSecret) {
    return {
      kind: 'error',
      message:
        "SPELLGUARD_AGENT_ID and SPELLGUARD_AGENT_SECRET must be set. Copy them from the agent's Connections tab in the Spellguard console.",
    };
  }

  const rawBase =
    (values['base-url'] as string | undefined) ?? env.SPELLGUARD_BASE_URL;
  if (!rawBase) {
    return {
      kind: 'error',
      message:
        'Set SPELLGUARD_BASE_URL (or --base-url) to your Spellguard console address, for example https://console.spellguard.ai',
    };
  }
  const base = normalizeBaseUrl(rawBase);
  if (!base.ok) return { kind: 'error', message: base.error };
  if (base.warning) warnings.push(base.warning);

  const upstream = values.upstream as string | undefined;
  const wrap = values.wrap as string | undefined;
  if (wrap !== undefined && wrap.trim() === '') {
    return {
      kind: 'error',
      message:
        '--wrap needs a command, for example: --wrap "npx -y @modelcontextprotocol/server-everything"',
    };
  }
  const modes = [
    upstream !== undefined,
    wrap !== undefined,
    command.length > 0,
  ].filter(Boolean).length;
  if (modes === 0) {
    return {
      kind: 'error',
      message:
        'Nothing to guard. Put a local server command after "--" (mcp-guard -- npx -y <server>) or pass --upstream <url>. Run mcp-guard --help for usage.',
    };
  }
  if (modes > 1) {
    return {
      kind: 'error',
      message:
        'Use exactly one of: a command after "--", --wrap, or --upstream.',
    };
  }

  if (upstream !== undefined) {
    const error = validateUpstreamUrl(upstream);
    if (error) return { kind: 'error', message: error };
  }

  const passEnvInputs = [
    ...((values['pass-env'] as string[] | undefined) ?? []),
    ...(env.SPELLGUARD_PASS_ENV ? [env.SPELLGUARD_PASS_ENV] : []),
  ];
  const passEnv = parsePassEnv(passEnvInputs);
  if (!passEnv.ok) return { kind: 'error', message: passEnv.error };
  if (upstream !== undefined && passEnv.names.length > 0) {
    warnings.push(
      '--pass-env applies only to a wrapped local server; ignored with --upstream.',
    );
  }

  let verifierTimeout = 5000;
  const rawTimeout = values['verifier-timeout'] as string | undefined;
  if (rawTimeout !== undefined) {
    verifierTimeout = Number(rawTimeout);
    if (!Number.isInteger(verifierTimeout) || verifierTimeout <= 0) {
      return {
        kind: 'error',
        message: `--verifier-timeout must be a positive number of milliseconds (got "${rawTimeout}")`,
      };
    }
  }

  const failOpen = resolveFailOpen(Boolean(values['fail-open']), env);
  if ('refused' in failOpen)
    return { kind: 'error', message: failOpen.message };
  if (failOpen.failOpen) {
    warnings.push(failOpen.warning.replace(/^\[mcp-guard\] /, ''));
  }

  let wrapCommand: string | undefined;
  let wrapArgs: string[] | undefined;
  if (command.length > 0) {
    [wrapCommand, ...wrapArgs] = command;
  } else if (wrap !== undefined) {
    [wrapCommand, ...wrapArgs] = wrap.trim().split(/\s+/);
  }

  return {
    kind: 'run',
    warnings,
    config: {
      agentId,
      agentSecret,
      managementUrl: base.url,
      upstreamUrl: upstream,
      upstreamToken:
        (values['upstream-token'] as string | undefined) ??
        env.SPELLGUARD_UPSTREAM_TOKEN,
      wrapCommand,
      wrapArgs,
      passEnv: passEnv.names,
      workspace:
        (values.workspace as string | undefined) ?? env.SPELLGUARD_WORKSPACE,
      failOpen: failOpen.failOpen,
      verifierTimeout,
    },
  };
}
