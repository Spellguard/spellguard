// SPDX-License-Identifier: Apache-2.0

import { runPreToolUseCodex } from '../src/hooks/pre-tool-use-observation';
import { reconcileDaemonForActiveHook } from '../src/lib/daemon-hook-reconcile';
import { adaptHookPayload } from '../src/lib/hook-payload-adapter';

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;

  try {
    const payload = stdin ? JSON.parse(stdin) : {};
    const adapted = adaptHookPayload(payload);
    if (!adapted) {
      if (process.env.SPELLGUARD_HOOK_TRACE) {
        process.stderr.write('[trace] pre-tool adapter returned null\n');
      }
      process.stdout.write('{}\n');
      return;
    }
    if (process.env.SPELLGUARD_HOOK_TRACE) {
      process.stderr.write(
        `[trace] pre-tool adapted: toolName=${adapted.toolName} cwd=${adapted.cwd} agent=${adapted.agentId.slice(0, 8)} endpoint=${adapted.endpoint} remoteUrl=${adapted.remoteUrl}\n`,
      );
    }
    try {
      const daemon = await reconcileDaemonForActiveHook({ cwd: adapted.cwd });
      if (process.env.SPELLGUARD_HOOK_TRACE) {
        process.stderr.write(
          `[trace] pre-tool daemon reconciliation: ${JSON.stringify(daemon)}\n`,
        );
      }
    } catch (error) {
      if (process.env.SPELLGUARD_HOOK_TRACE) {
        process.stderr.write(
          `[trace] pre-tool daemon reconciliation failed: ${String(error)}\n`,
        );
      }
    }
    const result = await runPreToolUseCodex(adapted);
    // runPreToolUseCodex returns the Codex-shaped envelope already (empty
    // object for "skip", continue:true for allow, hookSpecificOutput.deny
    // for block).
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(
      `hook-pre-tool-use failed: ${(err as Error)?.message ?? err}\n`,
    );
    process.stdout.write('{}\n');
    process.exit(0);
  }
}

main();
