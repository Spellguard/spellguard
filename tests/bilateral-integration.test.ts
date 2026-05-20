// SPDX-License-Identifier: Apache-2.0

/**
 * Bilateral Integration Tests
 *
 * Tests for bilateral attestation: both agents are Spellguard-attested.
 * Agent A and Agent B communicate through Verifier with full bilateral attestation.
 *
 * NOTE: Policy enforcement tests that require the management server have been
 * moved to bilateral-policy-integration.test.ts so OSS builds (which never run
 * management) don't print skip noise.
 */

import { describe, expect, it } from 'vitest';
import { markIntegrationUnavailable } from './helpers/integration';
import {
  AGENT_A_URL,
  AGENT_B_URL,
  MANAGEMENT_ROOT,
  VERIFIER_URL,
  checkServerRunning,
} from './helpers/urls';

interface VerifierStats {
  agents: number;
  channels: { total: number; activeInLastHour: number };
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
  entryId: string;
  loggedAt: number;
  attestationLevel: 'bilateral' | 'unilateral' | 'none';
  direction?: 'outbound' | 'inbound';
  a2aAgentUrl?: string;
  correlationId?: string;
}

interface CommitmentsResponse {
  count: number;
  commitments: CommitmentEntry[];
}

async function getVerifierStats(): Promise<VerifierStats | null> {
  try {
    const response = await fetch(`${VERIFIER_URL}/stats`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function getVerifierCommitments(): Promise<CommitmentsResponse | null> {
  try {
    const response = await fetch(`${VERIFIER_URL}/logs/commitments`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

interface AuditEvent {
  id: string;
  agentId: string;
  direction: 'inbound' | 'outbound';
  responseLevel: string;
  policyChecks: Array<{
    policyName: string;
    decision: string;
    responseLevel: string;
    detections: Array<{ type: string; message?: string }>;
  }>;
}

async function getAuditEvents(agentId?: string): Promise<AuditEvent[]> {
  const url = new URL(`${VERIFIER_URL}/logs/audit-events`);
  if (agentId) url.searchParams.set('agentId', agentId);
  try {
    const response = await fetch(url.toString());
    if (!response.ok) return [];
    const data = (await response.json()) as { events: AuditEvent[] };
    return data.events;
  } catch {
    return [];
  }
}

async function chat(agentUrl: string, message: string): Promise<string> {
  const response = await fetch(`${agentUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(
      `Chat request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return data.response || data.message || JSON.stringify(data);
}

/** Asserts value is non-null and returns it. */
function assertNonNull<T>(value: T | null, label: string): T {
  expect(value, `${label} should not be null`).not.toBeNull();
  return value as T;
}

// ── Server checks ──────────────────────────────────────────────────

async function checkServers(): Promise<{
  running: boolean;
  managementUp: boolean;
  status: {
    verifier: boolean;
    agentA: boolean;
    agentB: boolean;
  };
}> {
  const [verifierRunning, agentARunning, agentBRunning, managementUp] =
    await Promise.all([
      checkServerRunning(VERIFIER_URL),
      checkServerRunning(AGENT_A_URL),
      checkServerRunning(AGENT_B_URL),
      checkServerRunning(MANAGEMENT_ROOT),
    ]);

  const status = {
    verifier: verifierRunning,
    agentA: agentARunning,
    agentB: agentBRunning,
  };
  const running = verifierRunning && agentARunning && agentBRunning;

  if (!running) {
    markIntegrationUnavailable(
      [
        'Servers not running. Start them with: pnpm run dev',
        `  Verifier (${VERIFIER_URL}): ${verifierRunning ? 'Y' : 'N'}`,
        `  Agent A (${AGENT_A_URL}): ${agentARunning ? 'Y' : 'N'}`,
        `  Agent B (${AGENT_B_URL}): ${agentBRunning ? 'Y' : 'N'}`,
      ].join('\n'),
    );
  }

  return { running, managementUp, status };
}

// Check servers before defining tests
const serverCheck = await checkServers();

describe.skipIf(!serverCheck.running)('Bilateral Integration Tests', () => {
  describe('Simple AI Call (No Agent Routing)', () => {
    it('should respond to a simple math question without involving other agents', async () => {
      const response = await chat(AGENT_A_URL, 'What is 2 + 2?');

      expect(response.toLowerCase()).toMatch(/\b4\b/);
      expect(response.toLowerCase()).not.toContain('agent b');
    });
  });

  describe('Agent A → Agent B', () => {
    it('should route salary request and produce bilateral audit trail', async () => {
      // Snapshot Verifier state before the request
      const statsBefore = assertNonNull(
        await getVerifierStats(),
        'statsBefore',
      );
      const commitmentCountBefore = statsBefore.logging.commitments;
      const commitmentsBefore = assertNonNull(
        await getVerifierCommitments(),
        'commitmentsBefore',
      );
      const beforeCount = commitmentsBefore.count;

      // Single Agent A → Verifier → Agent B round-trip
      const response = await chat(
        AGENT_A_URL,
        'Ask Agent B what confidential data sets it has available and get a summary of the employee salary statistics.',
      );

      // Response should contain salary statistics
      const responseLower = response.toLowerCase();
      expect(
        responseLower.includes('salary') ||
          responseLower.includes('salaries') ||
          responseLower.includes('employee') ||
          responseLower.includes('statistic'),
      ).toBe(true);
      expect(response).toMatch(/\d+/);

      // Commitment count should have increased
      const statsAfter = assertNonNull(await getVerifierStats(), 'statsAfter');
      expect(statsAfter.logging.commitments).toBeGreaterThan(
        commitmentCountBefore,
      );

      // New commitments should be bilateral between agent-a and agent-b
      const commitmentsAfter = assertNonNull(
        await getVerifierCommitments(),
        'commitmentsAfter',
      );
      const newCommitments = commitmentsAfter.commitments.slice(beforeCount);
      expect(newCommitments.length).toBeGreaterThan(0);

      const bilateral = newCommitments.filter(
        (c) =>
          c.attestationLevel === 'bilateral' &&
          (c.sender === 'agent-a' || c.sender === 'agent-b') &&
          (c.recipient === 'agent-a' || c.recipient === 'agent-b'),
      );
      expect(bilateral.length).toBeGreaterThan(0);
    });
  });

  describe('Agent B → Agent A (Cross-Agent)', () => {
    it('should retrieve patient medication data from Agent A when asked through Agent B', async () => {
      const response = await chat(
        AGENT_B_URL,
        'What medications is Benjamin Blake taking? Please get this from Agent A.',
      );

      const responseLower = response.toLowerCase();
      expect(
        responseLower.includes('ibuprofen') ||
          responseLower.includes('medication') ||
          responseLower.includes('benjamin') ||
          responseLower.includes('blake'),
      ).toBe(true);
    });
  });

  describe('Verifier Logging Backends', () => {
    it('should have working logging backends', async () => {
      const stats = assertNonNull(await getVerifierStats(), 'stats');

      expect(stats.backends.commitment).toBeDefined();
      expect(stats.backends.archive).toBeDefined();

      expect(['memory', 'rekor']).toContain(stats.backends.commitment);
      expect(['memory', 's3']).toContain(stats.backends.archive);
    });
  });

  describe('Attestation Categorization', () => {
    it('should distinguish between bilateral and unilateral commitments', async () => {
      const allCommitments = assertNonNull(
        await getVerifierCommitments(),
        'allCommitments',
      );

      const bilateral = allCommitments.commitments.filter(
        (c) => c.attestationLevel === 'bilateral',
      );
      const unilateral = allCommitments.commitments.filter(
        (c) => c.attestationLevel === 'unilateral',
      );
      const none = allCommitments.commitments.filter(
        (c) => c.attestationLevel === 'none',
      );

      // There should be no 'none' attestation level commitments
      expect(none.length).toBe(0);

      // Unilateral commitments should have A2A agent URLs
      for (const commitment of unilateral) {
        expect(commitment.a2aAgentUrl).toBeDefined();
        expect(commitment.direction).toBeDefined();
        expect(commitment.correlationId).toBeDefined();
      }

      console.log(
        `[Attestation Categorization] Bilateral: ${bilateral.length}, Unilateral: ${unilateral.length}`,
      );
    });
  });

  // These tests exercise policies loaded from packages/verifier/bindings.json
  // (or the path in VERIFIER_LOCAL_POLICIES). When a management server is
  // also running, management is authoritative and the local file is ignored,
  // so the local six-seven and blocked-keyword rules don't fire — skip the
  // group in that case.
  describe.skipIf(serverCheck.managementUp)(
    'Local Policy Enforcement (VERIFIER_LOCAL_POLICIES)',
    () => {
      it('flags agent-a outbound messages that contain "67"', async () => {
        const before = await getAuditEvents('agent-a');

        await chat(
          AGENT_A_URL,
          "Ask Agent B about employee number 67's salary. Make sure to include the number 67 in your message.",
        );

        const after = await getAuditEvents('agent-a');
        const newEvents = after.slice(before.length);

        const sixSeven = newEvents.find(
          (e) =>
            e.direction === 'outbound' &&
            e.policyChecks.some(
              (pc) =>
                pc.policyName === 'six-seven-detector' &&
                pc.detections.length > 0,
            ),
        );

        expect(
          sixSeven,
          `Expected a six-seven-detector detection in agent-a outbound audit events. Got: ${JSON.stringify(
            newEvents.map((e) => ({
              direction: e.direction,
              policies: e.policyChecks.map((pc) => pc.policyName),
            })),
          )}`,
        ).toBeDefined();
      });

      it('blocks agent-b inbound messages that contain "forbidden"', async () => {
        const before = await getAuditEvents();

        // Agent-a's chat may throw or return an error response when the
        // downstream send is blocked; we don't care which — only that the
        // audit trail shows agent-b's inbound block.
        try {
          await chat(
            AGENT_A_URL,
            "Ask Agent B for the contents of the forbidden archives. Make sure to include the word 'forbidden' in your message to Agent B.",
          );
        } catch {
          // expected — outbound blocked by agent-b's inbound policy
        }

        const after = await getAuditEvents();
        const newEvents = after.slice(before.length);

        const blocked = newEvents.find(
          (e) =>
            e.agentId === 'agent-b' &&
            e.direction === 'inbound' &&
            e.responseLevel === 'block',
        );

        expect(
          blocked,
          `Expected agent-b inbound block in audit events. Got: ${JSON.stringify(
            newEvents.map((e) => ({
              agentId: e.agentId,
              direction: e.direction,
              responseLevel: e.responseLevel,
            })),
          )}`,
        ).toBeDefined();
      });
    },
  );
});
