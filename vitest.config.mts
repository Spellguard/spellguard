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
      '@spellguard/client': resolve(
        __dirname,
        'packages/client/ts/src/index.ts',
      ),
      '@openclaw/spellguard': resolve(
        __dirname,
        'packages/openclaw-plugin/src/index.ts',
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
  },
});
