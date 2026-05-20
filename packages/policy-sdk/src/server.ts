// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP server for hosting policy engines.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type {
  Detection,
  PolicyEngine,
  PolicyRequest,
  ServerConfig,
} from './types';

/**
 * Create a Hono app for a policy engine.
 * Can be used with any Hono-compatible runtime (Node, Bun, Cloudflare Workers, etc.)
 */
export function createPolicyApp(
  engine: PolicyEngine,
  config: ServerConfig = {},
): Hono {
  const app = new Hono();
  const basePath = config.basePath ?? '';
  const healthPath = config.healthPath ?? '/health';
  const logging = config.logging ?? true;

  // Health check endpoint
  app.get(healthPath, (c) => {
    return c.json({
      status: 'healthy',
      engine: engine.name,
      timestamp: new Date().toISOString(),
    });
  });

  // Policy evaluation endpoint
  app.post(basePath || '/', async (c) => {
    const startTime = Date.now();

    try {
      const body = await c.req.json<PolicyRequest>();

      // Validate request
      if (typeof body.content !== 'string') {
        return c.json({ error: 'Missing or invalid "content" field' }, 400);
      }

      // Evaluate
      const detections = await engine.evaluate(body);

      // Ensure response is an array
      const response: Detection[] = Array.isArray(detections) ? detections : [];

      if (logging) {
        const duration = Date.now() - startTime;
        console.log(
          `[${engine.name}] ${body.policySlug || body.policyId} - ${response.length} detections (${duration}ms)`,
        );
      }

      return c.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (logging) {
        console.error(`[${engine.name}] Error:`, message);
      }

      return c.json({ error: message }, 500);
    }
  });

  return app;
}

/**
 * Create and start a policy server (Node.js).
 * For other runtimes, use createPolicyApp() and handle serving yourself.
 */
export function createPolicyServer(
  engine: PolicyEngine,
  config: ServerConfig = {},
): { app: Hono; start: () => void } {
  const app = createPolicyApp(engine, config);
  const port = config.port ?? 3000;

  const start = () => {
    serve({ fetch: app.fetch, port }, (info) => {
      console.log(
        `[${engine.name}] Policy server running on http://localhost:${info.port}`,
      );
    });
  };

  return { app, start };
}

/**
 * Shorthand to create and immediately start a server.
 */
export function servePolicyEngine(
  engine: PolicyEngine,
  config: ServerConfig = {},
): void {
  const { start } = createPolicyServer(engine, config);
  start();
}
