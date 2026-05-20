// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw Agent Chat E2E Tests
 *
 * True end-to-end: sends natural-language messages through the gateway agent
 * via `openclaw agent --json`. The LLM autonomously decides to invoke
 * Spellguard tools, testing the full path:
 *
 *   user message → LLM → tool selection → Spellguard → Verifier → peer agent
 *
 * Requires a configured LLM API key in the gateway agent; auto-skips when
 * unavailable. For gateway->plugin wiring tests that don't need an LLM key,
 * see openclaw-gateway-wiring.test.ts.
 *
 * Requires: Verifier (:3000), Agent A (:8787), Agent B (:8788), OpenClaw gateway,
 *           LLM API key configured in gateway agent, and a usable default model
 *           (e.g. `openclaw models set openrouter/anthropic/claude-sonnet-4`).
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  AGENT_A_URL,
  AGENT_B_URL,
  VERIFIER_URL,
  checkServerRunning,
} from './helpers/urls';

// openclaw 2026.5.7+ suppresses CLI output when it detects a test
// environment. It checks BOTH `NODE_ENV=test` (vitest's default for
// child processes) AND `VITEST=true`. Wrap execFile to override
// NODE_ENV and strip VITEST from the child's env on every CLI
// invocation. Without this, `openclaw models status --json` returns
// empty stdout and the model gate trips with `Default model "unknown"
// is not configured/usable`.
const _execFile = promisify(execFile);
const execAsync = (
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
) => {
  const { VITEST: _v1, ...baseEnv } = process.env;
  const { VITEST: _v2, ...overrideEnv } = opts.env ?? {};
  return _execFile(cmd, args, {
    ...opts,
    env: { ...baseEnv, ...overrideEnv, NODE_ENV: 'production' },
  });
};

// --- Verifier Types ---

interface VerifierStats {
  agents: number;
  channels: { total: number; active: number; stale: number };
  uptime: number;
  backends: { commitment: string; archive: string };
  logging: { commitments: number; archives: number };
}

interface CommitmentEntry {
  messageId: string;
  sender: string;
  recipient: string;
  hash: string;
  timestamp: number;
  attestationLevel: 'bilateral' | 'unilateral' | 'none';
  entryId: string;
  loggedAt: number;
  direction?: 'outbound' | 'inbound';
  a2aAgentUrl?: string;
  correlationId?: string;
}

interface CommitmentsResponse {
  count: number;
  commitments: CommitmentEntry[];
}

// --- Verifier Helpers ---

async function getVerifierStats(): Promise<VerifierStats | null> {
  try {
    const r = await fetch(`${VERIFIER_URL}/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

async function getVerifierCommitments(): Promise<CommitmentsResponse | null> {
  try {
    const r = await fetch(`${VERIFIER_URL}/logs/commitments`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

// --- Helpers ---

interface OpenClawConfig {
  gateway: {
    port: number;
    auth: { token: string };
  };
}

async function loadGatewayConfig(): Promise<{
  url: string;
  token: string;
} | null> {
  try {
    const raw = await readFile(
      join(homedir(), '.openclaw', 'openclaw.json'),
      'utf-8',
    );
    const config = JSON.parse(raw) as OpenClawConfig;
    return {
      url: `http://localhost:${config.gateway.port}`,
      token: config.gateway.auth.token,
    };
  } catch {
    return null;
  }
}

async function checkGatewayRunning(): Promise<boolean> {
  const config = await loadGatewayConfig();
  const url = config?.url ?? 'http://localhost:4000';
  return checkServerRunning(url);
}

async function checkGatewayAgentHasLlm(): Promise<boolean> {
  // The gateway agent stores LLM credentials in auth-profiles.json.
  // Check possible locations for a provider entry (anthropic, openrouter, etc.).
  const candidates = [
    join(
      homedir(),
      '.openclaw',
      'agents',
      'main',
      'agent',
      'auth-profiles.json',
    ),
    join(homedir(), '.openclaw', 'auth-profiles.json'),
  ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as {
        profiles?: Record<string, unknown>;
      };
      if (parsed.profiles && Object.keys(parsed.profiles).length > 0) {
        return true;
      }
    } catch {
      // file doesn't exist or is invalid, try next
    }
  }
  return false;
}

