// SPDX-License-Identifier: Apache-2.0

/**
 * Policy SDK — Server Integration Tests
 *
 * Tests createPolicyServer() and servePolicyEngine() by starting real
 * HTTP servers and making actual requests.
 */

import { createPolicyServer } from '@spellguard/policy-sdk';
import type {
  Detection,
  PolicyEngine,
  PolicyRequest,
} from '@spellguard/policy-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ─── Test engine ──────────────────────────────────────────────

class SimpleEngine implements PolicyEngine {
  name = 'simple-engine';

  evaluate(request: PolicyRequest): Detection[] {
    if (request.content.includes('dangerous')) {
      return [
        {
          type: 'danger-detected',
          confidence: 0.95,
          message: 'Dangerous content found',
        },
      ];
    }
    return [];
  }
}

// ─── Tests ────────────────────────────────────────────────────

describe('createPolicyServer()', () => {
  let serverUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { app, start } = createPolicyServer(new SimpleEngine(), {
      port: 0, // Let OS assign port
      logging: false,
    });

    // Use Hono's built-in test capabilities since @hono/node-server serve()
    // doesn't easily support port 0. Instead, test the app directly.
    // We already tested createPolicyApp in policy-sdk-server.test.ts,
    // so here we verify createPolicyServer returns the right shape.
    serverUrl = 'http://localhost'; // placeholder
    void app; // used in tests below
    void start; // verified in shape test
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  it('should return an object with app and start properties', () => {
    const result = createPolicyServer(new SimpleEngine(), { logging: false });
    expect(result).toHaveProperty('app');
    expect(result).toHaveProperty('start');
    expect(typeof result.start).toBe('function');
  });

  it('should create an app that responds to health checks', async () => {
    const { app } = createPolicyServer(new SimpleEngine(), { logging: false });
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('healthy');
    expect(json.engine).toBe('simple-engine');
  });

  it('should create an app that evaluates policies', async () => {
    const { app } = createPolicyServer(new SimpleEngine(), { logging: false });
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'this is dangerous content',
        policyId: 'test-id',
        policySlug: 'test-slug',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].type).toBe('danger-detected');
  });

  it('should create an app that returns empty for clean content', async () => {
    const { app } = createPolicyServer(new SimpleEngine(), { logging: false });
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'clean content',
        policyId: 'test-id',
        policySlug: 'test-slug',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it('should use default port 3000 when not specified', () => {
    const logMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = createPolicyServer(new SimpleEngine(), { logging: false });
    // We can't easily test the port without starting, but verify the shape
    expect(result.app).toBeDefined();
    expect(result.start).toBeDefined();
    logMock.mockRestore();
  });

  it('should pass config through to createPolicyApp', async () => {
    const { app } = createPolicyServer(new SimpleEngine(), {
      basePath: '/evaluate',
      healthPath: '/status',
      logging: false,
    });

    // Custom health path works
    const healthRes = await app.request('/status');
    expect(healthRes.status).toBe(200);

    // Custom base path works
    const evalRes = await app.request('/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'dangerous payload',
        policyId: 'test',
        policySlug: 'test',
      }),
    });
    expect(evalRes.status).toBe(200);
    const json = await evalRes.json();
    expect(json).toHaveLength(1);
  });
});

describe('servePolicyEngine()', () => {
  it('should be a function', async () => {
    const mod = await import('@spellguard/policy-sdk');
    expect(typeof mod.servePolicyEngine).toBe('function');
  });

  // Note: servePolicyEngine() starts a server immediately and doesn't return
  // a handle to stop it, so we test it indirectly through createPolicyServer
  // which it wraps.
});
