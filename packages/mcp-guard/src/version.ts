// SPDX-License-Identifier: Apache-2.0

declare const __MCP_GUARD_VERSION__: string | undefined;

/**
 * The package version. The published build (`build.mjs`) replaces
 * `__MCP_GUARD_VERSION__` with `package.json`'s version; running from source
 * (tests, `tsx`) reports a dev version instead.
 */
export const VERSION: string =
  typeof __MCP_GUARD_VERSION__ === 'string'
    ? __MCP_GUARD_VERSION__
    : '0.0.0-dev';
