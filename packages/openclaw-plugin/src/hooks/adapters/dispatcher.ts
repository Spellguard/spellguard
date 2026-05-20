// SPDX-License-Identifier: Apache-2.0

import type { BlockNoticeAdapter } from './types';

const adapters = new Map<string, BlockNoticeAdapter>();

/** Recent block dedup set — shared across all adapters, keyed by adapter's buildDedupKey. */
const recentBlocks = new Set<string>();

export function registerAdapter(adapter: BlockNoticeAdapter): void {
  adapters.set(adapter.platform, adapter);
}

export function getAdapter(platform: string): BlockNoticeAdapter | undefined {
  return adapters.get(platform);
}

/**
 * Check and record a dedup key. Returns true if this is a duplicate
 * (already seen within the last 60 seconds).
 */
export function isDuplicate(dedupKey: string): boolean {
  if (recentBlocks.has(dedupKey)) return true;
  recentBlocks.add(dedupKey);
  setTimeout(() => recentBlocks.delete(dedupKey), 60_000);
  return false;
}

/** Visible for tests. */
export function getRegisteredPlatforms(): string[] {
  return [...adapters.keys()];
}
