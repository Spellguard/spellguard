// SPDX-License-Identifier: Apache-2.0

/**
 * Backwards-compatible middleware entry point.
 *
 * The primary API moved to `createSpellguard(opts).middleware()` but this
 * module keeps the old `createSpellguardMiddleware` import path working for
 * existing consumers.
 */
export { verifyVerifierRequest, createSpellguard } from './spellguard';
export type { SpellguardInstance } from './spellguard';
export type { SpellguardOptions } from './types';

import type { Hono } from 'hono';
import { createSpellguard } from './spellguard';
import type { SpellguardOptions } from './types';

/**
 * @deprecated Use `createSpellguard(opts).middleware()` instead.
 */
export function createSpellguardMiddleware<
  E extends object = object,
  M = unknown,
>(options: SpellguardOptions<E, M>): Hono<{ Bindings: E }> {
  return createSpellguard(options).middleware();
}
