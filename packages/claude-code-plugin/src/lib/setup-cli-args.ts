// SPDX-License-Identifier: Apache-2.0

import type { ExistingConfigChoice } from '../skills/spellguard-setup';

/**
 * Setup wrapper CLI argument parsing (plan Tasks 2.4 + 2.9 — I9 / I14).
 *
 * Before this module existed, `main()` only parsed `--base-url` and silently
 * ignored everything else — `skill-spellguard-setup --help` started a REAL
 * setup flow (minted a nonce, opened the bootstrap channel). And because the
 * skill always runs the wrapper without a TTY, the three-way
 * existing-credential menu was unreachable (it falls back to
 * "print identity"), which made re-authorize impossible from the skill.
 * `--choice` is the non-interactive path to those menu options.
 */

export class UsageError extends Error {}

export type SetupCliAction =
  | { action: 'help' }
  | {
      action: 'run';
      baseUrl?: string;
      agentId?: string;
      choice?: ExistingConfigChoice;
    };

const CHOICE_MAP: Record<string, ExistingConfigChoice> = {
  print: 'print_identity',
  additional: 'provision_additional',
  reauthorize: 'reauthorize',
};

const VALUE_FLAGS = ['--base-url', '--agent-id', '--choice'] as const;

export const SETUP_USAGE = [
  'Usage: skill-spellguard-setup [options]',
  '',
  'Options:',
  '  --base-url <url>   Target a non-default Spellguard broker',
  '  --agent-id <uuid>  Re-bind a specific agent UUID (lost-config recovery)',
  '  --choice <print|additional|reauthorize>',
  '                     Non-interactive answer to the existing-credential menu',
  '  -h, --help         Show this help and exit',
  '',
  'To disconnect this machine entirely, use /spellguard-reset.',
].join('\n');

/** Extract the value for a `--flag value` / `--flag=value` pair, or undefined. */
function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1) {
    const v = argv[idx + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new UsageError(`${flag} requires a value.`);
    }
    return v;
  }
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

/**
 * Parse the setup wrapper's argv. Throws `UsageError` on unknown flags or
 * invalid values — the bin prints usage and exits 2; it must never fall
 * through into a real setup flow on operator typos.
 */
export function parseSetupArgv(argv: string[]): SetupCliAction {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { action: 'help' };
  }

  // Reject unknown flags before parsing values.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) continue; // a value consumed by a flag below
    const bare = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (!(VALUE_FLAGS as readonly string[]).includes(bare)) {
      throw new UsageError(`Unknown option "${a}".`);
    }
  }

  const baseUrl = flagValue(argv, '--base-url');
  const agentId = flagValue(argv, '--agent-id');
  if (agentId !== undefined && !/^[0-9a-f-]{36}$/i.test(agentId)) {
    throw new UsageError(`--agent-id must be a UUID (got "${agentId}").`);
  }

  const rawChoice = flagValue(argv, '--choice');
  let choice: ExistingConfigChoice | undefined;
  if (rawChoice !== undefined) {
    choice = CHOICE_MAP[rawChoice];
    if (!choice) {
      throw new UsageError(
        `Invalid --choice "${rawChoice}". Valid values: print, additional, reauthorize.`,
      );
    }
  }

  return {
    action: 'run',
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(choice !== undefined ? { choice } : {}),
  };
}
