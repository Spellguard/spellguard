// SPDX-License-Identifier: Apache-2.0

import type { RenderInput } from './render-message';

/**
 * Build the `additionalContext` string a SessionStart hook should emit on
 * stdout so a user-actionable Spellguard status reaches the user.
 *
 * Codex's SessionStart output contract (per the official hooks docs,
 * https://developers.openai.com/codex/hooks) accepts:
 *   { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
 * and the `additionalContext` text is added to the model's context as extra
 * developer context. (Before 2026-06-12 the codex wrapper emitted the raw
 * DaemonResult — e.g. `{ok:false,reason:'missing'}` — which violates that
 * contract, so the TUI failed the hook with "invalid session start JSON
 * output" and surfaced nothing.) renderMessage writes the human banner to
 * stderr, but a clean-exit hook's stderr is not shown crisply to the user, so
 * we forward the actionable (error/warn) messages via additionalContext, framed
 * as an explicit relay-to-the-user instruction so the model surfaces them on
 * the user's first turn. The complementary hard-stop is the git-credential
 * helper, which prints the same message to stderr exactly when git needs the
 * token.
 *
 * Mirrors the Claude Code plugin's `sessionStartAdditionalContext`; the two
 * SessionStart wrappers + this framing helper are a sanctioned CLI-specific
 * parity delta (see scripts/verify-codex-claude-parity.sh).
 *
 * Returns `null` for a purely informational run (healthy credential /
 * identity-only / "not configured" info) — nothing to relay.
 */
export function sessionStartAdditionalContext(
  messages: readonly RenderInput[],
): string | null {
  const actionable = messages.filter(
    (m) => m.level === 'error' || m.level === 'warn',
  );
  if (actionable.length === 0) return null;
  const lines = actionable.map((m) =>
    m.detail ? `${m.message} — ${m.detail}` : m.message,
  );
  return [
    'Spellguard session-start notice — relay the following to the user at the start of your reply (these are Spellguard credential states that need user action):',
    ...lines.map((l) => `• ${l}`),
  ].join('\n');
}
