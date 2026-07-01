// SPDX-License-Identifier: Apache-2.0

// Portable SQLite backend for the local edit-store.
//
// A marketplace plugin install is a bare `git clone` that runs the COMMITTED
// `dist/` with NO install step, so the workspace `node_modules` (which holds
// the vendored `better-sqlite3` native binding) is never present. Committing a
// prebuilt binary wouldn't help either — it's per-platform/per-arch. This
// module makes the edit-store work against any of three SQLite sources, in
// priority order, so the feature works regardless of how the plugin was
// installed and which Node version is running:
//
//   1. Node's built-in `node:sqlite` (`DatabaseSync`) — used ONLY when it loads
//      WITHOUT requiring `--experimental-sqlite` (Node 23.4+/24; flag-free on
//      Node 24, which only emits an `ExperimentalWarning` that we suppress).
//      Zero install, no native binary.
//   2. An already-present `better-sqlite3` (local clone + `pnpm install`, the
//      vendored copy next to `dist/`, or a prior self-install).
//   3. A self-installed `better-sqlite3` placed next to `dist/` at
//      `/spellguard-setup` time (see `selfInstallBetterSqlite3`). Its install
//      runs `prebuild-install`, which downloads the right prebuilt binary per
//      platform/arch — no source compile on common platforms.
//
// If all three fail (offline + ancient Node), the edit-store degrades to a
// no-op store (see edit-store.ts). This module NEVER throws on load.
//
// IMPORTANT (parity): this file is byte-identical between the claude-code and
// codex plugins (see scripts/verify-codex-claude-parity.sh). Keep it neutral —
// no framework-specific strings.

import { createRequire } from 'node:module';

// The esbuild hook bundle ships a `createRequire(import.meta.url)` banner that
// shadows `require`, so `require('better-sqlite3')` resolves the vendored copy
// next to `dist/`. In the non-bundled (tsx/vitest) path that banner is absent,
// so we build our own require off this module's URL. Either way, resolution is
// anchored at this file's location → the plugin root's `node_modules`.
const localRequire =
  typeof require === 'function' ? require : createRequire(import.meta.url);

/**
 * The minimal synchronous SQLite surface the edit-store relies on. Both
 * `better-sqlite3` and `node:sqlite`'s `DatabaseSync` provide `.exec`,
 * `.prepare`, and `.close`; `.pragma` is normalized by the adapter (see below)
 * because `node:sqlite` has no `.pragma` method.
 */
export interface SqliteStatement {
  run(params?: Record<string, unknown>): { changes: number | bigint };
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
 * Suppress ONLY the `ExperimentalWarning: SQLite is an experimental feature`
 * emitted by `import('node:sqlite')`, so it doesn't spam hook stderr. We can't
 * set `NODE_NO_WARNINGS` / `--disable-warning` because the hook subprocess is
 * already running by the time we get here; the cleanest in-process mechanism is
 * to wrap `process.emitWarning` for the duration of the load and pass every
 * OTHER warning straight through. Returns a restore fn.
 */
function suppressSqliteExperimentalWarning(): () => void {
  const original = process.emitWarning;
  // biome-ignore lint/suspicious/noExplicitAny: emitWarning has several overloads; we forward verbatim.
  process.emitWarning = ((warning: any, ...rest: any[]) => {
    const optsOrType = rest[0];
    const type =
      typeof optsOrType === 'object' && optsOrType !== null
        ? optsOrType.type
        : optsOrType;
    const name = typeof warning === 'object' ? warning?.name : undefined;
    const message =
      typeof warning === 'string' ? warning : (warning?.message ?? '');
    const isSqliteExperimental =
      type === 'ExperimentalWarning' ||
      name === 'ExperimentalWarning' ||
      (typeof message === 'string' &&
        message.includes('SQLite is an experimental'));
    if (isSqliteExperimental) return; // swallow this one
    return original.call(process, warning, ...rest);
    // biome-ignore lint/suspicious/noExplicitAny: cast back to the original signature.
  }) as any;
  return () => {
    process.emitWarning = original;
  };
}

/**
 * Extract the set of named-parameter names referenced by a SQL string
 * (`@name`, `:name`, or `$name`). Used to sanitize bind objects before handing
 * them to a backend.
 *
 * `node:sqlite` THROWS `Unknown named parameter` when the bind object carries a
 * key the statement doesn't reference, whereas `better-sqlite3` silently
 * ignores extras. The edit-store passes whole record objects (e.g. an
 * `EditRecord`) whose keys exactly match the statement today, but we filter
 * defensively so the two backends behave identically and a future caller can't
 * break the node:sqlite path with an extra key.
 */
function namedParamsIn(sql: string): Set<string> {
  const names = new Set<string>();
  const re = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null = re.exec(sql);
  while (m !== null) {
    names.add(m[1] as string);
    m = re.exec(sql);
  }
  return names;
}

function pickKnownParams(
  params: Record<string, unknown> | undefined,
  known: Set<string>,
): Record<string, unknown> | undefined {
  if (!params) return params;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    // Accept both bare (`workingDir`) and prefixed (`@workingDir`) keys.
    const bare = key.replace(/^[@:$]/, '');
    if (known.has(bare)) out[bare] = params[key];
  }
  return out;
}

