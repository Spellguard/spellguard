// SPDX-License-Identifier: Apache-2.0

/**
 * Policy SDK — Server Unit Tests
 *
 * Tests createPolicyApp() HTTP endpoints: health check, policy evaluation,
 * request validation, error handling, and logging.
 */

import { createPolicyApp } from '@spellguard/policy-sdk';
import type {
  Detection,
  PolicyEngine,
  PolicyRequest,
} from '@spellguard/policy-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Test engine implementations ──────────────────────────────

class EchoEngine implements PolicyEngine {
  name = 'echo-engine';

  evaluate(request: PolicyRequest): Detection[] {
    if (request.content.includes('bad')) {
      return [
        {
          type: 'bad-content',
          confidence: 0.9,
          message: 'Found bad content',
        },
      ];
    }
    return [];
  }
}

class AsyncEngine implements PolicyEngine {
  name = 'async-engine';

  async evaluate(request: PolicyRequest): Promise<Detection[]> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (request.content.includes('async-bad')) {
      return [{ type: 'async-issue', confidence: 0.85 }];
    }
    return [];
  }
}

class ErrorEngine implements PolicyEngine {
  name = 'error-engine';

  evaluate(_request: PolicyRequest): Detection[] {
    throw new Error('Engine exploded');
  }
}

class NullEngine implements PolicyEngine {
  name = 'null-engine';

  evaluate(_request: PolicyRequest): Detection[] {
    return undefined as unknown as Detection[];
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function makeBody(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    content: 'test content',
    policyId: 'test-id',
    policySlug: 'test-slug',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe('createPolicyApp', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ─── Health endpoint ──────────────────────────────────────

  describe('GET /health', () => {
    it('should return 200 with healthy status', async () => {
      const app = createPolicyApp(new EchoEngine());
      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('healthy');
      expect(json.engine).toBe('echo-engine');
      expect(json.timestamp).toBeDefined();
    });

    it('should include ISO timestamp', async () => {
      const app = createPolicyApp(new EchoEngine());
      const res = await app.request('/health');
      const json = await res.json();

      // Validate ISO 8601 format
      expect(new Date(json.timestamp).toISOString()).toBe(json.timestamp);
    });

    it('should use custom healthPath', async () => {
      const app = createPolicyApp(new EchoEngine(), { healthPath: '/status' });

      const res = await app.request('/status');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('healthy');

      // Default /health should 404
      const notFound = await app.request('/health');
      expect(notFound.status).toBe(404);
    });
  });

  // ─── Policy evaluation endpoint ───────────────────────────

  describe('POST / (evaluation)', () => {
    it('should return detections when engine finds issues', async () => {
      const app = createPolicyApp(new EchoEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ content: 'this is bad content' })),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveLength(1);
      expect(json[0].type).toBe('bad-content');
      expect(json[0].confidence).toBe(0.9);
      expect(json[0].message).toBe('Found bad content');
    });

    it('should return empty array when no detections', async () => {
      const app = createPolicyApp(new EchoEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ content: 'clean content' })),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual([]);
    });

    it('should work with async engine', async () => {
      const app = createPolicyApp(new AsyncEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ content: 'async-bad data' })),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveLength(1);
      expect(json[0].type).toBe('async-issue');
    });

    it('should return empty array when engine returns undefined', async () => {
      const app = createPolicyApp(new NullEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual([]);
    });

    it('should use custom basePath', async () => {
      const app = createPolicyApp(new EchoEngine(), {
        basePath: '/evaluate',
        logging: false,
      });
      const res = await app.request('/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ content: 'bad stuff' })),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveLength(1);
    });
  });

  // ─── Request validation ───────────────────────────────────

  describe('request validation', () => {
    it('should return 400 when content is missing', async () => {
      const app = createPolicyApp(new EchoEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyId: 'test', policySlug: 'test' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('content');
    });

    it('should return 400 when content is not a string', async () => {
      const app = createPolicyApp(new EchoEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 123,
          policyId: 'test',
          policySlug: 'test',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('content');
    });

    it('should return 500 on malformed JSON', async () => {
      const app = createPolicyApp(new EchoEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{{{',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });
  });

  // ─── Error handling ───────────────────────────────────────

  describe('error handling', () => {
    it('should return 500 when engine throws', async () => {
      const app = createPolicyApp(new ErrorEngine(), { logging: false });
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Engine exploded');
    });

    it('should log error when logging is enabled and engine throws', async () => {
      const app = createPolicyApp(new ErrorEngine(), { logging: true });
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      });

      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0][0]).toContain('[error-engine]');
      expect(errorSpy.mock.calls[0][1]).toContain('Engine exploded');
    });

    it('should not log error when logging is disabled', async () => {
      const app = createPolicyApp(new ErrorEngine(), { logging: false });
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody()),
      });

      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Logging ──────────────────────────────────────────────

  describe('logging', () => {
    it('should log evaluation when logging is enabled (default)', async () => {
      const app = createPolicyApp(new EchoEngine());
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ content: 'bad stuff' })),
      });

      expect(logSpy).toHaveBeenCalledOnce();
      const logMsg = logSpy.mock.calls[0][0] as string;
      expect(logMsg).toContain('[echo-engine]');
      expect(logMsg).toContain('test-slug');
      expect(logMsg).toContain('1 detections');
      expect(logMsg).toMatch(/\d+ms/);
    });

    it('should not log when logging is false', async () => {
      const app = createPolicyApp(new EchoEngine(), { logging: false });
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ content: 'bad stuff' })),
      });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('should log with policyId when policySlug is missing', async () => {
      const app = createPolicyApp(new EchoEngine());
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'bad content',
          policyId: 'fallback-id',
        }),
      });

      expect(logSpy).toHaveBeenCalledOnce();
      const logMsg = logSpy.mock.calls[0][0] as string;
      expect(logMsg).toContain('fallback-id');
    });

    it('should log 0 detections for clean content', async () => {
      const app = createPolicyApp(new EchoEngine());
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody({ content: 'clean' })),
      });

      expect(logSpy).toHaveBeenCalledOnce();
      const logMsg = logSpy.mock.calls[0][0] as string;
      expect(logMsg).toContain('0 detections');
    });
  });
});
