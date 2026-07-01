// SPDX-License-Identifier: Apache-2.0

import { runPreToolUse } from '../src/hooks/pre-tool-use-observation';
import { adaptHookPayload } from '../src/lib/hook-payload-adapter';

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;

  try {
    const payload = stdin ? JSON.parse(stdin) : {};
    const adapted = adaptHookPayload(payload);
    if (!adapted) {
      process.stdout.write('{}\n');
      return;
    }
    const result = await runPreToolUse(adapted);
    // PreToolUse — the only Claude-Code-meaningful output here is a hard
    // block on revoked credentials. The plugin's `{decision: 'allow', ...}`
    // and `{decision: 'skip'}` cases need to be emitted as `{}` so Claude
    // Code proceeds normally; `{decision: 'block', message}` needs to be
    // mapped to the current Claude Code schema (`hookSpecificOutput` with
    // `permissionDecision: 'deny'`) because the legacy `{decision: 'block'}`
    // shape now fails JSON-schema validation and silently drops to allow.
    if (result && (result as { decision?: string }).decision === 'block') {
      const message =
        (result as { message?: string }).message ??
        'Spellguard blocked this operation.';
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: message,
          },
        })}\n`,
      );
    } else {
      process.stdout.write('{}\n');
    }
  } catch (err) {
    process.stderr.write(
      `hook-pre-tool-use failed: ${(err as Error)?.message ?? err}\n`,
    );
    process.stdout.write('{}\n');
    process.exit(0);
  }
}

main();
