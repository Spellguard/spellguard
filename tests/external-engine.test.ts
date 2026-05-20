// SPDX-License-Identifier: Apache-2.0

/**
 * External HTTPS Engine Unit Tests
 *
 * Tests the external policy engine that delegates evaluation
 * to an HTTP(S) endpoint. Uses a local HTTP server for testing.
 */

import http from 'node:http';
import {
  clearEngines,
  evaluatePolicies,
  initDefaultEngines,
} from '@spellguard/verifier';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ResolvedPolicyBinding } from '../packages/verifier/src/proxy/policy-evaluator-types';

// ─── Test HTTP server ───────────────────────────────────────────

let server: http.Server;
let serverPort: number;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    handler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ─── Helpers ────────────────────────────────────────────────────

function makeExternalBinding(
  overrides: Partial<ResolvedPolicyBinding> = {},
): ResolvedPolicyBinding {
  return {
    policyId: 'ext-test',
    level: 'org',
    effect: 'block',
    policyType: 'external',
    policySlug: 'external-check',
    externalEndpoint: `http://127.0.0.1:${serverPort}/evaluate`,
    externalTimeout: 5000,
    ...overrides,
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
  });
}

// ─── Tests ──────────────────────────────────────────────────────

describe('External Engine', () => {
  beforeEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  afterEach(() => {
    clearEngines();
    initDefaultEngines();
  });

  // ─── Successful evaluation ──────────────────────────────────

  describe('successful evaluation', () => {
    it('should return detections from external endpoint', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              type: 'external-pii',
              confidence: 0.95,
              message: 'SSN detected by external service',
            },
          ]),
        );
      };

      const binding = makeExternalBinding();
      const results = await evaluatePolicies([binding], 'SSN: 123-45-6789');

      expect(results).toHaveLength(1);
      expect(results[0].decision).toBe('deny');
      expect(results[0].responseLevel).toBe('block');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('external-pii');
      expect(results[0].detections[0].confidence).toBe(0.95);
    });

    it('should return empty detections when endpoint returns empty array', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      };

      const binding = makeExternalBinding();
      const results = await evaluatePolicies([binding], 'Clean content');

      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('allow');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should send correct request body to endpoint', async () => {
      let receivedBody: Record<string, unknown> = {};

      handler = async (req, res) => {
        const raw = await readBody(req);
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      };

      const binding = makeExternalBinding({
        policyId: 'my-policy-id',
        policySlug: 'my-slug',
        config: { threshold: 0.8 },
      });
      await evaluatePolicies([binding], 'Test content payload');

      expect(receivedBody.content).toBe('Test content payload');
      expect(receivedBody.policyId).toBe('my-policy-id');
      expect(receivedBody.policySlug).toBe('my-slug');
      expect(receivedBody.config).toEqual({ threshold: 0.8 });
    });

    it('should handle multiple detections from endpoint', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            { type: 'issue-a', confidence: 0.9 },
            { type: 'issue-b', confidence: 0.7, message: 'Second issue' },
          ]),
        );
      };

      const binding = makeExternalBinding();
      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].detections).toHaveLength(2);
      expect(results[0].detections[0].type).toBe('issue-a');
      expect(results[0].detections[1].type).toBe('issue-b');
      expect(results[0].detections[1].message).toBe('Second issue');
    });

    it('should flag (not block) when effect is permit', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ type: 'warning', confidence: 0.6 }]));
      };

      const binding = makeExternalBinding({ effect: 'flag' });
      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('flag');
    });
  });

  // ─── Error handling ─────────────────────────────────────────

  describe('error handling', () => {
    it('should silently permit on HTTP error when failBehavior=allow (default)', async () => {
      handler = async (_req, res) => {
        res.writeHead(500);
        res.end('Internal Server Error');
      };

      const binding = makeExternalBinding();
      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('allow');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny on HTTP error when failBehavior=block', async () => {
      handler = async (_req, res) => {
        res.writeHead(503);
        res.end('Service Unavailable');
      };

      const binding = makeExternalBinding({ failBehavior: 'block' });
      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].decision).toBe('deny');
      expect(results[0].responseLevel).toBe('block');
      expect(results[0].detections).toHaveLength(1);
      expect(results[0].detections[0].type).toBe('external-error');
      expect(results[0].detections[0].message).toContain('HTTP 503');
    });

    it('should warn on HTTP error when failBehavior=warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      handler = async (_req, res) => {
        res.writeHead(500);
        res.end('Error');
      };

      const binding = makeExternalBinding({ failBehavior: 'warn' });
      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('HTTP 500');

      warnSpy.mockRestore();
    });

    it('should handle missing externalEndpoint gracefully', async () => {
      const binding = makeExternalBinding({
        externalEndpoint: undefined,
      });

      const results = await evaluatePolicies([binding], 'Content');
      // Default failBehavior=allow → permit
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should deny with missing endpoint when failBehavior=block', async () => {
      const binding = makeExternalBinding({
        externalEndpoint: undefined,
        failBehavior: 'block',
      });

      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].type).toBe('external-error');
      expect(results[0].detections[0].message).toContain('No externalEndpoint');
    });
  });

  // ─── Timeout handling ─────────────────────────────────────────

  describe('timeout', () => {
    it('should timeout and permit when failBehavior=allow', async () => {
      handler = async (_req, _res) => {
        // Never respond — let it timeout
        await new Promise((resolve) => setTimeout(resolve, 10000));
      };

      const binding = makeExternalBinding({
        externalTimeout: 200, // 200ms timeout
      });

      const results = await evaluatePolicies([binding], 'Content');
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should timeout and deny when failBehavior=block', async () => {
      handler = async (_req, _res) => {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      };

      const binding = makeExternalBinding({
        externalTimeout: 200,
        failBehavior: 'block',
      });

      const results = await evaluatePolicies([binding], 'Content');
      expect(results[0].decision).toBe('deny');
      expect(results[0].detections[0].type).toBe('external-error');
      expect(results[0].detections[0].message).toContain('timed out');
    });
  });

  // ─── Malformed response handling ──────────────────────────────

  describe('malformed response', () => {
    it('should silently permit on non-array response', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not an array' }));
      };

      const binding = makeExternalBinding();
      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });

    it('should filter out malformed detection objects', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            { type: 'valid', confidence: 0.9, message: 'OK' },
            { type: 'no-confidence' }, // missing confidence
            { confidence: 0.5 }, // missing type
            'not-an-object',
            null,
            { type: 'also-valid', confidence: 0.8 },
          ]),
        );
      };

      const binding = makeExternalBinding();
      const results = await evaluatePolicies([binding], 'Content');

      expect(results[0].detections).toHaveLength(2);
      expect(results[0].detections[0].type).toBe('valid');
      expect(results[0].detections[1].type).toBe('also-valid');
    });

    it('should handle invalid JSON response', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not valid json{{{');
      };

      const binding = makeExternalBinding();
      const results = await evaluatePolicies([binding], 'Content');

      // Default failBehavior=allow → permit
      expect(results[0].decision).toBe('permit');
      expect(results[0].detections).toHaveLength(0);
    });
  });

  // ─── Integration with other engines ───────────────────────────

  describe('multi-engine integration', () => {
    it('should work alongside builtin and regex engines', async () => {
      handler = async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              type: 'external-finding',
              confidence: 0.88,
              message: 'External detected issue',
            },
          ]),
        );
      };

      const bindings: ResolvedPolicyBinding[] = [
        {
          policyId: 'builtin-pii',
          level: 'org',
          effect: 'flag',
          policyType: 'builtin',
          policySlug: 'pii-detection',
        },
        {
          policyId: 'regex-check',
          level: 'org',
          effect: 'block',
          policyType: 'regex',
          policySlug: 'custom-regex',
          config: { patterns: [{ pattern: 'secret', label: 'secret-found' }] },
        },
        makeExternalBinding({ policyId: 'ext-check' }),
      ];

      const results = await evaluatePolicies(bindings, 'No secret or PII here');

      expect(results).toHaveLength(3);
      // Builtin: clean → permit/allow
      expect(results[0].policyId).toBe('builtin-pii');
      expect(results[0].decision).toBe('permit');
      expect(results[0].responseLevel).toBe('allow');
      // Regex: "secret" matches → deny/block
      expect(results[1].policyId).toBe('regex-check');
      expect(results[1].decision).toBe('deny');
      // External: returns detection → deny/block
      expect(results[2].policyId).toBe('ext-check');
      expect(results[2].decision).toBe('deny');
      expect(results[2].detections[0].type).toBe('external-finding');
    });
  });
});
