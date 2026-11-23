import type { RenderInput } from './render-message';
/**
 * Build the `additionalContext` string a SessionStart hook should emit on
 * stdout so a user-actionable Spellguard status reaches the user.
 *
 * Codex's SessionStart output contract accepts plain stdout as extra developer
 * context. We deliberately use that stable form: Codex 0.142 rejected the
 * optional JSON hookSpecificOutput envelope during a real installed-plugin run
 * even though newer documentation accepts it. renderMessage writes the human
 * banner to stderr, but a clean-exit hook's stderr is not shown crisply to the
 * user, so we forward actionable (error/warn) messages as plain additional
 * context, framed as an explicit relay-to-the-user instruction. The
 * complementary hard-stop is the git-credential helper, which prints the same
 * message to stderr exactly when git needs the token.
 *
 * Mirrors the Claude Code plugin's `sessionStartAdditionalContext`; the two
 * SessionStart wrappers + this framing helper are a sanctioned CLI-specific
 * parity delta (see scripts/verify-codex-claude-parity.sh).
 *
 * Returns `null` for a purely informational run (healthy credential /
 * identity-only / "not configured" info) — nothing to relay.
 */
export declare function sessionStartAdditionalContext(messages: readonly RenderInput[]): string | null;
