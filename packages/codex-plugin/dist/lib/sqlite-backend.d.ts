/**
 * The minimal synchronous SQLite surface the edit-store relies on. Both
 * `better-sqlite3` and `node:sqlite`'s `DatabaseSync` provide `.exec`,
 * `.prepare`, and `.close`; `.pragma` is normalized by the adapter (see below)
 * because `node:sqlite` has no `.pragma` method.
 */
export interface SqliteStatement {
    run(params?: Record<string, unknown>): {
        changes: number | bigint;
    };
    get(params?: Record<string, unknown>): unknown;
    all(params?: Record<string, unknown>): unknown[];
}
export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
    pragma(directive: string): void;
    close(): void;
}
export type SqliteBackendKind = 'node:sqlite' | 'better-sqlite3';
export interface SqliteBackend {
    kind: SqliteBackendKind;
    open(dbPath: string): SqliteDatabase;
}
/**
 * Resolve a usable SQLite backend in priority order, or null if none is
 * available. The result is cached for the lifetime of the process (backend
 * availability can't change mid-run). Never throws.
 */
export declare function loadSqliteBackend(): SqliteBackend | null;
/**
 * Detection-only helper for the setup CLI: is ANY SQLite backend usable right
 * now (node:sqlite flag-free OR better-sqlite3 resolvable)? When false, setup
 * should attempt the self-install below.
 */
export declare function hasUsableSqliteBackend(): boolean;
/** @internal Test seam — drops the cached backend so a test can re-detect. */
export declare function __resetSqliteBackendCacheForTests(): void;
/**
 * @internal Test seam — return the node:sqlite adapter directly (or null when
 * node:sqlite isn't flag-free on this Node), bypassing the priority cache so a
 * test can assert that SPECIFIC adapter's behavior. Production code must use
 * `loadSqliteBackend`.
 */
export declare function __loadNodeSqliteBackendForTests(): SqliteBackend | null;
/**
 * @internal Test seam — return the better-sqlite3 adapter directly (or null
 * when the native module isn't resolvable), bypassing the priority cache so a
 * test can assert that SPECIFIC adapter's behavior even on a Node that prefers
 * node:sqlite. Production code must use `loadSqliteBackend`.
 */
export declare function __loadBetterSqlite3BackendForTests(): SqliteBackend | null;
