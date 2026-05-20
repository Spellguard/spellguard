// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw Gateway Plugin Wiring Tests
 *
 * Verifies the gateway correctly loads the Spellguard plugin, registers its
 * tools, and routes `/tools/invoke` calls to the plugin's tool functions.
 * This bypasses the LLM and tests the gateway->plugin integration directly.
 *
 * Auto-skips when the OpenClaw gateway, Verifier, or agents are not running.
 *
 * Requires: Verifier (:3000), Agent A (:8787), Agent B (:8788), OpenClaw gateway.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type {
  DiscoverData,
  RouteData,
  StatusData,
  ToolResult,
} from '../packages/openclaw-plugin/src/types';
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
// invocation. Without this, every `openclaw plugins ...` call here
// returns empty stdout (verified: clearing only NODE_ENV is not
// enough -- VITEST alone is sufficient to trigger suppression).
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

const WEBHOOK_URL = 'http://localhost:9000';
const WEBHOOK_RECEIVE = `${WEBHOOK_URL}/_spellguard/receive`;
const WEBHOOK_HEALTH = `${WEBHOOK_URL}/_spellguard/health`;
const AGENT_CARD_URL = `${WEBHOOK_URL}/.well-known/agent.json`;

// --- Gateway config ---

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

// --- Helpers ---

async function checkGatewayRunning(): Promise<boolean> {
  const config = await loadGatewayConfig();
  const url = config?.url ?? 'http://localhost:4000';
  return checkServerRunning(url);
}

// --- Setup ---

const gwConfig = await loadGatewayConfig();
const GATEWAY_URL = gwConfig?.url ?? 'http://localhost:4000';
const GATEWAY_TOKEN = gwConfig?.token ?? '';

const [gatewayUp, verifierUp, agentAUp, agentBUp] = await Promise.all([
  checkGatewayRunning(),
  checkServerRunning(VERIFIER_URL),
  checkServerRunning(AGENT_A_URL),
  checkServerRunning(AGENT_B_URL),
]);
const infraUp = gatewayUp && verifierUp && agentAUp && agentBUp;

// Check if the gateway's spellguard is configured and Verifier is healthy
let pluginReady = false;
if (infraUp) {
  try {
    const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
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
    // Plugin check failed — will skip
  }
}
const canRun = infraUp && pluginReady;

if (!infraUp) {
  console.warn('\n  Gateway wiring servers not running.\n');
  console.warn(`   OpenClaw Gateway: ${gatewayUp ? 'Y' : 'N'}`);
  console.warn(`   Verifier (${VERIFIER_URL}): ${verifierUp ? 'Y' : 'N'}`);
  console.warn(`   Agent A (${AGENT_A_URL}): ${agentAUp ? 'Y' : 'N'}`);
  console.warn(`   Agent B (${AGENT_B_URL}): ${agentBUp ? 'Y' : 'N'}\n`);
  console.warn('   Skipping gateway wiring tests.\n');
} else if (!pluginReady) {
  console.warn(
    '\n  Gateway spellguard plugin not configured or Verifier unhealthy.\n',
  );
  console.warn('   Skipping gateway wiring tests.\n');
}

// --- Gateway tool invocation helper ---

interface GatewayToolResponse {
  ok: boolean;
  result?: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
  error?: string;
}