// ── node:sqlite adapter ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: backend modules are loaded dynamically; types elided.
function adaptNodeSqlite(DatabaseSync: any): SqliteBackend {
  return {
    kind: 'node:sqlite',
    open(dbPath: string): SqliteDatabase {
      const db = new DatabaseSync(dbPath);
      const wrapStatement = (sql: string): SqliteStatement => {
        const stmt = db.prepare(sql);
        const known = namedParamsIn(sql);
        return {
          run(params) {
            return stmt.run(pickKnownParams(params, known) ?? {});
          },
          get(params) {
            return stmt.get(pickKnownParams(params, known) ?? {});
          },
          all(params) {
            return stmt.all(pickKnownParams(params, known) ?? {});
          },
        };
      };
      return {
        exec(sql) {
          db.exec(sql);
        },
        prepare: wrapStatement,
        pragma(directive) {
          // `DatabaseSync` has no `.pragma()` — run it as a statement.
          db.exec(`PRAGMA ${directive}`);
        },
        close() {
          db.close();
        },
      };
    },
  };
}

// ── better-sqlite3 adapter ─────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: backend modules are loaded dynamically; types elided.
function adaptBetterSqlite3(Database: any): SqliteBackend {
  return {
    kind: 'better-sqlite3',
    open(dbPath: string): SqliteDatabase {
      const db = new Database(dbPath);
      const wrapStatement = (sql: string): SqliteStatement => {
        const stmt = db.prepare(sql);
        const known = namedParamsIn(sql);
        return {
          // better-sqlite3 ignores extra keys already, but we sanitize too so
          // both backends receive the exact same bind object.
          run(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.run(p) : stmt.run();
          },
          get(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.get(p) : stmt.get();
          },
          all(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.all(p) : stmt.all();
          },
        };
      };
      return {
        exec(sql) {
          db.exec(sql);
        },
        prepare: wrapStatement,
        pragma(directive) {
          db.pragma(directive);
        },
        close() {
          db.close();
        },
      };
    },
  };
}

// ── backend detection ──────────────────────────────────────────────────────

/**
 * Try to load `node:sqlite` WITHOUT the `--experimental-sqlite` flag. On Node
 * 24 it imports flag-free (emitting only the experimental warning we suppress);
 * on Node 23.x it requires the flag → `require` throws `ERR_… experimental` and
 * we fall through. Returns the adapter or null.
 */
function tryNodeSqlite(): SqliteBackend | null {
  const restore = suppressSqliteExperimentalWarning();
  try {
    // `node:sqlite` is a builtin; require() throws when the flag is required.
    const mod = localRequire('node:sqlite') as { DatabaseSync?: unknown };
    if (!mod?.DatabaseSync) return null;
    // Smoke-test that we can actually open + query an in-memory DB. A bare
    // import that succeeds but errors on first use would otherwise slip past
    // detection and degrade the feature at runtime.
    const backend = adaptNodeSqlite(mod.DatabaseSync);
    const probe = backend.open(':memory:');
    probe.exec('CREATE TABLE __probe (x); DROP TABLE __probe;');
    probe.close();
    return backend;
  } catch {
    return null;
  } finally {
    restore();
  }
}

function tryBetterSqlite3(): SqliteBackend | null {
  try {
    const Database = localRequire('better-sqlite3');
    return adaptBetterSqlite3(Database);
  } catch {
    return null;
  }
}

let cachedBackend: SqliteBackend | null | undefined;

/**
 * Resolve a usable SQLite backend in priority order, or null if none is
 * available. The result is cached for the lifetime of the process (backend
 * availability can't change mid-run). Never throws.
 */
export function loadSqliteBackend(): SqliteBackend | null {
  if (cachedBackend !== undefined) return cachedBackend;
  cachedBackend = tryNodeSqlite() ?? tryBetterSqlite3() ?? null;
  return cachedBackend;
}

/**
 * Detection-only helper for the setup CLI: is ANY SQLite backend usable right
 * now (node:sqlite flag-free OR better-sqlite3 resolvable)? When false, setup
 * should attempt the self-install below.
 */
export function hasUsableSqliteBackend(): boolean {
  return loadSqliteBackend() !== null;
}

/** @internal Test seam — drops the cached backend so a test can re-detect. */
export function __resetSqliteBackendCacheForTests(): void {
  cachedBackend = undefined;
}

/**
 * @internal Test seam — return the node:sqlite adapter directly (or null when
 * node:sqlite isn't flag-free on this Node), bypassing the priority cache so a
 * test can assert that SPECIFIC adapter's behavior. Production code must use
 * `loadSqliteBackend`.
 */
export function __loadNodeSqliteBackendForTests(): SqliteBackend | null {
  return tryNodeSqlite();
}

/**
 * @internal Test seam — return the better-sqlite3 adapter directly (or null
 * when the native module isn't resolvable), bypassing the priority cache so a
 * test can assert that SPECIFIC adapter's behavior even on a Node that prefers
 * node:sqlite. Production code must use `loadSqliteBackend`.
 */
export function __loadBetterSqlite3BackendForTests(): SqliteBackend | null {
  return tryBetterSqlite3();
}
