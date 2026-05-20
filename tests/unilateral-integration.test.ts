// SPDX-License-Identifier: Apache-2.0

/**
 * Unilateral Integration Tests
 *
 * Tests for unilateral attestation: Spellguard agent communicating with A2A-only agents.
 * Agent A (Spellguard-attested) communicates with Agent C (A2A-only) through Verifier.
 *
 * NOTE: Policy enforcement tests that require the management server have been
 * moved to unilateral-policy-integration.test.ts so OSS builds (which never run
 * management) don't print skip noise.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_A_URL,
  AGENT_C_URL,
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

async function getVerifierStats(): Promise<VerifierStats | null> {
  try {
    const response = await fetch(`${VERIFIER_URL}/stats`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

// ── Server checks ──────────────────────────────────────────────────

interface ServerStatus {
  running: boolean;
  status: {
    verifier: boolean;
    agentA: boolean;
    agentC: boolean;
  };
}

async function checkServers(): Promise<ServerStatus> {
  const [verifierRunning, agentARunning, agentCRunning] = await Promise.all([
    checkServerRunning(VERIFIER_URL),
    checkServerRunning(AGENT_A_URL),
    checkServerRunning(AGENT_C_URL),
  ]);

  const status = {
    verifier: verifierRunning,
    agentA: agentARunning,
    agentC: agentCRunning,
  };
  const running = verifierRunning && agentARunning && agentCRunning;

  if (!running) {
    console.warn('\n  Servers not running for unilateral integration tests.\n');
    console.warn(
      `   Verifier (${VERIFIER_URL}): ${verifierRunning ? 'Y' : 'N'}`,
    );
    console.warn(`   Agent A (${AGENT_A_URL}): ${agentARunning ? 'Y' : 'N'}`);
    console.warn(`   Agent C (${AGENT_C_URL}): ${agentCRunning ? 'Y' : 'N'}`);
    console.warn('   Skipping unilateral integration tests.\n');
  }

  return { running, status };
}

/** Asserts value is non-null and returns it (avoids repeated expect+if guard). */
function assertNonNull<T>(value: T | null, label: string): T {
  expect(value, `${label} should not be null`).not.toBeNull();
  return value as T;
}

// Check servers before running tests
const serverCheck = await checkServers();

