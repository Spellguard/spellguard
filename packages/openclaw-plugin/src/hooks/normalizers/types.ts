// SPDX-License-Identifier: Apache-2.0

/**
 * Content normalizer function type.
 *
 * Takes raw platform-specific content (e.g., Discord markdown, Teams HTML)
 * and returns normalized plain text suitable for Verifier evaluation.
 */
export type ContentNormalizer = (content: string) => string;
