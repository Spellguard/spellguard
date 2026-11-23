import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Vite 5.4 doesn't recognize `node:sqlite` as a Node built-in (it's a
 * prefix-only module added in Node 22.5). This plugin bridges the gap
 * by providing a virtual module that re-exports the native module.
 */
function nodeSqlitePlugin(): Plugin {
  return {
    name: 'node-sqlite-compat',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'node:sqlite' || id === 'sqlite') {
        return '\0virtual:node-sqlite';
      }
    },
    load(id) {
      if (id === '\0virtual:node-sqlite') {
        return `
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _sqlite = _require('node:sqlite');
export const DatabaseSync = _sqlite.DatabaseSync;
export const StatementSync = _sqlite.StatementSync;
export default _sqlite;
`;
      }
    },
  };
}

/**
 * `cloudflare:workers` is a runtime-only module provided by workerd; vitest
 * (running on Node) cannot resolve it. Stub it with a no-op `DurableObject`
 * base class so modules that import it can be unit-tested for their pure
 * exports without spinning up workerd.
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
// Workflows base class — runtime-only at deploy time; stubbed so modules that
// declare \`class X extends WorkflowEntrypoint\` can be imported under Node for
// unit-testing their pure step functions without spinning up workerd.
export class WorkflowEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
// RPC entrypoint base class — runtime-only at deploy time; stubbed (mirrors
// the same stub in vitest.integration.config.mts) so modules that declare
// \`class X extends WorkerEntrypoint\` (e.g. McpBackendEntrypoint) can be
// imported and unit-tested under Node without spinning up workerd.
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), nodeSqlitePlugin(), cloudflareWorkersStubPlugin()],
  resolve: {
    dedupe: ['jose', 'react', 'react-dom', 'react-router-dom', 'hono'],
    alias: {
      // The `/ai` subpath must precede the bare package alias: with the
      // bare alias alone, `@spellguard/client/ai` (the demo fleet's
      // spellguardTool import) cannot be resolved from a test.
      '@spellguard/client/ai': resolve(
        __dirname,
        'packages/client/ts/src/ai.ts',
      ),
      '@spellguard/client': resolve(
        __dirname,
        'packages/client/ts/src/index.ts',
      ),
      '@spellguard/openclaw-plugin': resolve(
        __dirname,
        'packages/openclaw-plugin/src/index.ts',
      ),
      // Resolve the shared agent-control client to source so leaf-module
      // vi.mock()s (packages/agent-control/src/client) intercept code that
      // imports the package by name (the daemon, the setup skill, the
      // OpenClaw credential-service).
      '@spellguard/agent-control': resolve(
        __dirname,
        'packages/agent-control/src/index.ts',
      ),
      '@spellguard/verifier': resolve(__dirname, 'packages/verifier/src'),
      '@spellguard/amp/client': resolve(
        __dirname,
        'packages/amp/ts/src/client/index.ts',
      ),
      '@spellguard/amp/server': resolve(
        __dirname,
        'packages/amp/ts/src/server/index.ts',
      ),
      '@spellguard/amp/logging': resolve(
        __dirname,
        'packages/amp/ts/src/logging/index.ts',
      ),
      '@spellguard/amp/types': resolve(
        __dirname,
        'packages/amp/ts/src/types/index.ts',
      ),
      '@spellguard/amp/profile': resolve(
        __dirname,
        'packages/amp/ts/src/profile/index.ts',
      ),
      '@spellguard/amp/policy-outcomes': resolve(
        __dirname,
        'packages/amp/ts/src/policy-outcomes.ts',
      ),
      '@spellguard/amp/policy-types': resolve(
        __dirname,
        'packages/amp/ts/src/policy-types.ts',
      ),
      '@spellguard/amp/document-limits': resolve(
        __dirname,
        'packages/amp/ts/src/document-limits.ts',
      ),
      '@spellguard/amp/agent-conduct': resolve(
        __dirname,
        'packages/amp/ts/src/agent-conduct.ts',
      ),
      '@spellguard/amp': resolve(__dirname, 'packages/amp/ts/src/index.ts'),
      '@spellguard/ctls': resolve(__dirname, 'packages/ctls/ts/src'),
      '@spellguard/policy-sdk/testing': resolve(
        __dirname,
        'packages/policy-sdk/src/testing/index.ts',
      ),
      '@spellguard/policy-sdk': resolve(
        __dirname,
        'packages/policy-sdk/src/index.ts',
      ),
      // The Demo page's demo registry, read by the demo fleet, management
      // and the dashboard (closed-only, like the fleet).
      '@spellguard/policy-catalog': resolve(
        __dirname,
        'packages/policy-catalog/src/index.ts',
      ),
      '@spellguard/langchain': resolve(
        __dirname,
        'packages/langchain/ts/src/index.ts',
      ),
      '@spellguard/openai': resolve(__dirname, 'packages/openai/src/index.ts'),
      '@tanstack/react-query': resolve(
        __dirname,
        'node_modules/@tanstack/react-query',
      ),
      '@langchain/core': resolve(__dirname, 'node_modules/@langchain/core'),
    },
  },
  test: {
    // Hermetic seal: strip host-injected git env config (a live Spellguard
    // session's own credential wiring) before any test runs — see the file.
    // stub-rive-spinner: the ui-kit Spinner's Rive runtime needs matchMedia +
    // canvas, which jsdom lacks — see the file.
    // ensure-web-storage: some local jsdom toolchains yield an undefined
    // window.localStorage — see the file.
    // drain-unmount-timers: Radix finishes an unmount from a 0 ms timer that
    // otherwise fires after jsdom teardown as an unhandled error — see the file.
    setupFiles: [
      'tests/setup/scrub-host-git-env.ts',
      'tests/setup/stub-rive-spinner.ts',
      'tests/setup/ensure-web-storage.ts',
      'tests/setup/drain-unmount-timers.ts',
    ],
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'packages/**/__tests__/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
    exclude: [
      'tests/**/*integration*.test.ts',
      'tests/**/*e2e*.test.ts',
      'tests/e2e/**',
      'tests/live-agents/**',
      '**/node_modules/**',
    ],
    testTimeout: 120000, // 2 minutes for LLM-based responses
    hookTimeout: 30000,
    server: {
      deps: {
        // `partyserver` (a node_module) imports `cloudflare:workers` at module
        // top-level. Externalized deps bypass the cloudflareWorkersStubPlugin
        // (its resolveId hook only runs on transformed sources), so inline it so
        // the stub catches its `cloudflare:workers` import. Without this, any
        // unit test that imports the full `typedApi` graph (e.g. the
        // openapi-contract guard) fails to load once a typed route transitively
        // reaches partyserver (via services/agent-control-push).
        // @spellguard/ui-kit's barrel pulls in @rive-app/react-canvas (used by
        // its Spinner). Rive is CJS and its named exports (e.g. `Alignment`)
        // aren't statically resolvable under Node ESM — inline these so vite
        // transforms them and the CJS↔ESM interop works in tests.
        // @spellguard/illustrations' React entry imports its CSS, which Node
        // can't load; inlined, vite handles the import.
        inline: [
          'partyserver',
          /@spellguard\/ui-kit/,
          /@spellguard\/illustrations/,
          /@rive-app\//,
          /framer-motion/,
          /motion-dom/,
          /motion-utils/,
        ],
      },
    },
  },
});
