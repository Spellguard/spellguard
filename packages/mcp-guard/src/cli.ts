#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { USAGE, parseCli } from './config';
import { McpGuardProxy } from './proxy';
import { VERSION } from './version';

/** How long a graceful stop may take before the guard exits anyway. */
const STOP_DEADLINE_MS = 6000;

const parsed = parseCli(process.argv.slice(2), process.env);
if (parsed.kind === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (parsed.kind === 'version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (parsed.kind === 'error') {
  console.error(`mcp-guard: ${parsed.message}`);
  process.exit(2);
}

for (const warning of parsed.warnings) console.error(`[mcp-guard] ${warning}`);

const proxy = new McpGuardProxy(parsed.config);

let stopping = false;
function shutdown(why: string, code: number): void {
  if (stopping) return;
  stopping = true;
  console.error(`[mcp-guard] Stopping: ${why}`);
  // Never linger: if a step hangs, exit anyway once the deadline passes.
  setTimeout(() => process.exit(code), STOP_DEADLINE_MS).unref();
  proxy
    .stop()
    .catch(() => {})
    .finally(() => process.exit(code));
}

proxy.onClose = (why) => shutdown(why, 0);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown(`received ${signal}`, 0));
}

proxy.start().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[mcp-guard] Failed to start: ${message}`);
  shutdown('start failed', 1);
});
