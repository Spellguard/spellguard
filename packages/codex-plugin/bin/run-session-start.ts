// SPDX-License-Identifier: Apache-2.0

import { runSessionStart } from '../src/hooks/session-start';
import { drainRenderedMessages } from '../src/lib/render-message';
import { sessionStartAdditionalContext } from '../src/lib/session-start-hook-output';

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  void stdin;

  try {
    // runSessionStart renders its banner to stderr via renderMessage, but a
    // clean-exit hook's stderr is not surfaced crisply to the user. Codex's
    // SessionStart output contract (https://developers.openai.com/codex/hooks)
    // accepts `{hookSpecificOutput:{hookEventName:'SessionStart',
    // additionalContext}}` and adds `additionalContext` to the model's
    // context — so we forward any user-actionable (error/warn) message there,
    // framed for the model to relay to the user. The git-credential helper is
    // the complementary hard-stop (prints the same message to stderr when git
    // needs the token). Emitting the raw DaemonResult here (the pre-2026-06-12
    // behavior) violated the contract → "invalid session start JSON output".
    // ALWAYS exit 0 — and emit NOTHING when there's nothing to relay (a no-op
    // SessionStart is exit 0 with no stdout).
    await runSessionStart();
    const additionalContext = sessionStartAdditionalContext(
      drainRenderedMessages(),
    );
    if (additionalContext) {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext,
          },
        })}\n`,
      );
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `hook-session-start failed: ${(err as Error)?.message ?? err}\n`,
    );
    process.exit(0);
  }
}

main();
