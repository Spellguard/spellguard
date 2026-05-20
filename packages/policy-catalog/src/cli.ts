// SPDX-License-Identifier: Apache-2.0

import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalogDir, loadCatalogFile } from './loader';
import { createSyncer } from './syncer';

const CATALOG_DIR = resolve(import.meta.dirname, '../catalog');

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case 'validate':
      return validate();
    case 'diff':
      return diff(args);
    case 'sync':
      return sync(args);
    default:
      console.error(
        'Usage: policy-catalog <validate|diff|sync> [--env <env>] [--dry-run]',
      );
      process.exit(1);
  }
}

function validate() {
  // Collect entries per-file (without dedup) so we can detect cross-file slug collisions
  const allSlugs: string[] = [];
  const files = collectJsoncFiles(CATALOG_DIR);
  let totalEntries = 0;

  for (const file of files) {
    const entries = loadCatalogFile(file);
    totalEntries += entries.length;
    for (const entry of entries) {
      allSlugs.push(entry.slug);
    }
  }

  console.log(
    `Validated ${totalEntries} catalog entries across ${files.length} files.`,
  );

  const dupes = allSlugs.filter((s, i) => allSlugs.indexOf(s) !== i);
  if (dupes.length > 0) {
    const unique = [...new Set(dupes)];
    console.error(`Duplicate slugs found: ${unique.join(', ')}`);
    process.exit(1);
  }

  console.log('All entries valid. No duplicate slugs.');
}

function collectJsoncFiles(dirPath: string): string[] {
  const results: string[] = [];
  for (const name of readdirSync(dirPath).sort()) {
    const full = resolve(dirPath, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectJsoncFiles(full));
    } else if (name.endsWith('.jsonc')) {
      results.push(full);
    }
  }
  return results;
}

async function diff(args: string[]) {
  const env = getArg(args, '--env') ?? 'staging';
  const dbUrl = getDbUrl(env);

  const { createDbAdapter } = await import('./db-adapter');
  const adapter = createDbAdapter(dbUrl);

  try {
    const catalogEntries = loadCatalogDir(CATALOG_DIR);
    const syncer = createSyncer(adapter);
    const result = await syncer.sync(catalogEntries, env, { dryRun: true });

    console.log(`\nDiff against ${env}:`);
    console.log(`  Created: ${result.created}`);
    console.log(`  Updated: ${result.updated}`);
    console.log(`  Unchanged: ${result.unchanged}`);
    console.log(`  Flagged for removal: ${result.flaggedForRemoval}`);
  } finally {
    await adapter.close();
  }
}

async function sync(args: string[]) {
  const env = getArg(args, '--env') ?? 'staging';
  const dryRun = args.includes('--dry-run');
  const dbUrl = getDbUrl(env);

  const { createDbAdapter } = await import('./db-adapter');
  const adapter = createDbAdapter(dbUrl);

  try {
    const catalogEntries = loadCatalogDir(CATALOG_DIR);
    const syncer = createSyncer(adapter);
    const result = await syncer.sync(catalogEntries, env, { dryRun });

    const prefix = dryRun ? '[DRY RUN] ' : '';
    console.log(`\n${prefix}Sync to ${env}:`);
    console.log(`  ${prefix}Created: ${result.created}`);
    console.log(`  ${prefix}Updated: ${result.updated}`);
    console.log(`  ${prefix}Unchanged: ${result.unchanged}`);
    console.log(`  ${prefix}Flagged for removal: ${result.flaggedForRemoval}`);
  } finally {
    await adapter.close();
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function getDbUrl(env: string): string {
  const envVar = `DATABASE_URL_${env.toUpperCase()}`;
  const url = process.env[envVar] ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(`Set ${envVar} or DATABASE_URL environment variable`);
    process.exit(1);
  }
  return url;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
