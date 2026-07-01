/**
 * Best-effort detection of whether the user has enabled the Codex hooks
 * feature flag. The flag lives at `~/.codex/config.toml` under the key
 * `[features] codex_hooks = true`. Without it, Codex silently ignores
 * every plugin's hooks/hooks.json registrations — the SessionStart hook
 * never fires, no observations land, and Spellguard appears broken.
 *
 * This helper is used by the SessionStart hook to print a one-shot
 * banner to the user with copy-pasteable instructions if the flag is
 * disabled. It's deliberately lenient: any read error → assume enabled
 * (we don't want a malformed config.toml to also break the banner).
 */
export type CodexHooksFlagResult = {
    state: 'enabled';
} | {
    state: 'disabled';
} | {
    state: 'unknown';
    reason: string;
};
export declare function probeCodexHooksFlag(opts?: {
    /** Override the config path for tests. */
    configPath?: string;
    /** Override homedir for tests. */
    homeDirOverride?: string;
}): CodexHooksFlagResult;
