#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from 'node:util';
import { McpGuardProxy } from './proxy';

const { values } = parseArgs({
  options: {
    upstream: { type: 'string' },
    'upstream-token': { type: 'string' },
    wrap: { type: 'string' },
    workspace: { type: 'string' },
    'fail-open': { type: 'boolean', default: false },
    'verifier-timeout': { type: 'string', default: '5000' },
    'base-url': { type: 'string' },
  },
  strict: false,
});

const agentId = process.env.SPELLGUARD_AGENT_ID;
const agentSecret = process.env.SPELLGUARD_AGENT_SECRET;
// Spellguard base URL. NOTE: mcp-guard joins request paths directly
// (`${url}/proxy/...`), so this value must already include the `/v1` prefix
// (e.g. http://localhost:3001/v1), unlike the origin-only agent plugins.
const managementUrl = values['base-url'] || process.env.SPELLGUARD_BASE_URL;

if (!agentId || !agentSecret) {
  console.error(
    'Error: SPELLGUARD_AGENT_ID and SPELLGUARD_AGENT_SECRET env vars are required',
  );
  process.exit(1);
}

if (!managementUrl) {
  console.error('Error: --base-url or SPELLGUARD_BASE_URL is required');
  process.exit(1);
}

if (!values.upstream && !values.wrap) {
  console.error(
    'Error: Either --upstream <url> or --wrap "<command>" is required',
  );
  process.exit(1);
}

if (values.upstream && values.wrap) {
  console.error('Error: Only one of --upstream or --wrap can be specified');
  process.exit(1);
}

const workspace =
  (values.workspace as string | undefined) || process.env.SPELLGUARD_WORKSPACE;

const upstreamToken =
  (values['upstream-token'] as string | undefined) ||
  process.env.SPELLGUARD_UPSTREAM_TOKEN;

const proxy = new McpGuardProxy({
  agentId,
  agentSecret,
  managementUrl: managementUrl as string,
  upstreamUrl: values.upstream as string | undefined,
  upstreamToken,
  wrapCommand: values.wrap as string | undefined,
  workspace,
  failOpen: Boolean(values['fail-open']),
  verifierTimeout: Number(values['verifier-timeout']),
});

proxy.start().catch((err) => {
  console.error('Failed to start MCP Guard proxy:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () =>
  proxy
    .stop()
    .catch(() => {})
    .finally(() => process.exit(0)),
);
process.on('SIGTERM', () =>
  proxy
    .stop()
    .catch(() => {})
    .finally(() => process.exit(0)),
);
