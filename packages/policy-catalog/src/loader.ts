// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { CatalogFileSchema } from './schema';
import type { CatalogEntry } from './schema';

export function loadCatalogFile(filePath: string): CatalogEntry[] {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseJsonc(raw);
  try {
    const validated = CatalogFileSchema.parse(parsed);
    return validated.policies;
  } catch (err) {
    throw new Error(`Invalid catalog file: ${filePath}`, { cause: err });
  }
}

export function loadCatalogDir(dirPath: string): CatalogEntry[] {
  const files = collectJsoncFiles(dirPath);
  const allEntries: CatalogEntry[] = [];

  for (const file of files) {
    const entries = loadCatalogFile(file);
    allEntries.push(...entries);
  }

  // Deduplicate by slug — last wins
  const bySlug = new Map<string, CatalogEntry>();
  for (const entry of allEntries) {
    bySlug.set(entry.slug, entry);
  }

  return [...bySlug.values()];
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
