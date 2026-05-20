// SPDX-License-Identifier: Apache-2.0

import { diffCatalog } from './differ';
import type { CatalogEntry } from './schema';

export interface ChangelogEntry {
  timestamp: string;
  action: 'create' | 'update' | 'flag-removal';
  slug: string;
  actor: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  environment: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  flaggedForRemoval: number;
}

export interface SyncOptions {
  dryRun?: boolean;
}

export interface SyncAdapter {
  fetchExisting: () => Promise<CatalogEntry[]>;
  insertPolicy: (entry: CatalogEntry) => Promise<void>;
  updatePolicy: (slug: string, entry: CatalogEntry) => Promise<void>;
  writeChangelog: (entry: ChangelogEntry) => Promise<void>;
}

export function createSyncer(adapter: SyncAdapter) {
  return {
    sync: async (
      catalogEntries: CatalogEntry[],
      environment: string,
      options?: SyncOptions,
    ): Promise<SyncResult> => {
      const existing = await adapter.fetchExisting();
      const diff = diffCatalog(catalogEntries, existing);
      const timestamp = new Date().toISOString();

      if (!options?.dryRun) {
        for (const entry of diff.created) {
          await adapter.insertPolicy(entry);
          await adapter.writeChangelog({
            timestamp,
            action: 'create',
            slug: entry.slug,
            actor: 'catalog-sync',
            environment,
          });
        }

        for (const update of diff.updated) {
          await adapter.updatePolicy(update.slug, update.entry);
          await adapter.writeChangelog({
            timestamp,
            action: 'update',
            slug: update.slug,
            actor: 'catalog-sync',
            changes: update.changes,
            environment,
          });
        }

        for (const entry of diff.flaggedForRemoval) {
          await adapter.writeChangelog({
            timestamp,
            action: 'flag-removal',
            slug: entry.slug,
            actor: 'catalog-sync',
            environment,
          });
        }
      }

      return {
        created: diff.summary.created,
        updated: diff.summary.updated,
        unchanged: diff.summary.unchanged,
        flaggedForRemoval: diff.summary.flaggedForRemoval,
      };
    },
  };
}