async function checkDefaultModelUsable(): Promise<{
  usable: boolean;
  defaultModel: string;
}> {
  // `openclaw models status --json` tells us which model is the default and
  // whether it is actually configured (i.e. has metadata + auth).
  try {
    const { stdout } = await execAsync(
      'openclaw',
      ['models', 'status', '--json'],
      { timeout: 10000 },
    );
    const status = JSON.parse(stdout) as {
      defaultModel?: string;
      allowed?: string[];
    };
    const defaultModel = status.defaultModel ?? 'unknown';
    const allowed = status.allowed ?? [];
    return { usable: allowed.includes(defaultModel), defaultModel };
  } catch {
    // Fallback: try plain text list and check for "default" + "configured" tags
    try {
      const { stdout } = await execAsync('openclaw', ['models', 'list'], {
        timeout: 10000,
      });
      // If the default model line also contains "configured", it's usable
      const defaultLine = stdout.split('\n').find((l) => l.includes('default'));
      if (defaultLine?.includes('configured')) {
        return {
          usable: true,
          defaultModel: defaultLine.trim().split(/\s+/)[0],
        };
      }
      // Default is tagged "missing" or has no "configured" tag
      const model = defaultLine?.trim().split(/\s+/)[0] ?? 'unknown';
      return { usable: false, defaultModel: model };
    } catch {
      return { usable: false, defaultModel: 'unknown' };
    }
  }
}

// --- Setup ---

const [gatewayUp, verifierUp, agentAUp, agentBUp] = await Promise.all([
  checkGatewayRunning(),
  checkServerRunning(VERIFIER_URL),
  checkServerRunning(AGENT_A_URL),
  checkServerRunning(AGENT_B_URL),
]);
const infraUp = gatewayUp && verifierUp && agentAUp && agentBUp;
const agentLlmAvailable = infraUp ? await checkGatewayAgentHasLlm() : false;
const modelCheck =
  infraUp && agentLlmAvailable
    ? await checkDefaultModelUsable()
    : { usable: false, defaultModel: 'unknown' };
// Check if the gateway's spellguard is configured and Verifier is healthy
let pluginReady = false;
if (infraUp) {
  const gwCfg = await loadGatewayConfig();
  const gwUrl = gwCfg?.url ?? 'http://localhost:4000';
  const gwToken = gwCfg?.token ?? '';
  try {
    const resp = await fetch(`${gwUrl}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gwToken}`,
      },
      body: JSON.stringify({ tool: 'spellguard_status', args: {} }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const body = (await resp.json()) as {
        ok: boolean;
        result?: { content: Array<{ type: string; text?: string }> };
      };
      const text = body.result?.content?.find((c) => c.type === 'text')?.text;
      if (text) {
        const status = JSON.parse(text) as {
          success: boolean;
          data?: { configured?: boolean; verifier?: { status: string } };
        };
        pluginReady =
          status.success &&
          status.data?.configured === true &&
          status.data?.verifier?.status === 'healthy';
      }
    }
  } catch {
    // Plugin check failed
  }
}
// Pre-flight: verify openclaw agent can actually complete an LLM call.
// Config checks (auth-profiles, models status) can pass even when the API key
// is expired or the user session is invalid, so we do a real smoke test.
let agentChatWorks = false;
if (infraUp && agentLlmAvailable && modelCheck.usable && pluginReady) {
  try {
    const { stdout } = await execAsync(
      'openclaw',
      [
        'agent',
        '--agent',
        'main',
        '--message',
        'Reply with ok',
        '--json',
        '--timeout',
        '30',
      ],
      { timeout: 35000 },
    );
    const parsed = JSON.parse(stdout) as {
      result?: { payloads?: Array<{ text?: string }> };
      response?: string;
      text?: string;
    };
    const text =
      parsed.result?.payloads
        ?.map((p) => p.text)
        .filter(Boolean)
        .join('') ??
      parsed.response ??
      parsed.text ??
      '';
    agentChatWorks =
      text.length > 0 &&
      !text.includes('401') &&
      !text.includes('User not found');
  } catch {
    agentChatWorks = false;
  }
}
const canRun =
  infraUp &&
  agentLlmAvailable &&
  modelCheck.usable &&
  pluginReady &&
  agentChatWorks;

