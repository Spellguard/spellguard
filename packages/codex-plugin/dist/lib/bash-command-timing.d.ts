/** Record the start time of a Bash command, keyed by its tool-use id. */
export declare function markBashCommandStart(input: {
    rootDir: string;
    key: string;
    nowMs: number;
}): void;
/**
 * Read and remove the start time for a tool-use id. Returns the start time in
 * ms, or null if none was recorded. Also opportunistically prunes stale
 * sidecars left behind by blocked PreToolUse calls.
 */
export declare function consumeBashCommandStart(input: {
    rootDir: string;
    key: string;
    nowMs: number;
}): number | null;
