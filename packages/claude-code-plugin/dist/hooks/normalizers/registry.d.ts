import type { ContentNormalizer } from './types';
export declare function registerNormalizer(platform: string, fn: ContentNormalizer): void;
/**
 * Normalize content for the given platform.
 * Returns content unchanged if no normalizer is registered for the platform.
 */
export declare function normalizeContent(content: string, platform: string): string;
