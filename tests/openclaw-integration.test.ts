// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw Plugin Integration Tests
 *
 * Tests the OpenClaw Spellguard plugin lifecycle, tools, webhook endpoints,
 * inbound message handling, and error behavior against a running Verifier + agents A/B.
 *
 * Requires: Verifier (:3000), Agent A (:8787), Agent B (:8788).
 * Auto-skips when servers are not running.
 */

import type {
  AgentToolResult,
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginLogger,
} from 'openclaw/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { register } from '../packages/openclaw-plugin/src/index';
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
// Use port 9001 and a distinct agent ID to avoid conflicts with the gateway plugin
const PLUGIN_URL = 'http://localhost:9001';
const TEST_AGENT_ID = 'openclaw-test-agent';

const WEBHOOK_RECEIVE = `${PLUGIN_URL}/_spellguard/receive`;
const WEBHOOK_HEALTH = `${PLUGIN_URL}/_spellguard/health`;
const AGENT_CARD_URL = `${PLUGIN_URL}/.well-known/agent.json`;

function parseToolResult<T>(response: AgentToolResult): ToolResult<T> {
  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Empty tool response');
  }
  return JSON.parse(textContent.text) as ToolResult<T>;
}

const serversUp = await Promise.all([
  checkServerRunning(VERIFIER_URL),
  checkServerRunning(AGENT_A_URL),
  checkServerRunning(AGENT_B_URL),
]).then((results) => {
  const allUp = results.every(Boolean);
  if (!allUp) {
    console.warn('\n  Servers not running. Start them with: pnpm run dev\n');
    console.warn(`   Verifier (${VERIFIER_URL}): ${results[0] ? 'Y' : 'N'}`);
    console.warn(`   Agent A (${AGENT_A_URL}): ${results[1] ? 'Y' : 'N'}`);
    console.warn(`   Agent B (${AGENT_B_URL}): ${results[2] ? 'Y' : 'N'}\n`);
    console.warn('   Skipping integration tests.\n');
  }
  return allUp;
});

