import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * `cloudflare:workers` is a runtime-only module provided by workerd; vitest
 * (running on Node) cannot resolve it. Integration tests that import worker
 * route modules (which transitively import partyserver → cloudflare:workers)
 * need this stub so the module graph resolves. The stub is a no-op — the
 * actual DurableObject behavior in these tests runs via unstable_dev.
 */
function cloudflareWorkersStubPlugin(): Plugin {
  return {
    name: 'cloudflare-workers-stub',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'cloudflare:workers') {
        return '\0virtual:cloudflare-workers';
      }
    },
    load(id) {
      if (id === '\0virtual:cloudflare-workers') {
        return `
export class DurableObject {
  constructor(state, env) {
    this.state = state;
    this.ctx = state;
    this.env = env;
  }
}
export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export const env = {};
`;
      }
    },
  };
}

/**
 * Integration / E2E test configuration.
 *
 * These tests mutate shared state on the management server (agent policies,
 * audit logs, etc.). Running them in parallel causes race conditions —
 * e.g. one suite bumps the policy version while another is asserting on it.
 *
 * `fileParallelism: false` ensures test files run one at a time.
 *
 * Usage:
 *   pnpm run test:integration
 */

// Load .env.agents into process.env so integration
// test helpers pick up local dev defaults (SUPABASE_URL etc.) and channel-specific
// credentials (Slack/Discord bot tokens, test channel IDs). Supports multi-line
// quoted values (e.g. PEM keys).

function readEnvFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value;
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1);
}

type EnvEntry = { key: string; value: string };
type ParseState =
  | { kind: 'idle' }
  | { kind: 'multiline'; key: string; buf: string };

function startsMultiline(value: string): boolean {
  return value.startsWith('"') && value.length > 1 && !value.endsWith('"');
}

function parseSingleLine(line: string): EnvEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq === -1) return null;
  return { key: trimmed.slice(0, eq), value: trimmed.slice(eq + 1) };
}

function stepParser(
  state: ParseState,
  line: string,
  entries: EnvEntry[],
): ParseState {
  if (state.kind === 'multiline') {
    const buf = `${state.buf}\n${line}`;
    if (line.trimEnd().endsWith('"')) {
      entries.push({ key: state.key, value: stripSurroundingQuotes(buf) });
      return { kind: 'idle' };
    }
    return { kind: 'multiline', key: state.key, buf };
  }

  const parsed = parseSingleLine(line);
  if (!parsed) return state;
  if (startsMultiline(parsed.value)) {
    return { kind: 'multiline', key: parsed.key, buf: parsed.value };
  }
  entries.push({
    key: parsed.key,
    value: stripSurroundingQuotes(parsed.value),
  });
  return state;
}

function parseEnvEntries(raw: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  let state: ParseState = { kind: 'idle' };
  for (const line of raw.split('\n')) {
    state = stepParser(state, line, entries);
  }
  return entries;
}

function loadEnvFile(path: string): void {
  const raw = readEnvFile(path);
  if (raw === null) return;
  for (const { key, value } of parseEnvEntries(raw)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(resolve(__dirname, '.env.agents'));

export default defineConfig({
  plugins: [react(), cloudflareWorkersStubPlugin()],
  resolve: {
    alias: {
      '@spellguard/client': resolve(
        __dirname,
        'packages/client/ts/src/index.ts',
      ),
      '@spellguard/openclaw-plugin': resolve(
        __dirname,
        'packages/openclaw-plugin/src/index.ts',
      ),
      '@spellguard/verifier': resolve(
        __dirname,
        'packages/verifier/src/index.ts',
      ),
      '@spellguard/amp/profile': resolve(
        __dirname,
        'packages/amp/ts/src/profile/index.ts',
      ),
      '@spellguard/ctls': resolve(__dirname, 'packages/ctls/ts/src'),
      '@spellguard/policy-sdk/testing': resolve(
        __dirname,
        'packages/policy-sdk/src/testing/index.ts',
      ),
      '@spellguard/policy-sdk': resolve(
        __dirname,
        'packages/policy-sdk/src/index.ts',
      ),
      '@spellguard/policy-catalog': resolve(
        __dirname,
        'packages/policy-catalog/src/index.ts',
      ),
      '@spellguard/agent-control': resolve(
        __dirname,
        'packages/agent-control/src/index.ts',
      ),
      '@spellguard/claude-code-plugin': resolve(
        __dirname,
        'packages/claude-code-plugin/src/index.ts',
      ),
    },
  },
  test: {
    include: ['tests/**/*integration*.test.ts', 'tests/**/*e2e*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    testTimeout: 180000,
    hookTimeout: 30000,
    fileParallelism: false,
    server: {
      deps: {
        // partyserver's dist/index.js has a bare `import ... from
        // "cloudflare:workers"` at the top of the file. Because
        // partyserver is a node_module, vite externalises it by default
        // and Node's ESM loader fails with ERR_UNSUPPORTED_ESM_URL_SCHEME
        // before the cloudflareWorkersStubPlugin resolveId hook can
        // intercept it. Inlining partyserver forces vite to transform it
        // through the module graph, letting the stub resolve correctly.
        inline: ['partyserver'],
      },
    },
  },
});
