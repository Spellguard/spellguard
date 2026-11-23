// SPDX-License-Identifier: Apache-2.0

/**
 * Map over `items`, running at most `limit` async operations concurrently while
 * preserving input order in the returned array.
 *
 * A tiny dependency-free worker-pool — chosen over pulling `p-limit` into this
 * shared client (it is vendored into all three plugin bundles + the OSS export,
 * and has a Python mirror, so a new runtime dep costs more than ~20 lines).
 *
 * Error contract matches the sequential `for`-loop it replaced in the peer
 * fan-out: on the FIRST operation that rejects it stops pulling NEW items and
 * rejects with that error (like `Promise.all`), so the caller's
 * "retry-the-whole-batch on a transient failure" logic
 * (`collectAgentResponsesWithRetry`) is unchanged. Operations already in flight
 * when the failure lands are allowed to settle; their results are discarded.
 *
 * @param items  Inputs to map over.
 * @param limit  Max operations in flight at once (clamped to `[1, items.length]`).
 * @param fn     Async mapper; receives the item and its original index.
 * @returns      Results in the SAME order as `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let cursor = 0;
  let failed = false;
  const bound = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));

  async function drain(): Promise<void> {
    // Each worker pulls the next index until the list is exhausted or a sibling
    // has failed. `cursor++` is race-free on JS's single thread.
    while (!failed) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: bound }, () => drain()));
  return results;
}