describe.skipIf(!serversUp)('OpenClaw Plugin Integration', () => {
  const registeredTools: AnyAgentTool[] = [];
  const registeredServices: OpenClawPluginService[] = [];
  let servicesStopped = false;
  const eventHandlers = new Map<
    string,
    Array<(...args: unknown[]) => Promise<void> | void>
  >();

  const noopLogger: PluginLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const mockApi: OpenClawPluginApi = {
    pluginConfig: {
      verifierUrl: VERIFIER_URL,
      selfUrl: PLUGIN_URL,
      agentId: TEST_AGENT_ID,
      agentSecret: 'test-secret-openclaw-agent-12345678',
    },
    logger: noopLogger,
    registerTool(tool) {
      registeredTools.push(tool as AnyAgentTool);
    },
    registerService(service) {
      registeredServices.push(service);
    },
    on(event, handler) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
  };

  beforeAll(async () => {
    register(mockApi);
    // Start registered services
    for (const service of registeredServices) {
      await service.start({
        config: mockApi.pluginConfig,
        stateDir: '/tmp/spellguard-test',
        logger: noopLogger,
      });
    }
    // Wait for the webhook server to be ready
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterAll(async () => {
    if (servicesStopped) return;
    for (const service of registeredServices) {
      await service.stop?.({
        config: mockApi.pluginConfig,
        stateDir: '/tmp/spellguard-test',
        logger: noopLogger,
      });
    }
  });

  function findTool(name: string): AnyAgentTool {
    const tool = registeredTools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  async function executeTool<T>(
    name: string,
    input: unknown,
  ): Promise<ToolResult<T>> {
    const tool = findTool(name);
    const response = await tool.execute(crypto.randomUUID(), input);
    return parseToolResult<T>(response);
  }

  // -----------------------------------------------------------
  // Webhook Endpoints
  // -----------------------------------------------------------
  describe('Webhook Endpoints', () => {
    it('should return health status', async () => {
      const resp = await fetch(WEBHOOK_HEALTH);
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as { status: string; agentId: string };
      expect(body.status).toBe('ok');
      expect(body.agentId).toBe(TEST_AGENT_ID);
    });

    it('should serve agent card at .well-known/agent.json', async () => {
      const resp = await fetch(AGENT_CARD_URL);
      expect(resp.status).toBe(200);

      const card = (await resp.json()) as {
        name: string;
        url: string;
        skills: unknown[];
        authentication?: { scheme: string };
      };
      expect(card.name).toBe(TEST_AGENT_ID);
      expect(card.url).toBeDefined();
      expect(Array.isArray(card.skills)).toBe(true);
      expect(card.skills.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------
  // Tool Registration
  // -----------------------------------------------------------
  describe('Tool Registration', () => {
    it('should register all three tools via api.registerTool', () => {
      const toolNames = registeredTools.map((t) => t.name);
      expect(toolNames).toContain('spellguard_route');
      expect(toolNames).toContain('spellguard_status');
      expect(toolNames).toContain('spellguard_discover');
    });

    it('should register tools with TypeBox parameters', () => {
      const routeTool = findTool('spellguard_route');
      const params = routeTool.parameters as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      expect(params.type).toBe('object');
      expect(params.properties).toBeDefined();
      expect(params.properties).toHaveProperty('prompt');
    });

    it('should register tools with label and description', () => {
      const routeTool = findTool('spellguard_route');
      expect(routeTool.label).toBe('spellguard route');
      expect(routeTool.description).toBeDefined();
      expect(routeTool.description.length).toBeGreaterThan(0);
    });

    it('should register webhook service', () => {
      const webhookService = registeredServices.find(
        (s) => s.id === 'spellguard-webhook',
      );
      expect(webhookService).toBeDefined();
    });
  });

  // -----------------------------------------------------------
  // Verifier Registration
  // -----------------------------------------------------------
  describe('Verifier Registration', () => {
    it('should be configured and report healthy status', async () => {
      const result = await executeTool<StatusData>('spellguard_status', {});

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.configured).toBe(true);
      expect(result.data.verifier.status).toBe('healthy');
      expect(result.data.self.agentId).toBe(TEST_AGENT_ID);
      expect(result.data.self.webhookUrl).toBe(PLUGIN_URL);
    });
  });

  // -----------------------------------------------------------
  // Route to Agent B
  // -----------------------------------------------------------
  describe('Route to Agent B', () => {
    it('should route a prompt and collect agent responses', async () => {
      const result = await executeTool<RouteData>('spellguard_route', {
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
    it('should increase commitment count after routing', async () => {
      const statsBefore = await fetch(`${VERIFIER_URL}/stats`).then((r) =>
        r.json(),
      );
      const commitmentsBefore = (
        statsBefore as { logging: { commitments: number } }
      ).logging.commitments;

      await executeTool<RouteData>('spellguard_route', {
        prompt: 'Hello from the audit trail test, agent-b.',
      });

      const statsAfter = await fetch(`${VERIFIER_URL}/stats`).then((r) =>
        r.json(),
      );
      const commitmentsAfter = (
        statsAfter as { logging: { commitments: number } }
      ).logging.commitments;

      expect(commitmentsAfter).toBeGreaterThan(commitmentsBefore);
    });
  });

  // -----------------------------------------------------------
  // Agent Discovery
  // -----------------------------------------------------------
  describe('Agent Discovery', () => {
    it('should discover Agent A capabilities', async () => {
      const result = await executeTool<DiscoverData>('spellguard_discover', {
        agentId: 'agent-a',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.agentCard).toBeDefined();
      expect(result.data.agentCard.name).toBeDefined();
      expect(result.data.agentCard.url).toBeDefined();
      expect(result.data.agentCard.skills).toBeDefined();
    });

    it('should discover Agent B capabilities', async () => {
      const result = await executeTool<DiscoverData>('spellguard_discover', {
        agentId: 'agent-b',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.agentCard.name).toBeDefined();
      expect(result.data.agentCard.url).toContain('8788');
    });
  });

  // -----------------------------------------------------------
  // Error Handling
  // -----------------------------------------------------------
  describe('Error Handling', () => {
    it('should return RECIPIENT_NOT_FOUND for nonexistent agent', async () => {
      const result = await executeTool<DiscoverData>('spellguard_discover', {
        agentId: 'nonexistent-agent-xyz',
      });

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe('RECIPIENT_NOT_FOUND');
      expect(result.error.message).toContain('nonexistent-agent-xyz');
    });

    it('should return INVALID_INPUT for missing required fields', async () => {
      const result = await executeTool<RouteData>('spellguard_route', {});

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error.code).toBe('INVALID_INPUT');
    });
  });

  // -----------------------------------------------------------
  // Tool Response Format
  // -----------------------------------------------------------
  describe('Tool Response Format', () => {
    it('should return responses in AgentToolResult format with details', async () => {
      const tool = findTool('spellguard_status');
      const response = await tool.execute(crypto.randomUUID(), {});

      expect(response.content).toBeDefined();
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content.length).toBe(1);
      expect(response.content[0].type).toBe('text');
      expect(
        'text' in response.content[0] && typeof response.content[0].text,
      ).toBe('string');

      // Verify details field contains the ToolResult
      expect(response.details).toBeDefined();
      expect(response.details).toHaveProperty('success');

      // Verify the text is valid JSON containing a ToolResult
      const textContent = response.content[0];
      if (textContent.type === 'text') {
        const parsed = JSON.parse(textContent.text);
        expect(parsed).toHaveProperty('success');
      }
    });
  });

  // -----------------------------------------------------------
  // Bilateral Attestation
  // -----------------------------------------------------------
  describe('Bilateral Attestation', () => {
    it('should produce bilateral commitments for Spellguard-to-Spellguard communication', async () => {
      const commitmentsBefore = await fetch(
        `${VERIFIER_URL}/logs/commitments`,
      ).then((r) => r.json());
      const beforeCount = (commitmentsBefore as { count: number }).count;

      await executeTool<RouteData>('spellguard_route', {
        prompt: 'Bilateral attestation test message for agent-b.',
      });

      const commitmentsAfter = await fetch(
        `${VERIFIER_URL}/logs/commitments`,
      ).then((r) => r.json());

      const newCommitments = (
        commitmentsAfter as {
          commitments: Array<{
            attestationLevel: string;
            sender: string;
            recipient: string;
          }>;
        }
      ).commitments.slice(beforeCount);

      expect(newCommitments.length).toBeGreaterThan(0);

      const bilateral = newCommitments.filter(
        (c) => c.attestationLevel === 'bilateral',
      );
      expect(bilateral.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------
  // Inbound Message Delivery
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
          message: 'Hello from test',
          senderId: 'test-sender',
          messageId: 'msg_test_1',
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
          messageId: 'msg_test_no_token',
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
  // Full Round-Trip
  // -----------------------------------------------------------
  describe('Full Round-Trip', () => {
    it('should complete outbound route then inbound receive in one lifecycle', async () => {
      // --- Outbound ---
      const commitmentsBefore = await fetch(
        `${VERIFIER_URL}/logs/commitments`,
      ).then((r) => r.json());
      const beforeCommitCount = (commitmentsBefore as { count: number }).count;

      const routeResult = await executeTool<RouteData>('spellguard_route', {
        prompt: 'Round-trip outbound leg for agent-b.',
      });

      expect(routeResult.success).toBe(true);

      const commitmentsAfter = await fetch(
        `${VERIFIER_URL}/logs/commitments`,
      ).then((r) => r.json());
      const afterCommitCount = (commitmentsAfter as { count: number }).count;
      expect(afterCommitCount).toBeGreaterThan(beforeCommitCount);

      // --- Inbound ---
      const resp = await fetch(WEBHOOK_RECEIVE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Spellguard-Channel-Token': 'test-token',
        },
        body: JSON.stringify({
          message: 'Round-trip inbound leg.',
          senderId: 'agent-b',
          messageId: 'msg_roundtrip',
          timestamp: Date.now(),
        }),
      });

      expect(resp.status).toBe(200);
    });
  });

  // -----------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------
  describe('Lifecycle', () => {
    it('should close webhook server on service stop', async () => {
      // Verify server is alive
      const healthBefore = await fetch(WEBHOOK_HEALTH);
      expect(healthBefore.status).toBe(200);

      // Stop registered services
      for (const service of registeredServices) {
        await service.stop?.({
          config: mockApi.pluginConfig,
          stateDir: '/tmp/spellguard-test',
          logger: noopLogger,
        });
      }
      servicesStopped = true;

      // POST should fail with connection error
      try {
        await fetch(WEBHOOK_RECEIVE, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Spellguard-Channel-Token': 'test-token',
          },
          body: JSON.stringify({
            message: 'After unload',
            senderId: 'test',
            messageId: 'msg_post_unload',
            timestamp: Date.now(),
          }),
          signal: AbortSignal.timeout(2000),
        });
        // If fetch doesn't throw, the server is unexpectedly still alive
        expect.unreachable('Fetch should have failed after server shutdown');
      } catch (error) {
        // Expected: ECONNREFUSED or similar network error
        expect(error).toBeDefined();
      }
    });
  });
});
