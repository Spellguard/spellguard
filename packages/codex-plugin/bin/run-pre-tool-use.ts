// SPDX-License-Identifier: Apache-2.0

import { runPreToolUseCodex } from '../src/hooks/pre-tool-use-observation';

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;

  try {
    const payload = stdin ? JSON.parse(stdin) : {};
    const result = await runPreToolUseCodex(payload);
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
