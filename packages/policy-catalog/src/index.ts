// SPDX-License-Identifier: Apache-2.0

export { CatalogEntrySchema, CatalogFileSchema } from './schema';
export type { CatalogEntry, CatalogFile } from './schema';
export { loadCatalogFile, loadCatalogDir } from './loader';
export { diffCatalog } from './differ';
export type { CatalogDiff, UpdatedEntry } from './differ';
export { createSyncer } from './syncer';
export type {
  SyncAdapter,
  SyncResult,
  SyncOptions,
  ChangelogEntry,
} from './syncer';
export {
  loadComplianceFrameworks,
  buildComplianceLookup,
} from './compliance-loader';
export type {
  ComplianceFramework,
  ComplianceRequirement,
  ComplianceLookupEntry,
} from './compliance-loader';
