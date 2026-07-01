// SPDX-License-Identifier: Apache-2.0

import { runSpellguardReset } from '../src/skills/spellguard-reset';

/**
 * Entry point for the /spellguard-reset skill: deregister this machine's
 * agent server-side, stop local credential daemons, delete the stored
 * credential. JSON summary on stdout.
 */
async function main(): Promise<void> {
  try {
    const result = await runSpellguardReset();
    process.stdout.write(`${JSON.stringify(result ?? {})}\n`);
  } catch (err) {
    process.stderr.write(
      `spellguard-reset failed: ${(err as Error)?.message ?? err}\n`,
    );
    process.exit(1);
  }
}

main();
