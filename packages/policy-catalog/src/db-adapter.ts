// SPDX-License-Identifier: Apache-2.0

import postgres from 'postgres';
import type { CatalogEntry } from './schema';
import type { ChangelogEntry, SyncAdapter } from './syncer';

export function createDbAdapter(
  connectionUrl: string,
): SyncAdapter & { close: () => Promise<void> } {
  const sql = postgres(connectionUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { undefined: null },
  });

  return {
    fetchExisting: async (): Promise<CatalogEntry[]> => {
      const rows = await sql`
        SELECT slug, name, description, type, level,
               severity, fail_behavior, dsl_source
        FROM policies
      `;
      return rows.map((row) => {
        const dslSource =
          typeof row.dsl_source === 'string'
            ? JSON.parse(row.dsl_source)
            : (row.dsl_source ?? {});
        return {
          slug: row.slug,
          name: row.name,
          description: row.description ?? '',
          type: row.type,
          level:
            row.level === 'system' ? ('system' as const) : ('org' as const),
          severity: row.severity ?? undefined,
          failBehavior: row.fail_behavior ?? undefined,
          config: dslSource.config ?? dslSource,
          defaultBinding: dslSource.defaultBinding ?? {
            direction: 'inbound' as const,
            effect: 'block' as const,
            priority: 100,
          },
          provenance: { source: 'db', dateAdded: '' },
        };
      });
    },

    insertPolicy: async (entry: CatalogEntry): Promise<void> => {
      const dslSource = JSON.stringify({
        config: entry.config,
        defaultBinding: entry.defaultBinding,
      });
      await sql`
        INSERT INTO policies (
          slug, name, description, type, level,
          severity, fail_behavior, dsl_source, is_public, version
        ) VALUES (
          ${entry.slug}, ${entry.name}, ${entry.description},
          ${entry.type}, ${entry.level},
          ${entry.severity ?? 'medium'}, ${entry.failBehavior ?? 'block'}, ${dslSource}::jsonb,
          true, '1.0'
        )
      `;
    },

    updatePolicy: async (slug: string, entry: CatalogEntry): Promise<void> => {
      const dslSource = JSON.stringify({
        config: entry.config,
        defaultBinding: entry.defaultBinding,
      });
      await sql`
        UPDATE policies SET
          name = ${entry.name},
          description = ${entry.description},
          type = ${entry.type},
          level = ${entry.level},
          severity = ${entry.severity ?? 'medium'},
          fail_behavior = ${entry.failBehavior ?? 'block'},
          dsl_source = ${dslSource}::jsonb,
          updated_at = NOW()
        WHERE slug = ${slug}
      `;
    },

    writeChangelog: async (entry: ChangelogEntry): Promise<void> => {
      console.log(JSON.stringify(entry));
    },

    close: async () => {
      await sql.end();
    },
  };
}
