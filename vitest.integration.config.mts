import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import {
  computeInheritedKeys,
  mergeEnvEntries,
  parseEnvSource,
} from './vitest.env-precedence.mts';

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
export class WorkerEntrypoint {
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

// A key present in process.env with an EMPTY-STRING value (e.g. a CI job or
// shell exporting `MANAGEMENT_PRIVATE_KEY=` as an unset placeholder) is
// treated as ABSENT, not explicitly set — only a non-empty value claims
// precedence over the env files loaded below. Otherwise an empty placeholder
// permanently blocks the real value from packages/management/.env /
// .dev.vars and signed integration tests fail with auth errors. The precedence
// rules live in ./vitest.env-precedence.mts so they can be unit-tested without
// the gitignored local secret files.
const inheritedEnvKeys = computeInheritedKeys(process.env);

function loadEnvFile(path: string, overrideLoaded = false): void {
  const raw = readEnvFile(path);
  if (raw === null) return;
  mergeEnvEntries(
    process.env,
    parseEnvSource(raw),
    inheritedEnvKeys,
    overrideLoaded,
  );
}

// Wrangler's local management worker uses .dev.vars. Let those values win
// over values loaded from the legacy package .env so signed integration
// requests use the same key and service configuration as the worker/verifier
// pair under test. Explicit values inherited from the runner always win.
loadEnvFile(resolve(__dirname, 'packages/management/.dev.vars'), true);
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
    // isolate-real-home: HOME is a temp dir for every test process, with the
    // toolchain caches pinned, and the run fails if the real ~/.gitconfig
    // changes (#1136). Tests that must READ the operator's real setup (a local
    // OpenClaw gateway's config) use SPELLGUARD_TEST_REAL_HOME.
    // fixture-daemon-reaper: a spawned credential-daemon fixture cannot
    // outlive the run, even an interrupted one (#1144).
    globalSetup: [
      'tests/setup/isolate-real-home.ts',
      'tests/setup/fixture-daemon-reaper.ts',
    ],
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
