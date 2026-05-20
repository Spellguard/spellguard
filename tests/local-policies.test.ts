// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLocalAgentPolicies,
  resetLocalPoliciesForTesting,
} from '../packages/verifier/src/management/local-policies';

const SAVED_ENV = process.env.VERIFIER_LOCAL_POLICIES;
const SAVED_CWD = process.cwd();

let scratchDir: string;

function writeBindings(contents: unknown): string {
  const path = join(scratchDir, 'bindings.json');
  writeFileSync(
    path,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    'utf-8',
  );
  return path;
}

function clearLocalPoliciesEnv(): void {
  // `process.env.X = undefined` would coerce to the literal string "undefined"
  // (truthy), so we need actual `delete` to leave the var unset.
  // biome-ignore lint/performance/noDelete: required to unset process.env entries
  delete process.env.VERIFIER_LOCAL_POLICIES;
}

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'sg-local-policies-'));
  clearLocalPoliciesEnv();
  resetLocalPoliciesForTesting();
});

afterEach(() => {
  resetLocalPoliciesForTesting();
  if (SAVED_ENV === undefined) {
    clearLocalPoliciesEnv();
  } else {
    process.env.VERIFIER_LOCAL_POLICIES = SAVED_ENV;
  }
  process.chdir(SAVED_CWD);
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('local-policies loader', () => {
  it('returns null when no file is configured and no convention file exists', () => {
    process.chdir(scratchDir); // empty dir → no bindings.json at cwd
    expect(getLocalAgentPolicies('agent-a')).toBeNull();
  });

  it('loads from VERIFIER_LOCAL_POLICIES path when set', () => {
    const path = writeBindings({
      agents: {
        'agent-a': {
          outbound: [
            {
              policyId: 'p1',
              policySlug: 'regex-detect',
              policyType: 'regex',
              effect: 'flag',
            },
          ],
          inbound: [],
        },
      },
    });
    process.env.VERIFIER_LOCAL_POLICIES = path;

    const cfg = getLocalAgentPolicies('agent-a');
    expect(cfg).not.toBeNull();
    expect(cfg?.outbound).toHaveLength(1);
    expect(cfg?.outbound[0].policyId).toBe('p1');
  });

  it('falls back to <cwd>/bindings.json when env var is unset', () => {
    writeBindings({
      agents: {
        'agent-a': {
          outbound: [
            {
              policyId: 'cwd-p',
              policySlug: 'kw',
              policyType: 'keyword',
              effect: 'flag',
            },
          ],
          inbound: [],
        },
      },
    });
    process.chdir(scratchDir);
    const cfg = getLocalAgentPolicies('agent-a');
    expect(cfg?.outbound[0].policyId).toBe('cwd-p');
  });

  it('env var override beats the convention path', () => {
    // Write a "wrong" file at cwd convention path
    writeBindings({
      agents: {
        'agent-a': {
          outbound: [
            {
              policyId: 'cwd-loser',
              policySlug: 'kw',
              policyType: 'keyword',
              effect: 'flag',
            },
          ],
        },
      },
    });
    process.chdir(scratchDir);

    // Write the "right" file at an explicit env-pointed path
    const otherDir = mkdtempSync(join(tmpdir(), 'sg-other-'));
    const envPath = join(otherDir, 'override.json');
    writeFileSync(
      envPath,
      JSON.stringify({
        agents: {
          'agent-a': {
            outbound: [
              {
                policyId: 'env-winner',
                policySlug: 'kw',
                policyType: 'keyword',
                effect: 'flag',
              },
            ],
          },
        },
      }),
      'utf-8',
    );
    process.env.VERIFIER_LOCAL_POLICIES = envPath;

    expect(getLocalAgentPolicies('agent-a')?.outbound[0].policyId).toBe(
      'env-winner',
    );

    rmSync(otherDir, { recursive: true, force: true });
  });

  it('returns null for unknown agent when no default is configured', () => {
    writeBindings({
      agents: {
        'agent-a': { outbound: [], inbound: [] },
      },
    });
    process.chdir(scratchDir);
    expect(getLocalAgentPolicies('not-listed')).toBeNull();
  });

  it('falls back to the default block for unlisted agents', () => {
    writeBindings({
      default: {
        outbound: [
          {
            policyId: 'def-p',
            policySlug: 'inj',
            policyType: 'injection',
            effect: 'flag',
          },
        ],
      },
      agents: {
        'agent-a': { outbound: [], inbound: [] },
      },
    });
    process.chdir(scratchDir);
    expect(getLocalAgentPolicies('agent-z')?.outbound[0].policyId).toBe(
      'def-p',
    );
  });

  it('per-agent config replaces the default (no merge)', () => {
    writeBindings({
      default: {
        outbound: [
          {
            policyId: 'def-p',
            policySlug: 'inj',
            policyType: 'injection',
            effect: 'flag',
          },
        ],
      },
      agents: {
        'agent-a': {
          outbound: [
            {
              policyId: 'agent-p',
              policySlug: 'kw',
              policyType: 'keyword',
              effect: 'block',
            },
          ],
        },
      },
    });
    process.chdir(scratchDir);
    const cfg = getLocalAgentPolicies('agent-a');
    expect(cfg?.outbound).toHaveLength(1);
    expect(cfg?.outbound[0].policyId).toBe('agent-p');
  });

  it('auto-fills missing per-binding defaults (level → "org")', () => {
    writeBindings({
      agents: {
        'agent-a': {
          outbound: [
            {
              policyId: 'p1',
              policySlug: 'kw',
              policyType: 'keyword',
              effect: 'flag',
              // level omitted on purpose
            },
          ],
        },
      },
    });
    process.chdir(scratchDir);
    expect(getLocalAgentPolicies('agent-a')?.outbound[0].level).toBe('org');
  });

  it('synthesizes server-side fields (version is content-stable)', () => {
    writeBindings({
      agents: {
        'agent-a': {
          outbound: [
            {
              policyId: 'p1',
              policySlug: 'kw',
              policyType: 'keyword',
              effect: 'flag',
            },
          ],
        },
      },
    });
    process.chdir(scratchDir);
    const cfg = getLocalAgentPolicies('agent-a');
    expect(cfg?.version).toMatch(/^local-[0-9a-f]{16}$/);
    expect(cfg?.signature).toBe('');
    expect(cfg?.resolvedAt).toBeGreaterThan(0);
    expect(cfg?.expiresAt).toBeGreaterThan(cfg?.resolvedAt ?? 0);
  });

  it('throws on invalid JSON', () => {
    writeBindings('{ not valid json');
    process.chdir(scratchDir);
    expect(() => getLocalAgentPolicies('agent-a')).toThrow(/Invalid JSON/);
  });

  it('throws when neither "default" nor "agents" is present', () => {
    writeBindings({ unrelated: true });
    process.chdir(scratchDir);
    expect(() => getLocalAgentPolicies('agent-a')).toThrow(/default.*agents/);
  });

  it('throws when env-pointed path is missing', () => {
    process.env.VERIFIER_LOCAL_POLICIES = join(
      scratchDir,
      'does-not-exist.json',
    );
    // Explicit user intent — missing file is an error, not a silent fallback.
    expect(() => getLocalAgentPolicies('agent-a')).toThrow(/Failed to read/);
  });
});
