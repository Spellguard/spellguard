// SPDX-License-Identifier: Apache-2.0

import { captureSessionStart } from '@spellguard/agent-control';
import { runSessionStart } from '../src/hooks/session-start';
import { drainRenderedMessages } from '../src/lib/render-message';
import { sessionStartAdditionalContext } from '../src/lib/session-start-hook-output';

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  // REQ-011.1: SessionStart is the only point that knows this session's
  // NATIVE, resumable id, so capture it into the box-local registry here.
  // Best-effort and bounded: a workstation with no box daemon is the
  // documented common case, and a failed capture must never block a session.
  const sessionCapture = captureSessionStart(stdin, 'codex');

  try {
    // runSessionStart renders its banner to stderr via renderMessage, but a
    // clean-exit hook's stderr is not surfaced crisply to the user. Codex's
    // SessionStart accepts plain stdout as additional developer context. Use
    // that stable, backwards-compatible form instead of the optional JSON
    // envelope: Codex 0.142 rejected the documented hookSpecificOutput shape
    // in a real plugin run as "invalid session start JSON output". We forward
    // any user-actionable (error/warn) message, framed for the model to relay
    // to the user. The git-credential helper is the complementary hard-stop
    // (prints the same message to stderr when git needs the token).
    // ALWAYS exit 0 — and emit NOTHING when there's nothing to relay (a no-op
    // SessionStart is exit 0 with no stdout).
    await runSessionStart();
    await sessionCapture;
    const additionalContext = sessionStartAdditionalContext(
      drainRenderedMessages(),
    );
    if (additionalContext) {
      process.stdout.write(`${additionalContext}\n`);
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
