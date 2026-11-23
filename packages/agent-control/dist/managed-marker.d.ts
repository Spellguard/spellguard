/** Fixed basename of the managed-mode marker, at the SHARED config root. */
export declare const MANAGED_MARKER_BASENAME = ".managed";
/** The JSON stamp the Go writer stores. Diagnostic identity only — no secrets. */
export interface ManagedMarker {
    agent_id: string;
    bootstrap_at?: string;
    cli_version?: string;
    frameworks?: string[];
}
export interface ManagedMarkerResult {
    /** The parsed stamp when present + valid; undefined otherwise. */
    marker?: ManagedMarker;
    /** True ONLY for a present, parseable marker carrying a non-empty agent id. */
    managed: boolean;
    /** Non-empty when the marker is present but unreadable / corrupt / invalid. */
    diagnostic?: string;
}
/**
 * The shared Spellguard config ROOT — parent of the per-framework config subdirs
 * and home of the managed-mode marker. `<XDG_CONFIG_HOME>/spellguard` when set +
 * non-empty, else `<home>/.config/spellguard`. Byte-identical to the Go
 * `plugin.SharedConfigRoot` and the plugins' own `spellguardRootDir()`.
 *
 * `env`/`home` are injectable so the parity + reader tests can pin concrete paths
 * without touching the real environment or `~/.config/spellguard`.
 */
export declare function spellguardRootDir(env?: NodeJS.ProcessEnv, home?: string): string;
/** Absolute marker path for a resolved shared root. */
export declare function managedMarkerPath(root?: string): string;
/**
 * Read + validate the managed-mode marker at the shared root. Present + parseable
 * + agent id → managed. Absent → non-managed, no diagnostic (the default case).
 * Present but unreadable / corrupt / missing-agent-id → non-managed + a diagnostic
 * (fail TOWARD scoped; never activate managed mode on a bad marker). NEVER gates on
 * ambient env (NEG-7) — it only ever reads this file.
 */
export declare function readManagedMarker(root?: string): ManagedMarkerResult;
/**
 * Positive managed-mode gate: true ONLY when the shared root holds a present,
 * parseable marker with a non-empty agent id. Absent OR corrupt → false
 * (non-managed / scoped / fail-closed).
 */
export declare function isManagedBox(root?: string): boolean;
