// SPDX-License-Identifier: Apache-2.0

/**
 * This framework's on-disk slug — the per-machine credential-slot path segment
 * that isolates one coding-agent framework's identity / tokens / daemon / gh dir
 * from another's (see config-store.ts `defaultConfigDir`). The ONE intended
 * per-plugin divergence, extracted out of the otherwise byte-identical
 * config-store.ts so parity stays enforceable (verify-codex-claude-parity).
 * Baked into config paths — renaming it is a migration concern.
 */
export const FRAMEWORK_SLUG = 'codex';
