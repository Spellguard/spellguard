// SPDX-License-Identifier: Apache-2.0
//
// Helper for agents to report their lockfile / dependency snapshot to
// Management's advisory pipeline. Designed to be called once on agent
// startup (or at deploy time via a CI script) so the supply-chain
// detection pipeline has up-to-date input.
//
// Two layers:
//   - `readLockfileFromDir(dir)` — Node.js-only convenience that locates
//     a lockfile in a directory and reads it. Workers callers can't use
//     this (no `fs` access); they should bundle the lockfile content at
//     build time and pass it directly to `reportDependencies`.
//   - `reportDependencies(opts)` — POSTs the lockfile content (or pre-
//     parsed dependencies) to `${managementUrl}/v1/agents/:agentId/dependencies`.
//
// Both are tree-shakeable; agents only pay for what they import.

export interface LockfileFile {
  filename: string;
  content: string;
}

/**
 * Lockfile filenames the management-side parser recognizes, ordered by
 * preference (project lockfiles first, then Python, then Rust/Go, then
 * SBOM fallback).
 */
export const SUPPORTED_LOCKFILES = [
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'yarn.lock',
  'package-lock.json',
  'requirements.txt',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  'sbom.cdx.json',
  'cyclonedx.json',
  'sbom.json',
] as const;

/**
 * Locate and read the first supported lockfile in `dir`. Walks the
 * `SUPPORTED_LOCKFILES` list in order and returns the first match.
 * Returns `null` when no lockfile is present (caller decides whether
 * to skip the upload or fail loudly).
 *
 * Node.js-only: imports `node:fs` lazily so the function tree-shakes
 * out of Workers bundles. Callers that target Workers should pass the
 * lockfile content via build-time bundling and call
 * `reportDependencies` directly.
 */
export async function readLockfileFromDir(
  dir: string,
): Promise<LockfileFile | null> {
  // Lazy import keeps this out of Workers bundles. The dynamic specifier
  // also avoids static analyzers that flag `node:` imports in Workers
  // builds (they tree-shake when the function isn't called).
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const candidate of SUPPORTED_LOCKFILES) {
    const fullPath = path.join(dir, candidate);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return { filename: candidate, content };
    }
  }
  return null;
}

export interface ReportDependenciesOptions {
  managementUrl: string;
  agentId: string;
  /**
   * The agent's bearer token — typically the management agent secret.
   * `requireAuthOrApiKey` on the route accepts either a user JWT or an
   * agent token, so this works for both manual (CI) and runtime calls.
   */
  agentToken: string;
  /**
   * Either a raw lockfile (for parser-driven ingestion) or pre-parsed
   * dependency entries with the source lockfile's hash.
   */
  lockfile?: LockfileFile;
  dependencies?: ParsedDependency[];
  lockfileHash?: string;
  /** Override fetch (mostly for tests). */
  fetchImpl?: typeof fetch;
}

export interface ParsedDependency {
  ecosystem: string;
  packageName: string;
  packageVersion: string;
  depType: 'runtime' | 'dev' | 'transitive';
}

export interface ReportDependenciesResult {
  format: string;
  upserted: number;
  newAlerts: number;
  lockfileHash: string;
}

/**
 * POST the agent's lockfile / dependencies to Management. Returns the
 * server's parse summary. Throws on non-2xx responses; caller decides
 * whether to log-and-continue or hard-fail.
 */
export async function reportDependencies(
  opts: ReportDependenciesOptions,
): Promise<ReportDependenciesResult> {
  const { managementUrl, agentId, agentToken, fetchImpl = fetch } = opts;
  let body: Record<string, unknown>;
  if (opts.lockfile) {
    body = { lockfile: opts.lockfile };
  } else if (opts.dependencies && opts.lockfileHash) {
    body = { dependencies: opts.dependencies, lockfileHash: opts.lockfileHash };
  } else {
    throw new Error(
      'reportDependencies: pass either {lockfile} or {dependencies, lockfileHash}',
    );
  }
  const url = `${managementUrl.replace(/\/$/, '')}/v1/agents/${encodeURIComponent(agentId)}/dependencies`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `reportDependencies failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
  return (await response.json()) as ReportDependenciesResult;
}
