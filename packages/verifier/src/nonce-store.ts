// SPDX-License-Identifier: Apache-2.0

/**
 * SG-09: Persistent Nonce Store
 *
 * SQLite-backed nonce storage for replay defense. Uses Node 24's built-in
 * node:sqlite module (no native build dependencies needed).
 *
 * Each Verifier instance maintains its own nonce store. In the current architecture,
 * each agent routes to a specific Verifier, so cross-instance replay is not a
 * practical attack vector.
 */

import { DatabaseSync } from 'node:sqlite';

export interface NonceStore {
  insertIfAbsent(
    nonce: string,
    timestampMs: number,
  ): boolean | Promise<boolean>;
  evictExpired(nowMs: number, ttlMs: number): number | Promise<number>;
  count(): number | Promise<number>;
  close(): void;
}

export function createNonceStore(dbPath?: string): NonceStore {
  const db = new DatabaseSync(dbPath || ':memory:');
  db.exec(
    'CREATE TABLE IF NOT EXISTS seen_nonces (nonce TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_nonces_ts ON seen_nonces(timestamp_ms)',
  );

  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO seen_nonces (nonce, timestamp_ms) VALUES (?, ?)',
  );
  const evictStmt = db.prepare(
    'DELETE FROM seen_nonces WHERE timestamp_ms < ?',
  );
  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM seen_nonces');

  return {
    insertIfAbsent(nonce: string, ts: number): boolean {
      return (insertStmt.run(nonce, ts) as { changes: number }).changes > 0;
    },
    evictExpired(now: number, ttl: number): number {
      return (evictStmt.run(now - ttl) as { changes: number }).changes;
    },
    count(): number {
      return (countStmt.get() as { cnt: number }).cnt;
    },
    close(): void {
      db.close();
    },
  };
}
