// SPDX-License-Identifier: Apache-2.0

/**
 * Radix's FocusScope (behind Dialog, Popover, …) finishes its unmount from a
 * 0 ms timer: it builds a `CustomEvent` and dispatches it on the container so
 * focus can return to where it was. React Testing Library's `cleanup` in a
 * file's `afterEach` unmounts the tree and schedules that timer. When the last
 * test's cleanup is the last thing the file does, vitest tears the jsdom
 * environment down before the timer fires; the timer then resolves
 * `CustomEvent` from a dead realm and jsdom rejects it ("parameter 1 is not
 * of type 'Event'") as an unhandled error — which fails the whole shard while
 * every test in it passed. It is a race, so it shows up under CI load and
 * rarely on a quiet machine (shard 1/4 on 2026-09-17: 4358 passed, 4 errors).
 *
 * After every test in a DOM environment, yield one macrotask turn so pending
 * unmount timers run while the realm is still alive. After-hooks run as a
 * stack, so this runs after the file's own `afterEach(cleanup)`. No-op for
 * node-environment suites and while a test has fake timers installed (a real
 * `setTimeout` would never fire there).
 */
import { afterEach, vi } from 'vitest';

afterEach(async () => {
  if (typeof document === 'undefined' || vi.isFakeTimers()) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
