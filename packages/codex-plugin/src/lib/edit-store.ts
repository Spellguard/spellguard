// SPDX-License-Identifier: Apache-2.0

// Local SQLite store for agent edit records. Lives in the user's home
// directory under .spellguard/edits.db. Records are pruned after 24h.
//
// Note: the public methods (`record`, `queryByDir`, `pruneOlderThan`) are
// declared `async` for forward compatibility with callers that already
// `await` them. The underlying SQLite prepared statements are strictly
// synchronous (both `node:sqlite`'s DatabaseSync and better-sqlite3), so there
// is no hidden I/O — the `Promise` wrapper is purely an API-shape choice, not
// an indicator of off-thread work.
//
// SQLite access goes through a portable 3-tier backend (see sqlite-backend.ts):
//   1. Node's built-in `node:sqlite` (flag-free on Node 24) — zero install,
//      no native binary.
//   2. An already-present `better-sqlite3` (local clone or vendored copy).
//   3. A `better-sqlite3` self-installed at `/spellguard-setup` time.
// If none is available the store degrades to a no-op (e.g. plugin mounted into
// a container with neither node:sqlite nor a vendored better-sqlite3) and emits
// a single stderr note. edit-store must NEVER throw — every hook invocation
// depends on it loading cleanly.

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type SqliteBackend, loadSqliteBackend } from './sqlite-backend';

// Resolve the SQLite backend once at module load. `loadSqliteBackend` never
// throws — it returns null when no backend is usable.
const backend: SqliteBackend | null = loadSqliteBackend();

export interface EditRecord {
  workingDir: string;
  filePath: string;
  // lineStart/lineEnd were previously stored as 1..N where N = lineCount of
  // contentAfter — meaningful only for full-file Write ops, misleading for
  // Edit substitutions (which don't actually start at line 1). Nothing
  // downstream consumed them (the diff-overlap algorithm walks
  // contentAfter text directly), so dropping the dead columns rather
  // than perpetuating the misleading metadata.
  contentBefore: string;
  contentAfter: string;
  sessionId: string;
  agentId: string;
  timestamp: string;
}

let warnedDegraded = false;
function noopStore() {
  if (!warnedDegraded) {
    warnedDegraded = true;
    // Emit to stderr so the customer sees a single clear signal that commit-
    // observation correlation is unavailable. Hooks return {} on stdout to
    // the agent harness; degradation must not block tool execution. The fix is
    // either a newer Node (≥24, for flag-free node:sqlite) or running
    // /spellguard-setup, which self-installs better-sqlite3.
    process.stderr.write(
      '[spellguard-plugin] edit-store unavailable (no SQLite backend: node:sqlite not flag-free on this Node and better-sqlite3 not installed). Edit history will not be recorded; commit-observation correlation is degraded. Run /spellguard-setup or upgrade to Node 24+ to enable it.\n',
    );
  }
  return {
    async record(_r: EditRecord): Promise<void> {
      /* no-op */
    },
    async queryByDir(_input: {
      workingDir: string;
      sinceIso?: string;
    }): Promise<EditRecord[]> {
      return [];
    },
    async pruneOlderThan(_input: { olderThanIso: string }): Promise<void> {
      /* no-op */
    },
    close() {
      /* no-op */
    },
  };
}

export function openEditStore(opts: { rootDir: string }) {
  if (!backend) return noopStore();
  mkdirSync(opts.rootDir, { recursive: true });
  // Lock the rootDir to owner-only (0o700) so no other local user
  // can list the SQLite files. The DB itself contains raw file content
  // from every Edit/Write tool call, which routinely includes secrets
  // accidentally pasted into source. mkdirSync respects the process
  // umask so we chmod explicitly. tryChmod swallows EPERM/ENOENT for
  // platforms that don't honour POSIX modes (Windows) — the WAL+shm
  // siblings are chmod'd best-effort below for the same reason.
  tryChmod(opts.rootDir, 0o700);
  const dbPath = join(opts.rootDir, 'edits.db');
  // Open through the adapter so the same code drives either node:sqlite's
  // DatabaseSync or better-sqlite3. The adapter normalizes `.pragma()` and
  // named-parameter binding so both backends behave identically.
  const db = backend.open(dbPath);
  // WAL journal mode lets concurrent agent sessions read/write the
  // shared edits.db without blocking each other. NORMAL sync is the
  // recommended pairing with WAL (durable up to OS crash, much faster
  // than FULL). busy_timeout is set explicitly to document the 5s
  // wait-on-contention behavior.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  // Schema no longer carries line_start/line_end — see EditRecord
  // comment for rationale. Older DB files created before this migration
  // still have those columns but the new INSERT/SELECT just ignore them
  // (the auto-prune on open will eventually evict the stale rows; in the
  // meantime they're harmless leftover columns not referenced by any
  // downstream consumer). Production rollout: bump the SQLite file's path
  // to `~/.spellguard/edits-v2.db` if a hard cutover is needed; for now
  // the column drift is silent and self-healing within 24h.
  db.exec(`
    CREATE TABLE IF NOT EXISTS edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      working_dir TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_before TEXT NOT NULL,
      content_after TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS edits_dir_ts ON edits (working_dir, timestamp);
  `);

  const insert = db.prepare(`
    INSERT INTO edits (working_dir, file_path, content_before, content_after, session_id, agent_id, timestamp)
    VALUES (@workingDir, @filePath, @contentBefore, @contentAfter, @sessionId, @agentId, @timestamp)
  `);
  const queryStmt = db.prepare(`
    SELECT working_dir AS workingDir, file_path AS filePath,
           content_before AS contentBefore, content_after AS contentAfter,
           session_id AS sessionId, agent_id AS agentId, timestamp
    FROM edits
    WHERE working_dir = @workingDir AND (@since IS NULL OR timestamp >= @since)
    ORDER BY timestamp ASC
  `);
  const pruneStmt = db.prepare('DELETE FROM edits WHERE timestamp < @cutoff');

  // Chmod the DB + journal sibling files to 0o600. WAL mode
  // creates `<db>-wal` and `<db>-shm` lazily; touch them via the prune
  // statement above (which forces a journal write) and chmod them all
  // best-effort. New rows from `record()` would re-create them with
  // default umask, so we re-chmod after the prune statement to catch
  // the freshly-created journal files.
  pruneStmt.run({
    cutoff: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) tryChmod(path, 0o600);
  }

  return {
    async record(r: EditRecord): Promise<void> {
      insert.run(r as unknown as Record<string, unknown>);
    },
    async queryByDir(input: {
      workingDir: string;
      sinceIso?: string;
    }): Promise<EditRecord[]> {
      return queryStmt.all({
        workingDir: input.workingDir,
        since: input.sinceIso ?? null,
      }) as EditRecord[];
    },
    async pruneOlderThan(input: { olderThanIso: string }): Promise<void> {
      pruneStmt.run({ cutoff: input.olderThanIso });
    },
    close() {
      db.close();
    },
  };
}

// chmod helper, best-effort. Windows / non-POSIX filesystems may
// not honour the mode and throw EPERM/ENOTSUP; treat those as soft
// failures because the worst case is the file keeps the umask default
// and the warning would be noise on platforms where modes don't matter.
function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Ignored — see comment above.
  }
}
