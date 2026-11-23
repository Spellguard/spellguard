// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical A2A (Agent2Agent) v1.0 collaboration-plane payload shapes.
 *
 * Public surface:
 *   - types      — `A2aMessage`, `A2aTask`, `A2aTaskState`, `A2aRole`,
 *                  `A2aPart`, `A2aArtifact`, `A2aTaskStatus` (+ the
 *                  `A2A_TASK_STATES` / `A2A_ROLES` value tuples).
 *   - validators — `validateA2aMessage`, `validateA2aTask` (dependency-free
 *                  runtime guards) and their `isA2a*` boolean forms.
 *
 * The vendored `a2a-v1.schema.json` in this directory is the canonical named
 * reference artifact these types + validators mirror. SHAPES ONLY — the wire
 * frames that carry them are a separate protocol concern.
 */

export * from './types';
export * from './validate';
