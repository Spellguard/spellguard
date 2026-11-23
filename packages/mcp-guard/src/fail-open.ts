// SPDX-License-Identifier: Apache-2.0

/**
 * REM-090: `--fail-open` turns an unreachable Verifier into an allow, so every
 * tool call passes unscanned. A guard starts that way only when the operator
 * also sets this variable to `true`; a copied command line or a stale unit file
 * alone is refused.
 */
export const ALLOW_FAIL_OPEN_ENV = 'SPELLGUARD_ALLOW_FAIL_OPEN';

export type FailOpenDecision =
  | { failOpen: false }
  | { failOpen: true; warning: string }
  | { refused: true; message: string };

export function resolveFailOpen(
  requested: boolean,
  env: Record<string, string | undefined>,
): FailOpenDecision {
  if (!requested) return { failOpen: false };
  if (env[ALLOW_FAIL_OPEN_ENV] !== 'true') {
    return {
      refused: true,
      message: `Error: --fail-open lets every tool call through unscanned when the Verifier is unreachable. Set ${ALLOW_FAIL_OPEN_ENV}=true as well to start this way.`,
    };
  }
  return {
    failOpen: true,
    warning: `[mcp-guard] WARNING: FAIL-OPEN mode (${ALLOW_FAIL_OPEN_ENV}=true). When the Verifier is unreachable, tool calls pass unscanned.`,
  };
}
