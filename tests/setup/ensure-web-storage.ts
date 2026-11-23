// SPDX-License-Identifier: Apache-2.0

/**
 * On some local toolchains (observed: vitest 2.1 + jsdom 28 on Node 26),
 * the jsdom environment's `window.localStorage` getter yields `undefined`
 * even though the property exists — so every test that touches web storage
 * (theme persistence, post-login redirect, cross-org guards) explodes with
 * "Cannot read properties of undefined" locally while passing in CI.
 *
 * Install a minimal in-memory Storage only when the environment lacks a
 * working one. No-op for node-environment suites and wherever jsdom provides
 * the real thing.
 */

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => (store.has(key) ? String(store.get(key)) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  return storage as Storage;
}

if (typeof window !== 'undefined') {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    let broken = false;
    try {
      broken = window[key] === undefined || window[key] === null;
    } catch {
      broken = true;
    }
    if (broken) {
      const storage = makeMemoryStorage();
      Object.defineProperty(window, key, {
        configurable: true,
        value: storage,
      });
      // Bare `localStorage` in a test resolves via globalThis — mirror it.
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value: storage,
      });
    }
  }
}
