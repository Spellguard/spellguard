// SPDX-License-Identifier: Apache-2.0

/**
 * Pluggable policy engine registry.
 *
 * Engines are keyed by PolicyType string (e.g. 'builtin', 'dsl', 'external').
 * The builtin engine is registered automatically via initDefaultEngines().
 */

import { BuiltinEngine } from './builtin-engine';
import { DslEngine } from './dsl-engine';
import { ExfiltrationEngine } from './exfiltration-engine';
import { ExternalEngine } from './external-engine';
import { IdentityEngine } from './identity-engine';
import { InjectionEngine } from './injection-engine';
import { LoopEngine } from './loop-engine';
import { PolicyCommsEngine } from './policy-comms-engine';
import { PolicyDatabaseEngine } from './policy-database-engine';
import type { PolicyEngine } from './policy-evaluator-types';
import { PolicyFileEngine } from './policy-file-engine';
import { PolicyMemoryEngine } from './policy-memory-engine';
import { PolicyMetaEngine } from './policy-meta-engine';
import { PolicyNetworkEngine } from './policy-network-engine';
import { PolicyShellEngine } from './policy-shell-engine';
import { RateLimiter } from './rate-limiter';
import { RegexEngine } from './regex-engine';
import { SchemaEngine } from './schema-engine';
import { TimeWindowEngine } from './time-window-engine';
import { UrlEngine } from './url-engine';

const registry = new Map<string, PolicyEngine>();

/**
 * Register a policy engine for the given policy type.
 * Overwrites any previously registered engine for the same type.
 */
export function registerEngine(policyType: string, engine: PolicyEngine): void {
  registry.set(policyType, engine);
}

/**
 * Look up the engine registered for a policy type.
 * Returns undefined if no engine is registered.
 */
export function getEngine(policyType: string): PolicyEngine | undefined {
  return registry.get(policyType);
}

/**
 * Remove all registered engines. Useful for testing.
 */
export function clearEngines(): void {
  registry.clear();
}

/**
 * Return all currently registered policy type strings. Useful for debugging.
 */
export function getRegisteredTypes(): string[] {
  return [...registry.keys()];
}

/**
 * Register the default built-in engine.
 * Called at module load time and exported for test reset scenarios.
 */
/** Shared rate limiter instance used by the builtin engine. */
let sharedRateLimiter: RateLimiter | undefined;

/** Cleanup interval handle for the shared rate limiter. */
let cleanupInterval: ReturnType<typeof setInterval> | undefined;

/** Get the shared RateLimiter instance (creates one if needed). */
export function getSharedRateLimiter(): RateLimiter {
  if (!sharedRateLimiter) {
    sharedRateLimiter = new RateLimiter();
  }
  return sharedRateLimiter;
}

/**
 * Start the shared rate limiter's periodic cleanup timer.
 *
 * Must be called from inside a request or init handler. Some runtimes
 * disallow setInterval at module global scope, so callers should invoke
 * this once during bootstrap rather than relying on module-load side
 * effects. Safe to call multiple times — no-op after the first call.
 */
export function startRateLimiterCleanup(): void {
  if (cleanupInterval) return;
  // CR-012: Periodically clean up expired buckets to prevent unbounded memory growth.
  // Runs every 60 seconds; cleanup() only evicts buckets unused for 2x their window.
  cleanupInterval = setInterval(() => {
    sharedRateLimiter?.cleanup();
  }, 60_000);
  // Allow the process to exit even if this interval is still running
  if (typeof cleanupInterval === 'object' && 'unref' in cleanupInterval) {
    (cleanupInterval as { unref: () => void }).unref();
  }
}

export function initDefaultEngines(): void {
  const rateLimiter = getSharedRateLimiter();
  const builtin = new BuiltinEngine(rateLimiter);
  registerEngine('builtin', builtin);
  registerEngine('keyword', builtin);
  registerEngine('contains', builtin);
  registerEngine('code', builtin);
  registerEngine('toxicity', builtin);
  registerEngine('secrets', builtin);
  registerEngine('nsfw-blocker', builtin);
  registerEngine('topic-boundary', builtin);
  registerEngine('financial-disclaimer', builtin);
  registerEngine('phi-guardian', builtin);
  registerEngine('action-allowlist', builtin);
  registerEngine('privilege-escalation', builtin);
  registerEngine('citation-enforcer', builtin);
  registerEngine('self-harm-prevention', builtin);
  registerEngine('dsl', new DslEngine());
  registerEngine('regex', new RegexEngine());
  registerEngine('external', new ExternalEngine());
  registerEngine('schema', new SchemaEngine());
  registerEngine('time-window', new TimeWindowEngine());
  registerEngine('injection', new InjectionEngine());
  registerEngine('url', new UrlEngine());
  registerEngine('exfiltration', new ExfiltrationEngine());
  registerEngine('loop', new LoopEngine());

  // ── Policies: Path / File System ─────────────────────────────────────────
  const policyFile = new PolicyFileEngine();
  registerEngine('path-traversal', policyFile);
  registerEngine('path-sandbox', policyFile);

  // ── Policies: Shell / Code Execution ─────────────────────────────────────
  const policyShell = new PolicyShellEngine();
  registerEngine('command-allowlist', policyShell);
  registerEngine('argument-injection', policyShell);
  registerEngine('sandbox-escape', policyShell);

  // ── Policies: Network ─────────────────────────────────────────────────────
  const policyNetwork = new PolicyNetworkEngine();
  registerEngine('ssrf', policyNetwork);
  registerEngine('scheme-allowlist', policyNetwork);
  registerEngine('flow-exfiltration', policyNetwork);

  // ── Policies: Database ────────────────────────────────────────────────────
  const policyDatabase = new PolicyDatabaseEngine();
  registerEngine('query-injection', policyDatabase);
  registerEngine('ddl-block', policyDatabase);
  registerEngine('write-block', policyDatabase);

  // ── Policies: Communications ──────────────────────────────────────────────
  const policyComms = new PolicyCommsEngine();
  registerEngine('recipient-allowlist', policyComms);
  registerEngine('output-risk-scan', policyComms);
  registerEngine('sequence-gate', policyComms);

  // ── Policies: Storage / Memory ────────────────────────────────────────────
  const policyMemory = new PolicyMemoryEngine();
  registerEngine('scope-isolation', policyMemory);
  registerEngine('payload-size-limit', policyMemory);

  // ── Policies: Cross-cutting ───────────────────────────────────────────────
  registerEngine('input-injection-scan', policyFile); // file/tool-output injection
  registerEngine('network-injection-scan', policyNetwork); // network response injection
  registerEngine('memory-injection-scan', policyMemory); // memory/RAG read injection
  const policyMeta = new PolicyMetaEngine();
  registerEngine('invocation-rate-limit', policyMeta);
  registerEngine('irreversible-gate', policyMeta);
  registerEngine('output-size-limit', policyMeta);
  registerEngine('data-flow-taint', policyMeta);

  registerEngine('identity-claim', new IdentityEngine());
}

// Auto-register defaults on import
initDefaultEngines();
