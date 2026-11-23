// SPDX-License-Identifier: Apache-2.0
//
// Bundles the published CLI and library. Dependencies stay external (npm
// installs them); the package version is baked in, so `mcp-guard --version`
// and the version the guard reports match package.json.

import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

await build({
  entryPoints: ['src/cli.ts', 'src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: 'dist',
  packages: 'external',
  define: { __MCP_GUARD_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