if (!infraUp) {
  console.warn('\n  E2E servers not running.\n');
  console.warn(`   OpenClaw Gateway: ${gatewayUp ? 'Y' : 'N'}`);
  console.warn(`   Verifier (${VERIFIER_URL}): ${verifierUp ? 'Y' : 'N'}`);
  console.warn(`   Agent A (${AGENT_A_URL}): ${agentAUp ? 'Y' : 'N'}`);
  console.warn(`   Agent B (${AGENT_B_URL}): ${agentBUp ? 'Y' : 'N'}\n`);
  console.warn('   Skipping Agent Chat E2E tests.\n');
} else if (!agentLlmAvailable) {
  console.warn(
    '\n  Gateway agent has no LLM API key configured. Skipping Agent Chat E2E tests.\n',
  );
} else if (!modelCheck.usable) {
  console.warn(
    `\n  Default model "${modelCheck.defaultModel}" is not configured/usable.`,
  );
  console.warn(
    '  Set a working default model, e.g.: openclaw models set openrouter/anthropic/claude-sonnet-4',
  );
  console.warn('  Skipping Agent Chat E2E tests.\n');
} else if (!pluginReady) {
  console.warn(
    '\n  Gateway spellguard plugin not configured or Verifier unhealthy.',
  );
  console.warn('  Skipping Agent Chat E2E tests.\n');
} else if (!agentChatWorks) {
  console.warn(
    '\n  Pre-flight agent chat failed (LLM API key may be expired or user session invalid).',
  );
  console.warn('  Skipping Agent Chat E2E tests.\n');
}

// --- Agent chat helper ---

async function agentChat(message: string): Promise<string> {
  const { stdout } = await execAsync(
    'openclaw',
    [
      'agent',
      '--agent',
      'main',
      '--message',
      message,
      '--json',
      '--timeout',
      '120',
    ],
    { timeout: 130000 },
  );
  const result = JSON.parse(stdout) as {
    response?: string;
    text?: string;
    result?: { payloads?: Array<{ text?: string }> };
  };
  // OpenClaw agent --json returns { result: { payloads: [{ text }] } }
  const payloadText = result.result?.payloads
    ?.map((p) => p.text)
    .filter(Boolean)
    .join('\n');
  return payloadText ?? result.response ?? result.text ?? stdout;
}

// ---------------------------------------------------------------
// Agent Chat E2E
//
// The LLM agent autonomously invokes Spellguard tools in response
// to natural-language prompts. We verify both the response content
// and side-effects (Verifier commitment count).
// ---------------------------------------------------------------

