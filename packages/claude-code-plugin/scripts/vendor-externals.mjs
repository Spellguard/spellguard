#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Vendor native-module externals into the plugin's own node_modules so the
// bundled hook scripts can resolve them at runtime without needing the
// workspace-root node_modules to be on the module-resolution path.
//
// Context: the esbuild bundle uses `--packages=bundle --external:better-sqlite3`
// because better-sqlite3 ships a prebuilt .node binding that can't be bundled.
// In the workspace dev layout (`node-linker=hoisted`), better-sqlite3 lives at
// `<workspace>/node_modules/better-sqlite3`. When the plugin is consumed from
// outside the workspace (e.g., bind-mounted read-only into a Docker container
// at `/opt/claude-code-plugin`), Node's resolver can't walk up to the workspace
// root, so it fails with `ERR_MODULE_NOT_FOUND`.
//
// This script copies the externals from the workspace root into the plugin's
// local node_modules, making the plugin self-contained. It runs as a post-build
// step (see package.json `build` script).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// better-sqlite3 + its runtime transitives. `prebuild-install` is install-time
// only (downloads native binaries), so it isn't needed at runtime — but
// `bindings` IS loaded by better-sqlite3/lib/database.js, and `bindings`
// in turn requires `file-uri-to-path`. Without these the runtime errors
// with "Cannot find module 'bindings'" before any work happens.
//
// node-pty is the login-relay's native PTY module (login-relay-handler.ts
// dynamically imports it; it's marked --external in build:bin so it stays a
// runtime require). On Linux it loads its compiled binary directly via
// `require('../build/Release/pty.node')` — NO `bindings`/`nan` runtime require
// (nan is build-time only) — so vendoring the package alone (with its built
// build/Release/pty.node) is self-contained, no extra transitives needed.
// Vendoring here keeps the out-of-workspace (e.g. Docker bind-mount) case
// resolvable; the npm-global managed-box install pulls it via `dependencies`.
const EXTERNALS = [
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
  'node-pty',
];

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const workspaceRoot = resolve(pluginRoot, '..', '..');

mkdirSync(resolve(pluginRoot, 'node_modules'), { recursive: true });

for (const dep of EXTERNALS) {
  const src = resolve(workspaceRoot, 'node_modules', dep);
  const dst = resolve(pluginRoot, 'node_modules', dep);
  if (!existsSync(src)) {
    console.error(
      `[vendor-externals] missing source ${src} — run \`pnpm install\` at the workspace root first.`,
    );
    process.exit(1);
  }
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  // dereference: copy actual files, not symlinks — needed because pnpm
  // hoisted-mode still uses symlinks under the hood for some layouts, and the
  // container can't follow symlinks pointing outside its mount.
  cpSync(src, dst, { recursive: true, dereference: true });
  console.log(`[vendor-externals] copied ${dep} -> ${dst}`);
}