describe.skipIf(!serverCheck.running)('Unilateral Integration Tests', () => {
  describe('Agent C Discovery', () => {
    it('should have a valid agent card without spellguard-verifier auth', async () => {
      const response = await fetch(`${AGENT_C_URL}/.well-known/agent.json`);
      expect(response.ok).toBe(true);

      const agentCard = await response.json();
      expect(agentCard.name).toBe('agent-c');
      expect(agentCard.skills).toBeDefined();
      expect(Array.isArray(agentCard.skills)).toBe(true);

      // Agent C should NOT have spellguard-verifier authentication
      if (agentCard.authentication?.schemes) {
        expect(agentCard.authentication.schemes).not.toContain(
          'spellguard-verifier',
        );
      }
    });

    it('should be discoverable via Verifier resolver', async () => {
      const response = await fetch(`${VERIFIER_URL}/agents/resolve/agent-c`);

      // May or may not succeed depending on if agent-c is registered
      // but the endpoint should work
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('A2A Protocol Compliance', () => {
    it('should respond to A2A JSON-RPC requests', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'ping' }],
          },
        },
      };

      const response = await fetch(`${AGENT_C_URL}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      expect(response.ok).toBe(true);

      const a2aResponse = await response.json();
      expect(a2aResponse.jsonrpc).toBe('2.0');
      expect(a2aResponse.id).toBe('test-1');
      expect(a2aResponse.result).toBeDefined();
      expect(a2aResponse.result.status.state).toBe('completed');
    });

    it('should return weather data when asked', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 'test-weather',
        method: 'tasks/send',
        params: {
          id: 'task-weather',
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'What is the current weather?' }],
          },
        },
      };

      const response = await fetch(`${AGENT_C_URL}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      expect(response.ok).toBe(true);

      const a2aResponse = await response.json();
      const responseText = a2aResponse.result?.artifacts?.[0]?.parts?.[0]?.text;
      expect(responseText).toBeDefined();
      expect(responseText.toLowerCase()).toContain('weather');
      expect(responseText).toContain('San Francisco');
    });

    it('should return stock data when asked', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 'test-stocks',
        method: 'tasks/send',
        params: {
          id: 'task-stocks',
          message: {
            role: 'user',
            parts: [
              { type: 'text', text: 'What are the current stock prices?' },
            ],
          },
        },
      };

      const response = await fetch(`${AGENT_C_URL}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      expect(response.ok).toBe(true);

      const a2aResponse = await response.json();
      const responseText = a2aResponse.result?.artifacts?.[0]?.parts?.[0]?.text;
      expect(responseText).toBeDefined();
      // Should contain at least one stock symbol or stock-related term
      const responseLower = responseText.toLowerCase();
      expect(
        responseText.includes('AAPL') ||
          responseText.includes('GOOGL') ||
          responseText.includes('MSFT') ||
          responseText.includes('NVDA') ||
          responseLower.includes('stock') ||
          responseLower.includes('price'),
      ).toBe(true);
    });
  });

  describe('Verifier Unilateral Endpoint', () => {
    // Note: These tests require Agent A to be registered with Verifier first
    // In a real scenario, Agent A would need to establish a channel before
    // sending to A2A-only agents

    it('should reject requests without channel token', async () => {
      const response = await fetch(`${VERIFIER_URL}/messages/unilateral`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: 'agent-a',
          a2aAgentUrl: AGENT_C_URL,
          payload: { text: 'Hello' },
        }),
      });

      expect(response.status).toBe(401);
      const error = await response.json();
      expect(error.error).toContain('Missing channel token');
    });

    it('should reject requests with missing fields', async () => {
      const response = await fetch(`${VERIFIER_URL}/messages/unilateral`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': 'fake-token',
        },
        body: JSON.stringify({
          sender: 'agent-a',
          // Missing a2aAgentUrl and payload
        }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('Missing required fields');
    });
  });

  describe('Policy Enforcement', () => {
    it('should validate A2A requests have proper JSON-RPC format', async () => {
      // Invalid request (missing jsonrpc version)
      const invalidRequest = {
        id: 'test-invalid',
        method: 'tasks/send',
        params: {},
      };

      const response = await fetch(`${AGENT_C_URL}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidRequest),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error.code).toBe(-32600); // Invalid Request
    });
  });

  describe('Verifier Logging Backends', () => {
    it('should have working logging backends', async () => {
      const stats = await getVerifierStats();
      expect(stats).not.toBeNull();
      if (!stats) return;

      expect(stats.backends.commitment).toBeDefined();
      expect(stats.backends.archive).toBeDefined();

      expect(['memory', 'rekor']).toContain(stats.backends.commitment);
      expect(['memory', 's3']).toContain(stats.backends.archive);
    });
  });

  // Local-bindings-driven policy enforcement is covered by the bilateral
  // integration suite. The unilateral routing path uses the same loader and
  // same policy engines, so an extra wrapper here doesn't gain coverage —
  // and routing through agent-a → agent-c requires management to discover
  // agent-c's URL (see PR #242 follow-up notes).
});

describe.skipIf(!serverCheck.status.agentC)('Agent C Standalone Tests', () => {
  it('should report health status', async () => {
    const response = await fetch(`${AGENT_C_URL}/health`);
    expect(response.ok).toBe(true);

    const health = await response.json();
    expect(health.status).toBe('ok');
    expect(health.agent).toBe('agent-c');
    expect(health.type).toBe('external-a2a-only');
    // llmEnabled depends on whether OPENROUTER_API_KEY is set
    expect(typeof health.llmEnabled).toBe('boolean');
  });

  it('should list available data when asked', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 'test-data',
      method: 'tasks/send',
      params: {
        id: 'task-data',
        message: {
          role: 'user',
          parts: [{ type: 'text', text: 'What data do you provide?' }],
        },
      },
    };

    const response = await fetch(`${AGENT_C_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.ok).toBe(true);

    const a2aResponse = await response.json();
    const responseText = a2aResponse.result?.artifacts?.[0]?.parts?.[0]?.text;
    expect(responseText).toBeDefined();
    expect(responseText.toLowerCase()).toContain('weather');
    expect(responseText.toLowerCase()).toContain('stock');
  });
});
