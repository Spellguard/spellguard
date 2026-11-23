// SPDX-License-Identifier: Apache-2.0

/**
 * Pluggable policy engine registry.
 *
 * Engines are keyed by PolicyType string (e.g. 'builtin', 'dsl', 'external').
 * The builtin engine is registered automatically via initDefaultEngines().
 */

import { POLICY_TYPE_REGISTRY } from '@spellguard/amp';
import type { PolicyEngineFamily } from '@spellguard/amp';
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
import { SessionEngine } from './session-engine';
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
  const policyFile = new PolicyFileEngine();
  const policyShell = new PolicyShellEngine();
  const policyNetwork = new PolicyNetworkEngine();
  const policyDatabase = new PolicyDatabaseEngine();
  const policyComms = new PolicyCommsEngine();
  const policyMemory = new PolicyMemoryEngine();
  const policyMeta = new PolicyMetaEngine();
  const enginesByFamily: Record<PolicyEngineFamily, PolicyEngine> = {
    builtin,
    dsl: new DslEngine(),
    external: new ExternalEngine(),
    regex: new RegexEngine(),
    schema: new SchemaEngine(),
    'time-window': new TimeWindowEngine(),
    injection: new InjectionEngine(),
    url: new UrlEngine(),
    exfiltration: new ExfiltrationEngine(),
    loop: new LoopEngine(),
    identity: new IdentityEngine(),
    file: policyFile,
    shell: policyShell,
    network: policyNetwork,
    database: policyDatabase,
    comms: policyComms,
    memory: policyMemory,
    meta: policyMeta,
    session: new SessionEngine(),
  };

  for (const { type, engineFamily } of POLICY_TYPE_REGISTRY) {
    const engine = enginesByFamily[engineFamily];
    if (!engine) {
      throw new Error(
        `No engine registered for policy family "${engineFamily}"`,
      );
    }
    registerEngine(type, engine);
  }
}

// Auto-register defaults on import
initDefaultEngines();
