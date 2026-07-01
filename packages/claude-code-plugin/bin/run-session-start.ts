// SPDX-License-Identifier: Apache-2.0

import { runSessionStart } from '../src/hooks/session-start';
import { drainRenderedMessages } from '../src/lib/render-message';
import { sessionStartAdditionalContext } from '../src/lib/session-start-hook-output';

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  void stdin;

  try {
    // runSessionStart renders its banner to stderr via renderMessage, but
    // Claude Code has NO crisp visible SessionStart→user channel: clean-exit
    // stderr is not shown, `systemMessage` is ignored, and exit code 2 DROPS
    // the hook's output entirely (verified against the real CLI + session
    // transcript, 2026-06-12). The one channel that lands is
    // `additionalContext`, which goes to the MODEL's context — so we forward
    // any user-actionable (error/warn) message there, framed for the model to
    // relay to the user. The git-credential helper is the complementary
    // hard-stop (prints the same message to stderr when git needs the token).
    // ALWAYS exit 0 — exit 2 would discard this stdout.
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