async function invokeGatewayTool<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult<T>> {
  const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({ tool: name, args }),
  });

  if (!resp.ok) {
    throw new Error(
      `Gateway returned HTTP ${resp.status}: ${await resp.text()}`,
    );
  }

  const body = (await resp.json()) as GatewayToolResponse;

  if (!body.ok || !body.result) {
    throw new Error(
      `Gateway tool invocation failed: ${body.error ?? 'unknown'}`,
    );
  }

  const textContent = body.result.content.find((c) => c.type === 'text');
  if (!textContent || !textContent.text) {
    throw new Error('No text content in gateway tool response');
  }

  return JSON.parse(textContent.text) as ToolResult<T>;
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe.skipIf(!canRun)('Gateway Plugin Wiring', () => {
  // -----------------------------------------------------------
  // Plugin & Tools (CLI verification)
  // -----------------------------------------------------------
  describe('Plugin & Tools', () => {
    it('should have the spellguard plugin loaded', async () => {
      // First CLI invocation can be slow (cold-start), allow up to 60s
      const { stdout } = await execAsync(
        'openclaw',
        ['plugins', 'info', 'spellguard'],
        { timeout: 60000 },
      );

      expect(stdout).toContain('spellguard');
      expect(stdout).toMatch(/Status:\s*loaded/);
    });

    it('should have spellguard tools registered', async () => {
      // `openclaw plugins info` doesn't surface registered tool names, so
      // probe each tool via the gateway's `/tools/invoke` HTTP API. We
      // don't care what status the tool returns — only that the gateway
      // routes the invocation to a registered tool (i.e. NOT
      // `tool_call_blocked: not_found`).
      for (const tool of [
        'spellguard_route',
        'spellguard_status',
        'spellguard_discover',
      ]) {
        const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GATEWAY_TOKEN}`,
          },
          body: JSON.stringify({ tool, args: {} }),
        });
        const body = (await resp.json()) as {
          error?: { type?: string; message?: string };
        };
        expect(body.error?.type).not.toBe('not_found');
      }
    });

    it('should have the webhook server responding on the configured selfUrl', async () => {
      const resp = await fetch(WEBHOOK_HEALTH, {
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as { status: string; agentId: string };
      expect(body.status).toBe('ok');
      expect(body.agentId).toBe('openclaw-agent');
    });

    it('should serve an agent card from the webhook server', async () => {
      const resp = await fetch(AGENT_CARD_URL, {
        signal: AbortSignal.timeout(5000),
      });
      expect(resp.status).toBe(200);

      const card = (await resp.json()) as {
        name: string;
        url: string;
        skills: unknown[];
      };
      expect(card.name).toBe('openclaw-agent');
      expect(card.url).toBeDefined();
      expect(card.skills.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------
  // Verifier Status (via /tools/invoke)
  // -----------------------------------------------------------
  describe('Verifier Status', () => {
    it('should report healthy Verifier status', async () => {
      const result = await invokeGatewayTool<StatusData>(
        'spellguard_status',
        {},
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.configured).toBe(true);
      expect(result.data.verifier.status).toBe('healthy');
      expect(result.data.self.agentId).toBe('openclaw-agent');
      expect(result.data.self.webhookUrl).toBe(WEBHOOK_URL);
    });
  });

  // -----------------------------------------------------------
  // Route to Agent B (via /tools/invoke)
  // -----------------------------------------------------------
  describe('Route to Agent B', () => {
    it('should route a prompt and collect agent responses', async () => {
      const result = await invokeGatewayTool<RouteData>('spellguard_route', {
        prompt: 'What data sets does agent-b have available?',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.agentResponses.length).toBeGreaterThan(0);
      expect(result.data.contextBlock).toBeTruthy();
    });
  });

  // -----------------------------------------------------------
  // Verifier Audit Trail
  // -----------------------------------------------------------
  describe('Verifier Audit Trail', () => {
    it('should increase commitment count after routing via gateway', async () => {
      const statsBefore = (await fetch(`${VERIFIER_URL}/stats`).then((r) =>
        r.json(),
      )) as { logging: { commitments: number } };
      const commitmentsBefore = statsBefore.logging.commitments;

      await invokeGatewayTool<RouteData>('spellguard_route', {
        prompt: 'Hello from the audit trail test, agent-b.',
      });

      const statsAfter = (await fetch(`${VERIFIER_URL}/stats`).then((r) =>
        r.json(),
      )) as { logging: { commitments: number } };
      const commitmentsAfter = statsAfter.logging.commitments;

      expect(commitmentsAfter).toBeGreaterThan(commitmentsBefore);
    });
  });

  // -----------------------------------------------------------
  // Agent Discovery (via /tools/invoke)
  // -----------------------------------------------------------
  describe('Agent Discovery', () => {
    it('should discover Agent A capabilities', async () => {
      const result = await invokeGatewayTool<DiscoverData>(
        'spellguard_discover',
        { agentId: 'agent-a' },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.agentCard).toBeDefined();
      expect(result.data.agentCard.name).toBeDefined();
      expect(result.data.agentCard.url).toBeDefined();
      expect(result.data.agentCard.skills).toBeDefined();
    });

    it('should discover Agent B capabilities', async () => {
      const result = await invokeGatewayTool<DiscoverData>(
        'spellguard_discover',
        { agentId: 'agent-b' },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.agentCard.name).toBeDefined();
      expect(result.data.agentCard.url).toContain('8788');
    });
  });

  // -----------------------------------------------------------
  // Error Handling (via /tools/invoke)
  // -----------------------------------------------------------
  describe('Error Handling', () => {
    it('should return RECIPIENT_NOT_FOUND for nonexistent agent', async () => {
      const result = await invokeGatewayTool<DiscoverData>(
        'spellguard_discover',
        { agentId: 'nonexistent-agent-xyz' },
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe('RECIPIENT_NOT_FOUND');
      expect(result.error.message).toContain('nonexistent-agent-xyz');
    });

    it('should return INVALID_INPUT for missing required fields', async () => {
      const result = await invokeGatewayTool<RouteData>('spellguard_route', {});

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe('INVALID_INPUT');
    });
  });

  // -----------------------------------------------------------
  // Inbound Message Delivery (direct webhook HTTP)
  // -----------------------------------------------------------
  describe('Inbound Message Delivery', () => {
    it('should accept inbound message and return success', async () => {
      const resp = await fetch(WEBHOOK_RECEIVE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': 'test-token',
        },
        body: JSON.stringify({
          message: 'Hello from wiring test',
          senderId: 'test-sender',
          messageId: `msg_wiring_${Date.now()}`,
          timestamp: Date.now(),
        }),
      });

      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('should return HTTP 401 when channel token is missing', async () => {
      const resp = await fetch(WEBHOOK_RECEIVE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'No token',
          senderId: 'test-sender',
          messageId: `msg_wiring_notoken_${Date.now()}`,
          timestamp: Date.now(),
        }),
      });

      expect(resp.status).toBe(401);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toContain('Missing channel token');
    });

    it('should return HTTP 400 for invalid JSON body', async () => {
      const resp = await fetch(WEBHOOK_RECEIVE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': 'test-token',
        },
        body: 'not valid json{{{',
      });

      expect(resp.status).toBe(400);
    });

    it('should return HTTP 400 when required fields are missing', async () => {
      const resp = await fetch(WEBHOOK_RECEIVE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': 'test-token',
        },
        body: JSON.stringify({ irrelevant: true }),
      });

      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toContain('Missing required fields');
    });
  });

  // -----------------------------------------------------------
  // Full Round-Trip (tool invoke + webhook receive)
  // -----------------------------------------------------------
  describe('Full Round-Trip', () => {
    it('should complete outbound route then inbound receive', async () => {
      // --- Outbound via /tools/invoke ---
      const commitmentsBefore = (await fetch(
        `${VERIFIER_URL}/logs/commitments`,
      ).then((r) => r.json())) as { count: number };
      const beforeCommitCount = commitmentsBefore.count;

      const routeResult = await invokeGatewayTool<RouteData>(
        'spellguard_route',
        { prompt: 'Round-trip outbound leg for agent-b.' },
      );

      expect(routeResult.success).toBe(true);

      const commitmentsAfter = (await fetch(
        `${VERIFIER_URL}/logs/commitments`,
      ).then((r) => r.json())) as { count: number };
      expect(commitmentsAfter.count).toBeGreaterThan(beforeCommitCount);

      // --- Inbound via webhook ---
      const resp = await fetch(WEBHOOK_RECEIVE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': 'test-token',
        },
        body: JSON.stringify({
          message: 'Round-trip inbound leg.',
          senderId: 'agent-b',
          messageId: `msg_wiring_roundtrip_${Date.now()}`,
          timestamp: Date.now(),
        }),
      });

      expect(resp.status).toBe(200);
    });
  });
});
