// SPDX-License-Identifier: Apache-2.0

/**
 * Local Policy Bindings
 *
 * Loads policy bindings from a JSON file on disk, used when MANAGEMENT_URL
 * is not configured (OSS deployments). The file is read once on first
 * access and cached for the process lifetime; restart the Verifier to
 * pick up edits.
 *
 * Lookup order:
 *   1. process.env.VERIFIER_LOCAL_POLICIES (absolute or relative path)
 *   2. process.cwd() + '/bindings.json'   (convention)
 *   3. null — no policies, passthrough
 *
 * File format mirrors ResolvedPolicyConfig (the shape getAgentPolicies
 * already returns over HTTP from management). Missing per-binding fields
 * are auto-filled with sensible defaults; server-side bookkeeping fields
 * (version, signature, resolvedAt, expiresAt) are synthesized on load.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  ResolvedPolicyBinding,
  ResolvedPolicyConfig,
} from '../proxy/policy-evaluator-types';

/** Partial binding the user writes in the file. */
interface PartialBinding extends Partial<ResolvedPolicyBinding> {
  policyId: string;
  policySlug: string;
  policyType: ResolvedPolicyBinding['policyType'];
  effect: ResolvedPolicyBinding['effect'];
}

interface PartialAgentConfig {
  outbound?: PartialBinding[];
  inbound?: PartialBinding[];
}

interface LocalPoliciesFile {
  default?: PartialAgentConfig;
  agents?: Record<string, PartialAgentConfig>;
}

interface LoadedState {
  default: ResolvedPolicyConfig | null;
  agents: Map<string, ResolvedPolicyConfig>;
  sourcePath: string;
}

let state: LoadedState | null = null;
let loaded = false;

function resolveFilePath(): string {
  const envPath = process.env.VERIFIER_LOCAL_POLICIES;
  if (envPath && envPath.length > 0) {
    return resolve(envPath);
  }
  return resolve(process.cwd(), 'bindings.json');
}

function fillBindingDefaults(b: PartialBinding): ResolvedPolicyBinding {
  return {
    level: 'org',
    ...b,
  };
}

function buildConfig(
  partial: PartialAgentConfig,
  version: string,
): ResolvedPolicyConfig {
  return {
    inbound: (partial.inbound ?? []).map(fillBindingDefaults),
    outbound: (partial.outbound ?? []).map(fillBindingDefaults),
    version,
    signature: '',
    resolvedAt: Date.now(),
    // Far-future — local files don't expire; restart to reload.
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

function validate(file: unknown): asserts file is LocalPoliciesFile {
  if (typeof file !== 'object' || file === null) {
    throw new Error('bindings file must be a JSON object');
  }
  const f = file as Record<string, unknown>;
  if (!('default' in f) && !('agents' in f)) {
    throw new Error(
      'bindings file must contain a "default" or "agents" property',
    );
  }
  if ('agents' in f) {
    const agents = f.agents;
    if (
      typeof agents !== 'object' ||
      agents === null ||
      Array.isArray(agents)
    ) {
      throw new Error('"agents" must be an object keyed by agentId');
    }
  }
}

function load(): LoadedState | null {
  const path = resolveFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const isEnoent =
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT';
    if (isEnoent && !process.env.VERIFIER_LOCAL_POLICIES) {
      // Convention default not present — that's fine, no enforcement.
      return null;
    }
    throw new Error(
      `[LocalPolicies] Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[LocalPolicies] Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  validate(parsed);

  const version = `local-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  const agents = new Map<string, ResolvedPolicyConfig>();
  for (const [agentId, cfg] of Object.entries(parsed.agents ?? {})) {
    agents.set(agentId, buildConfig(cfg, version));
  }
  const defaultCfg = parsed.default
    ? buildConfig(parsed.default, version)
    : null;

  console.log(
    `[LocalPolicies] Loaded ${agents.size} agent bindings from ${path}` +
      `${defaultCfg ? ' (with default)' : ''}`,
  );

  return {
    default: defaultCfg,
    agents,
    sourcePath: path,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  state = load();
}

/**
 * Get resolved policies for an agent from the local bindings file.
 * Returns null when no file is configured or the agent has no entry
 * and there is no `default` block.
 */
export function getLocalAgentPolicies(
  agentId: string,
): ResolvedPolicyConfig | null {
  ensureLoaded();
  if (!state) return null;
  return state.agents.get(agentId) ?? state.default ?? null;
}

/**
 * Reset the cached state. Test-only — production reads once at startup.
 */
export function resetLocalPoliciesForTesting(): void {
  state = null;
  loaded = false;
}
