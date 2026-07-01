// SPDX-License-Identifier: Apache-2.0

import { runPostToolUse } from '../src/hooks/post-tool-use-observation';
import { adaptHookPayload } from '../src/lib/hook-payload-adapter';

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;

  try {
    const payload = stdin ? JSON.parse(stdin) : {};
    const adapted = adaptHookPayload(payload);
    if (!adapted) {
      if (process.env.SPELLGUARD_HOOK_TRACE) {
        process.stderr.write('[trace] adapter returned null\n');
      }
      // Plugin not yet bootstrapped — emit no-op response so Claude Code
      // continues without surfacing an error to the user.
      process.stdout.write('{}\n');
      return;
    }
    if (process.env.SPELLGUARD_HOOK_TRACE) {
      process.stderr.write(
        `[trace] adapted: toolName=${adapted.toolName} cwd=${adapted.cwd} agent=${adapted.agentId.slice(0, 8)} endpoint=${adapted.endpoint} remoteUrl=${adapted.remoteUrl}\n`,
      );
    }
    const result = await runPostToolUse(adapted);
    if (process.env.SPELLGUARD_HOOK_TRACE) {
      process.stderr.write(
        `[trace] runPostToolUse result: ${JSON.stringify(result).slice(0, 200)}\n`,
      );
    }
    // PostToolUse always returns `{}` — the plugin's internal result shape
    // (`{decision: 'allow', observation}` or `{decision: 'skip'}`) is for
    // in-process consumers, not for Claude Code's hook-output schema. The
    // observation has already been emitted as a side-effect (POST
    // /v1/observations) and the edit-store has already been written; the
    // hook output itself should be "no opinion" so Claude Code proceeds.
    // Returning the plugin's raw decision triggers "Hook JSON output
    // validation failed" because Claude Code's current schema doesn't
    // recognize `decision: 'allow'` or top-level `observation` fields.
    process.stdout.write('{}\n');
  } catch (err) {
    process.stderr.write(
      `hook-post-tool-use failed: ${(err as Error)?.message ?? err}\n`,
    );
    process.stdout.write('{}\n');
    process.exit(0);
  }
}

main();
