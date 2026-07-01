/**
 * Heal stale git identity in Claude Code's per-session SessionStart capture files.
 *
 * Claude Code captures each SessionStart hook run to its own file
 * `<session-env-dir>/sessionstart-hook-N.sh` and sources ALL of them (in
 * filename order, last-wins) before every Bash command. On a RESUMED session the
 * hook re-runs and writes a fresh capture with the current identity — but the
 * ORIGINAL startup capture persists and, sorting after the resume capture,
 * overrides it. So after a re-provision a resumed session authors commits with
 * the stale `(Spellguard:<old-agent>)` marker even though config.json (and this
 * run's fresh capture) carry the current one. Empirically confirmed 2026-06-16.
 *
 * This rewrites the `user.name`/`user.email` value lines (located by their key,
 * whatever slot index they occupy) in EVERY sibling capture in the session-env
 * dir to the current identity, so the current value wins regardless of source
 * order. It is deliberately surgical and fail-safe:
 *  - Only the two identity value lines are touched; the stable helper path, the
 *    SSH->HTTPS `insteadOf` rewrite slots, `GH_CONFIG_DIR`, `GIT_CONFIG_COUNT`,
 *    and every other export are left intact (we rewrite, never prune — a
 *    whole-file delete would drop those).
 *  - Only `sessionstart-hook-*.sh` files that carry our identity slot change.
 *  - Every failure is swallowed: the session-env layout is a Claude Code
 *    internal, so if it ever changes this becomes a no-op. The fresh capture this
 *    run already wrote is untouched either way — there is no regression path.
 *
 * @param envFilePath this run's CLAUDE_ENV_FILE; its directory holds the siblings.
 */
export declare function healSessionEnvIdentity(envFilePath: string, gitAuthorName?: string, gitAuthorEmail?: string): void;
