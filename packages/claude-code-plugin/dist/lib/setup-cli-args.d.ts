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
export declare class UsageError extends Error {
}
export type SetupCliAction = {
    action: 'help';
} | {
    action: 'run';
    baseUrl?: string;
    agentId?: string;
    choice?: ExistingConfigChoice;
};
export declare const SETUP_USAGE: string;
/**
 * Parse the setup wrapper's argv. Throws `UsageError` on unknown flags or
 * invalid values — the bin prints usage and exits 2; it must never fall
 * through into a real setup flow on operator typos.
 */
export declare function parseSetupArgv(argv: string[]): SetupCliAction;
