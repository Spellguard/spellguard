// SPDX-License-Identifier: Apache-2.0
//
// Keeps a Cloudflare Workers invocation alive for background reports (#1506).
//
// workerd cancels a fetch that is still pending when the response returns (or
// when a scheduled event's work settles). The SDK's fire-and-forget reports,
// such as the self-reported usage emit, therefore have to be handed to the
// invocation's `waitUntil`. The middleware installs the request's `waitUntil`
// here for the whole request; code that runs outside a request, such as a
// cron handler, installs its own with `runWithWaitUntil`. Under Node nothing
// is installed and nothing cancels the pending fetch.

import { AsyncLocalStorage } from 'node:async_hooks';

/** An invocation's `waitUntil`: keeps it alive until the promise settles. */
export type WaitUntil = (promise: Promise<unknown>) => void;

const waitUntilContext = new AsyncLocalStorage<WaitUntil>();

/**
 * Run `fn` with `waitUntil` as the place background reports started inside it
 * hand their promise. Pass the Workers `ExecutionContext`'s `waitUntil`,
 * bound: `runWithWaitUntil((p) => ctx.waitUntil(p), fn)`.
 */
export function runWithWaitUntil<T>(waitUntil: WaitUntil, fn: () => T): T {
  return waitUntilContext.run(waitUntil, fn);
}

/** The part of a Hono context this needs. */
interface RequestContext {
  /** Hono throws on access when the request has no ExecutionContext (Node). */
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Run `fn` with the request's `waitUntil` installed, when it has one (on
 * Workers). Under Node, Hono has no ExecutionContext and `fn` simply runs.
 */
export function withRequestWaitUntil<T>(c: RequestContext, fn: () => T): T {
  let ctx: RequestContext['executionCtx'];
  try {
    ctx = c.executionCtx;
  } catch {
    return fn();
  }
  return runWithWaitUntil((promise) => ctx.waitUntil(promise), fn);
}

/**
 * Hand `promise` to the current invocation's `waitUntil`, if one is
 * installed. Never throws: a report must not fail the caller.
 */
export function keepInvocationAlive(promise: Promise<unknown>): void {
  const waitUntil = waitUntilContext.getStore();
  if (!waitUntil) return;
  try {
    waitUntil(promise);
  } catch {
    // The invocation has already ended; nothing is left to extend.
  }
}
