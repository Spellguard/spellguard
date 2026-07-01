// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory cache for the credential store's `agentId`.
 *
 * `evaluateContent` runs on every inbound/outbound message and tool call;
 * resolving `agentId` from disk via `readCredentialStore()` for each call
 * costs `existsSync` + `statSync` + `readFileSync` + `JSON.parse` and blocks
 * the OpenClaw event loop on chatty bots. The agentId itself is a long-lived
 * UUID that only changes on re-bootstrap, so a process-local cache is safe
 * and is invalidated by the credential service on lifecycle transitions.
 *
 * Module-level mutable state is acceptable here: OpenClaw runs a single
 * plugin process per host, the credential service primes the cache once at
 * `start()` (no concurrent priming), and `evaluateContent` only reads.
 */

let cachedAgentId: string | null = null;

export function getCachedAgentId(): string | null {
  return cachedAgentId;
}

export function primeAgentIdCache(agentId: string): void {
  cachedAgentId = agentId;
}

export function invalidateAgentIdCache(): void {
  cachedAgentId = null;
}