describe.skipIf(!canRun)('Agent Chat E2E', () => {
  it('should use spellguard_route when asked to query another agent', async () => {
    const statsBefore = (await fetch(`${VERIFIER_URL}/stats`).then((r) =>
      r.json(),
    )) as { logging: { commitments: number } };
    const commitmentsBefore = statsBefore.logging.commitments;

    const response = await agentChat(
      'Use the spellguard_route tool with the prompt "What confidential data sets does agent-b have available?" and summarize the response.',
    );

    // The LLM should have produced a meaningful response containing data info
    const lower = response.toLowerCase();
    expect(
      lower.includes('data') ||
        lower.includes('salary') ||
        lower.includes('patient') ||
        lower.includes('employee') ||
        lower.includes('agent b') ||
        lower.includes('spellguard'),
    ).toBe(true);

    // Verifier commitments should have increased (proves spellguard_route was invoked)
    const statsAfter = (await fetch(`${VERIFIER_URL}/stats`).then((r) =>
      r.json(),
    )) as { logging: { commitments: number } };
    expect(
      statsAfter.logging.commitments,
      `Expected Verifier commitments to increase from ${commitmentsBefore} (spellguard_route should create a commitment). Response was: ${response.slice(0, 200)}`,
    ).toBeGreaterThan(commitmentsBefore);
  });

  it('should use spellguard_discover when asked about agent capabilities', async () => {
    const response = await agentChat(
      'Use the spellguard_discover tool to find out what Agent A can do. List its skills.',
    );

    const lower = response.toLowerCase();
    expect(
      lower.includes('agent') ||
        lower.includes('skill') ||
        lower.includes('capabilit'),
    ).toBe(true);
  });

  it('should use spellguard_status when asked about Verifier health', async () => {
    const response = await agentChat(
      'Check the Spellguard Verifier status and tell me if it is healthy.',
    );

    const lower = response.toLowerCase();
    expect(
      lower.includes('healthy') ||
        lower.includes('configured') ||
        lower.includes('status') ||
        lower.includes('verifier'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------
// Simple AI Call (No Spellguard Routing)
//
// Verifies the LLM can answer basic questions without invoking
// any Spellguard tools, matching bilateral test coverage.
// ---------------------------------------------------------------

describe.skipIf(!canRun)('Simple AI Call (No Spellguard Routing)', () => {
  it('should answer a simple math question without using Spellguard tools', async () => {
    const response = await agentChat(
      'What is 2 + 2? Reply with just the number.',
    );

    expect(response).toMatch(/\b4\b/);
  });
});

// ---------------------------------------------------------------
// Cross-Agent Data Retrieval
//
// Mirrors bilateral "Agent A -> Agent B" salary request test.
// The LLM routes a prompt via spellguard_route and retrieves
// specific data (salary statistics).
// ---------------------------------------------------------------

describe.skipIf(!canRun)('Cross-Agent Data Retrieval', () => {
  it('should retrieve salary statistics from Agent B', async () => {
    const response = await agentChat(
      'Use the spellguard_route tool with the prompt "Ask agent-b for a summary of employee salary statistics." and report the results.',
    );

    const lower = response.toLowerCase();
    expect(
      lower.includes('salary') ||
        lower.includes('salaries') ||
        lower.includes('employee') ||
        lower.includes('statistic') ||
        lower.includes('compensation'),
    ).toBe(true);
    // Should contain at least one number from the salary data
    expect(response).toMatch(/\d+/);
  });

  it('should retrieve patient medication data from Agent A via Agent B', async () => {
    const response = await agentChat(
      'Use the spellguard_route tool with the prompt "Ask agent-a what medications Benjamin Blake is taking." and report the medications.',
    );

    const lower = response.toLowerCase();
    expect(
      lower.includes('medication') ||
        lower.includes('ibuprofen') ||
        lower.includes('benjamin') ||
        lower.includes('blake') ||
        lower.includes('prescription'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------
// Verifier Logging Backends
//
// Mirrors bilateral "Verifier Logging Backends" test. Validates the
// Verifier has properly configured logging backends for commitments
// and archives.
// ---------------------------------------------------------------

describe.skipIf(!canRun)('Verifier Logging Backends', () => {
  it('should have working logging backends', async () => {
    const stats = await getVerifierStats();
    expect(stats, 'Verifier stats should be available').not.toBeNull();
    if (!stats) return;

    expect(stats.backends.commitment).toBeDefined();
    expect(stats.backends.archive).toBeDefined();

    expect(['memory', 'rekor']).toContain(stats.backends.commitment);
    expect(['memory', 's3']).toContain(stats.backends.archive);
  });

  it('should have recorded commitments from previous tests', async () => {
    const stats = await getVerifierStats();
    expect(stats, 'Verifier stats should be available').not.toBeNull();
    if (!stats) return;

    expect(stats.logging.commitments).toBeGreaterThan(0);
    expect(stats.logging.archives).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------
// Attestation Categorization
//
// Mirrors bilateral "Attestation Categorization" test. Validates
// that Verifier commitments have proper attestation levels and that
// no commitments have 'none' attestation.
// ---------------------------------------------------------------

describe.skipIf(!canRun)('Attestation Categorization', () => {
  it('should have no commitments with attestation level "none"', async () => {
    const commitments = await getVerifierCommitments();
    expect(
      commitments,
      'Verifier commitments should be available',
    ).not.toBeNull();
    if (!commitments) return;

    const none = commitments.commitments.filter(
      (c) => c.attestationLevel === 'none',
    );
    expect(none.length).toBe(0);
  });

  it('should have bilateral commitments between openclaw-agent and agent-b', async () => {
    const commitments = await getVerifierCommitments();
    expect(
      commitments,
      'Verifier commitments should be available',
    ).not.toBeNull();
    if (!commitments) return;

    const bilateral = commitments.commitments.filter(
      (c) =>
        c.attestationLevel === 'bilateral' &&
        (c.sender === 'openclaw-agent' || c.recipient === 'openclaw-agent'),
    );

    expect(
      bilateral.length,
      'Should have bilateral commitments involving openclaw-agent',
    ).toBeGreaterThan(0);
  });

  it('should have valid metadata on all commitments', async () => {
    const commitments = await getVerifierCommitments();
    expect(
      commitments,
      'Verifier commitments should be available',
    ).not.toBeNull();
    if (!commitments) return;

    for (const c of commitments.commitments) {
      expect(c.messageId).toBeDefined();
      expect(c.sender).toBeDefined();
      expect(c.recipient).toBeDefined();
      expect(c.hash).toBeDefined();
      expect(c.timestamp).toBeGreaterThan(0);
      expect(c.entryId).toBeDefined();
      expect(c.loggedAt).toBeGreaterThan(0);
      expect(['bilateral', 'unilateral', 'none']).toContain(c.attestationLevel);
    }
  });
});

// ---------------------------------------------------------------
// Bilateral Audit Trail Verification
//
// Mirrors bilateral "Agent A -> Agent B" audit trail assertions.
// Routes a prompt via the LLM and verifies the resulting Verifier
// commitment entries have correct sender, recipient, and
// attestation level.
// ---------------------------------------------------------------

describe.skipIf(!canRun)('Bilateral Audit Trail Verification', () => {
  it('should produce bilateral commitment entries after spellguard_route', async () => {
    const commitmentsBefore = await getVerifierCommitments();
    expect(commitmentsBefore).not.toBeNull();
    if (!commitmentsBefore) return;
    const beforeCount = commitmentsBefore.count;

    await agentChat(
      'Use the spellguard_route tool with the prompt "Audit trail verification test for agent-b."',
    );

    const commitmentsAfter = await getVerifierCommitments();
    expect(commitmentsAfter).not.toBeNull();
    if (!commitmentsAfter) return;

    expect(
      commitmentsAfter.count,
      'Commitment count should increase after spellguard_route',
    ).toBeGreaterThan(beforeCount);

    // Inspect the new commitment(s)
    const newCommitments = commitmentsAfter.commitments.slice(beforeCount);
    expect(newCommitments.length).toBeGreaterThan(0);

    // At least one new commitment should be bilateral between openclaw-agent and agent-b
    const bilateral = newCommitments.filter(
      (c) =>
        c.attestationLevel === 'bilateral' &&
        c.sender === 'openclaw-agent' &&
        (c.recipient === 'agent-b' || c.recipient === 'Agent B'),
    );
    expect(
      bilateral.length,
      `Expected bilateral commitment from openclaw-agent to agent-b. New commitments: ${JSON.stringify(newCommitments)}`,
    ).toBeGreaterThan(0);

    // Each bilateral commitment should have a valid hash and timestamps
    for (const c of bilateral) {
      expect(c.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(c.timestamp).toBeGreaterThan(0);
      expect(c.loggedAt).toBeGreaterThanOrEqual(c.timestamp);
    }
  });
});
