/**
 * Per-agent `gh` CLI config directory: `<configDir>/gh/<agentId>`.
 *
 * `gh` honors the `GH_CONFIG_DIR` env var (session-scoped, never the developer's
 * real `~/.config/gh`) and re-reads `hosts.yml` on EVERY invocation. So pointing
 * `GH_CONFIG_DIR` here and having the daemon rewrite `hosts.yml` on rotation makes
 * a fresh scoped token available to the next `gh` call with no restart — the gh
 * analog of the git credential helper's live-file read.
 *
 * Signature `(configDir, agentId)` so the per-framework isolation follow-up can
 * pass a framework-scoped `configDir` unchanged (`<frameworkDir>/gh/<agentId>`).
 *
 * NOTE: mirror of `packages/claude-code-plugin/src/lib/gh-config-dir.ts` — keep
 * the two byte-identical (verify-codex-claude-parity).
 */
export declare function ghConfigDirPath(configDir: string, agentId: string): string;
/**
 * Write/refresh the session `gh` config so `gh api` / `gh pr create` authenticate
 * with the scoped token.
 *
 * - `hosts.yml` carries the current token; rewritten ATOMICALLY (temp+rename) on
 *   every rotation so a concurrent `gh` read never sees a half-written file.
 * - `config.yml` carries a `version:` marker, written ONCE. Without it `gh` runs a
 *   one-time multi-account migration that makes a BLOCKING online `CurrentUser`
 *   API call — which fails for a server-to-server installation token and breaks
 *   every `gh` call in the session.
 */
export declare function writeGhSessionConfig(args: {
    dir: string;
    token: string;
    host?: string;
}): void;
/**
 * Remove the session token on revoke/reset. `gh` then has no login in this dir
 * (fails closed inside the agent only). `config.yml` is left so a later
 * re-provision needs no migration.
 */
export declare function clearGhSessionConfig(dir: string): void;
