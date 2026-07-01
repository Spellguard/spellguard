/**
 * Back-compat shim for the published `@spellguard/codex-plugin/agent-control`
 * subpath export.
 *
 * The shared agent-control client now lives in the neutral
 * `@spellguard/agent-control` package; this barrel re-exports it so any
 * external consumer still importing `@spellguard/codex-plugin/agent-control`
 * keeps working. The plugin's own source imports `@spellguard/agent-control`
 * directly — this file exists purely for the public subpath's back-compat.
 *
 * It is bundled (self-contained) into `dist/lib/agent-control/index.mjs`, so the
 * published plugin carries no runtime dependency on the workspace package.
 */
export * from '@spellguard/agent-control';
