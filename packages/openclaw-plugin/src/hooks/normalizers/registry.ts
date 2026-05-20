// SPDX-License-Identifier: Apache-2.0

import type { ContentNormalizer } from './types';

const normalizers = new Map<string, ContentNormalizer>();

export function registerNormalizer(
  platform: string,
  fn: ContentNormalizer,
): void {
  normalizers.set(platform, fn);
}

/**
 * Normalize content for the given platform.
 * Returns content unchanged if no normalizer is registered for the platform.
 */
export function normalizeContent(content: string, platform: string): string {
  const fn = normalizers.get(platform);
  return fn ? fn(content) : content;
}
