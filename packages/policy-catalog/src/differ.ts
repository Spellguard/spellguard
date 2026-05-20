// SPDX-License-Identifier: Apache-2.0

import type { CatalogEntry } from './schema';

export interface UpdatedEntry {
  slug: string;
  entry: CatalogEntry;
  changes: Record<string, { from: unknown; to: unknown }>;
}

export interface CatalogDiff {
  created: CatalogEntry[];
  updated: UpdatedEntry[];
  unchanged: CatalogEntry[];
  flaggedForRemoval: CatalogEntry[];
  summary: {
    created: number;
    updated: number;
    unchanged: number;
    flaggedForRemoval: number;
  };
}

export function diffCatalog(
  catalogEntries: CatalogEntry[],
  dbEntries: CatalogEntry[],
): CatalogDiff {
  const dbBySlug = new Map(dbEntries.map((e) => [e.slug, e]));
  const catalogBySlug = new Map(catalogEntries.map((e) => [e.slug, e]));

  const created: CatalogEntry[] = [];
  const updated: UpdatedEntry[] = [];
  const unchanged: CatalogEntry[] = [];

  for (const entry of catalogEntries) {
    const existing = dbBySlug.get(entry.slug);
    if (!existing) {
      created.push(entry);
      continue;
    }

    const changes = computeChanges(existing, entry);
    if (Object.keys(changes).length === 0) {
      unchanged.push(entry);
    } else {
      updated.push({ slug: entry.slug, entry, changes });
    }
  }

  const flaggedForRemoval = dbEntries.filter((e) => !catalogBySlug.has(e.slug));

  return {
    created,
    updated,
    unchanged,
    flaggedForRemoval,
    summary: {
      created: created.length,
      updated: updated.length,
      unchanged: unchanged.length,
      flaggedForRemoval: flaggedForRemoval.length,
    },
  };
}

function computeChanges(
  existing: CatalogEntry,
  incoming: CatalogEntry,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const fields: (keyof CatalogEntry)[] = [
    'name',
    'description',
    'type',
    'level',
    'severity',
    'failBehavior',
    'config',
    'defaultBinding',
    'compliance',
  ];

  for (const field of fields) {
    const a = JSON.stringify(existing[field]);
    const b = JSON.stringify(incoming[field]);
    if (a !== b) {
      changes[field] = { from: existing[field], to: incoming[field] };
    }
  }

  return changes;
}
