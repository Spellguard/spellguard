export interface SelfInstallResult {
    /** 'already' = a backend was already usable, no install attempted. */
    status: 'already' | 'installed' | 'skipped' | 'failed';
    /** The directory we installed into (plugin root), when applicable. */
    installDir?: string;
    /** Human-readable reason for skipped/failed. */
    reason?: string;
}
/**
 * Resolve the plugin root — the directory that contains `dist/` and where the
 * vendored `node_modules` lives. At runtime the setup CLI executes from
 * `dist/bin/run-spellguard-setup.mjs`, so the plugin root is two levels up from
 * this module's directory (`dist/lib` → `dist` → plugin root). In the
 * non-bundled (tsx/vitest) layout this module sits at `src/lib`, so the same
 * two-levels-up rule lands on the package root. An explicit override is
 * accepted for tests.
 */
export declare function resolvePluginRoot(overrideDir?: string): string;
export interface EnsureOptions {
    /** Override the plugin root (tests). */
    pluginRoot?: string;
    /**
     * Test seam — replace the actual `npm install` spawn. Resolves to an exit
     * code (0 = success). When omitted, a real `npm install` is spawned.
     */
    runInstall?: (args: {
        cwd: string;
        packages: string[];
    }) => Promise<{
        code: number;
        stderr: string;
    }>;
    /** Test seam — override the backend-availability probe. */
    hasBackend?: () => boolean;
    /** Re-probe the backend after install (defaults to the real probe). */
    hasBackendAfter?: () => boolean;
}
/**
 * Ensure a usable SQLite backend exists, self-installing `better-sqlite3` into
 * the plugin root when none is available. NEVER throws — every failure mode
 * (no usable backend remains) is reported via the returned status so the setup
 * flow can print a friendly note and continue.
 */
export declare function ensureSqliteBackend(opts?: EnsureOptions): Promise<SelfInstallResult>;
