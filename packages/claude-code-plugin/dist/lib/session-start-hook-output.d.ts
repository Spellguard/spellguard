import type { RenderInput } from './render-message';
/**
 * Build the `additionalContext` string a SessionStart hook should emit on
 * stdout so a user-actionable Spellguard status reaches the user.
 *
 * Why additionalContext (and not stderr / systemMessage / exit 2):
 * Claude Code has NO crisp visible SessionStart→user banner. Verified against
 * the real `claude` CLI + session transcript (2026-06-12):
 *   - clean-exit hook STDERR is captured into the transcript but NOT shown to
 *     the user;
 *   - a stdout `{systemMessage}` is IGNORED for SessionStart;
 *   - exit code 2 is WORST — Claude Code DROPS an exit-2 SessionStart hook's
 *     output entirely (no transcript attachment, stdout ignored), so neither
 *     the user nor the model sees it.
 * The ONLY channel that lands is `additionalContext`, which goes to the
 * MODEL's context. We therefore frame the actionable (error/warn) messages as
 * an explicit relay-to-the-user instruction so the model surfaces them on the
 * user's first turn. The complementary hard-stop is the git-credential helper,
 * which prints the same message to stderr exactly when git needs the token.
 *
 * Returns `null` for a purely informational run (healthy credential /
 * identity-only / "not configured" info) — nothing to relay.
 */
export declare function sessionStartAdditionalContext(messages: readonly RenderInput[]): string | null;
