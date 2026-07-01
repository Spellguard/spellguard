// SPDX-License-Identifier: Apache-2.0

/**
 * Spellguard gateway — the HTTP↔SLIM translation layer.
 *
 * Two distinct surfaces, sharing one process and one TCP port:
 *
 * 1. HTTP — the Workers-facing entry point. Agents POST to /v1/* routes
 *    here (forward path); the gateway also POSTs to agents' callback URLs
 *    when SLIM-inbound delivery is needed.
 * 2. WebSocket / SLIM — the legacy v0.1 frame protocol from when the
 *    gateway was an external "sidecar." Kept here so the existing
 *    SlimTransport integration tests continue to pass during the
 *    architectural refactor. Tasks 26-28 reshape this into a clean SLIM
 *    RPC against the Verifier and will retire the WebSocket frames.
 *
 * The HTTP routes (/v1/register, /v1/health, etc.) maintain the
 * slimName→callbackUrl registry the inbound dispatcher reads. Once the
 * Verifier owns the agent registry (Task 28) and pushes updates via SLIM
 * control messages, /v1/register stops being public — agents go back to
 * registering only with the Verifier, and this gateway receives the
 * derived map from the Verifier.
 */

import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  type AgentRegistration,
  listRegistrations,
  registerAgent as registerAgentInRegistry,
  unregisterAgent as unregisterAgentFromRegistry,
} from './agent-registry';
import {
  type ClientFrame,
  type ErrorCode,
  type GatewayFrame,
  gatewayFrame,
} from './protocol';
import { forwardOverSlim, gatewayConfigFromEnv } from './slim-forward';
import {
  type GatewayListenerHandle,
  startGatewayInbound,
} from './slim-inbound';
import { configFromEnv, dispatchSend, subscribeAgent } from './slim-service';
import { wireToResponse } from './wire';

const PORT = Number(
  process.env.SPELLGUARD_GATEWAY_PORT ?? process.env.SLIM_SIDECAR_PORT ?? 46358,
);
const PROTOCOL_VERSION = '0.1';
const STARTED_AT = Date.now();

interface AgentSession {
  agentId: string;
  slimName: string;
  ws: WebSocket;
  /** Pending `send` requests, keyed by requestId, awaiting `send-result`. */
  pending: Map<string, (frame: GatewayFrame) => void>;
}

const sessions = new Map<string, AgentSession>();

let inboundListener: GatewayListenerHandle | null = null;

function send(ws: WebSocket, frame: GatewayFrame): void {
  ws.send(JSON.stringify(frame));
}

function handleHello(ws: WebSocket, frame: ClientFrame): void {
  if (frame.type !== 'hello') return;
  if (frame.version !== PROTOCOL_VERSION) {
    send(
      ws,
      gatewayFrame.error(
        undefined,
        'version-mismatch',
        `Gateway speaks v${PROTOCOL_VERSION}, client requested v${frame.version}`,
      ),
    );
    ws.close();
    return;
  }
  const session: AgentSession = {
    agentId: frame.agentId,
    slimName: frame.slimName,
    ws,
    pending: new Map(),
  };
  sessions.set(frame.agentId, session);
  console.log(
    `[gateway] hello agentId=${frame.agentId} slimName=${frame.slimName}`,
  );
  send(
    ws,
    gatewayFrame.welcome(
      frame.agentId,
      PROTOCOL_VERSION,
      process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357',
    ),
  );

  // TODO: register this agent's slimName with the SLIM data plane via
  // @agntcy/slim-bindings, open a session listener, and forward inbound
  // SRPC messages back to this WebSocket as `inbound` frames.
}

async function handleSend(ws: WebSocket, frame: ClientFrame): Promise<void> {
  if (frame.type !== 'send') return;
  const session = [...sessions.values()].find((s) => s.ws === ws);
  if (!session) {
    send(
      ws,
      gatewayFrame.error(
        frame.requestId,
        'invalid-frame',
        '`send` arrived before `hello` — session not bound',
      ),
    );
    return;
  }
  // Mock mode (default) synthesizes the response; real mode attempts to
  // dispatch via @agntcy/slim-bindings. See slim-service.ts.
  const result = await dispatchSend(
    {
      senderAgentId: session.agentId,
      senderSlimName: session.slimName,
      recipientAgentId: frame.to.agentId,
      recipientSlimName: frame.to.slimName ?? frame.to.agentId,
      message: frame.message,
    },
    configFromEnv(),
  );
  if (result.ok && result.response) {
    send(ws, gatewayFrame.sendResult(frame.requestId, result.response));
  } else {
    send(
      ws,
      gatewayFrame.error(
        frame.requestId,
        (result.error?.code as ErrorCode | undefined) ?? 'internal',
        result.error?.message ?? 'unknown gateway dispatch failure',
      ),
    );
  }
}

function handlePing(ws: WebSocket): void {
  send(ws, gatewayFrame.pong(Date.now() - STARTED_AT));
}

function handleClose(ws: WebSocket): void {
  for (const [agentId, session] of sessions) {
    if (session.ws === ws) {
      sessions.delete(agentId);
      console.log(`[gateway] close agentId=${agentId}`);
      // TODO: tear down the @agntcy/slim-bindings session for slimName.
      return;
    }
  }
}

function parseFrame(raw: string): ClientFrame | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as ClientFrame;
    }
  } catch {
    // fall through
  }
  return null;
}

function buildHttpApp(): Hono {
  const app = new Hono();

  app.get('/v1/health', (c) =>
    c.json({
      ok: true,
      uptimeMs: Date.now() - STARTED_AT,
      agents: listRegistrations().length,
    }),
  );

  // Local /health endpoint for ALB target-group health checks.
  // Must NOT go through the SLIM catchall below — if it did, SLIM
  // session-setup variance would occasionally exceed the ALB's 10s
  // health-check timeout and ECS would crash-loop the gateway task.
  // Same shape as /v1/health; kept distinct as the canonical ALB
  // probe path so we can change one without affecting the other.
  //
  // /health is LIVENESS only — it never crosses SLIM, so a 200 here does
  // NOT mean the gateway can actually reach the verifier. /ready (below)
  // is the readiness probe that exercises the real SLIM hop.
  app.get('/health', (c) =>
    c.json({
      ok: true,
      uptimeMs: Date.now() - STARTED_AT,
      agents: listRegistrations().length,
    }),
  );

  // /ready — readiness probe that actually traverses gateway→SLIM→
  // verifier (unlike /health, which is local liveness and stays 200 even
  // when the SLIM hop is dead). Echoes a GET /health to the verifier over
  // SLIM with a short budget; ready iff the round-trip completes.
  //
  // NOTE: this is intentionally NOT wired as the gateway ALB health check.
  // It issues a real outbound SLIM send, so probing it every few seconds
  // across tasks would add outbound-session contention to the exact path
  // we're protecting. Gateway self-recovery is worker-driven instead (the
  // wedge detector → request-process-exit → ECS recycle). /ready is here
  // for external/manual diagnosis and for a future, generously-throttled
  // health check or smoke test. (The verifier ALB DOES use its own cheap,
  // SLIM-aware /ready — that probe is an in-process boolean, not an echo.)
  app.get('/ready', async (c) => {
    const probe = new Request('http://slim-internal/health', { method: 'GET' });
    const outcome = await forwardOverSlim(probe, gatewayConfigFromEnv(), {
      replyTimeoutMsOverride: 8_000,
    });
    if (outcome.ok && outcome.response) {
      return c.json({
        ready: true,
        slim: 'ok',
        verifierStatus: outcome.response.status,
        uptimeMs: Date.now() - STARTED_AT,
      });
    }
    return c.json(
      {
        ready: false,
        slim: 'unreachable',
        code: outcome.error?.code,
        message: outcome.error?.message,
      },
      503,
    );
  });

  // Agent registration — agents POST here at startup so the gateway
  // knows where to deliver inbound SLIM messages addressed to them.
  // (Task 28 replaces this with a Verifier-pushed registry update.)
  app.post('/v1/register', async (c) => {
    let body: { agentId?: string; slimName?: string; callbackUrl?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const { agentId, slimName, callbackUrl } = body;
    if (
      typeof agentId !== 'string' ||
      typeof slimName !== 'string' ||
      typeof callbackUrl !== 'string'
    ) {
      return c.json(
        { error: 'agentId, slimName, callbackUrl are all required strings' },
        400,
      );
    }
    const reg = registerAgentInRegistry({ agentId, slimName, callbackUrl });
    // Ensure the SLIM data plane knows we want messages for this name.
    // Failures are logged but don't fail the registration — the agent
    // can still send (outbound), and inbound starts flowing once SLIM
    // subscribe completes.
    subscribeAgent(slimName).catch((err: unknown) =>
      console.warn(
        `[gateway] subscribe ${slimName} failed: ${(err as Error)?.message ?? String(err)}`,
      ),
    );
    // Inbound dispatch (Task 27): the gateway's own App must also
    // subscribe to this slim name so SLIM messages addressed to the
    // agent land in our listenForSessionAsync loop, where they get
    // POSTed to the agent's HTTP callback. Best-effort; failure here
    // is logged but doesn't fail registration.
    if (inboundListener) {
      inboundListener
        .subscribeAgent(slimName)
        .catch((err: unknown) =>
          console.warn(
            `[gateway] inbound subscribe ${slimName} failed: ${(err as Error)?.message ?? String(err)}`,
          ),
        );
    }
    console.log(
      `[gateway] registered agentId=${agentId} slimName=${slimName} callbackUrl=${callbackUrl}`,
    );
    return c.json({ ok: true, lastSeen: reg.lastSeen });
  });

  app.delete('/v1/register/:agentId', (c) => {
    const agentId = c.req.param('agentId');
    const removed = unregisterAgentFromRegistry(agentId);
    if (!removed) return c.json({ error: 'not found' }, 404);
    console.log(`[gateway] unregistered agentId=${agentId}`);
    return c.json({ ok: true });
  });

  app.get('/v1/registry', (c) =>
    c.json({
      agents: listRegistrations().map((r: AgentRegistration) => ({
        agentId: r.agentId,
        slimName: r.slimName,
        callbackUrl: r.callbackUrl,
        lastSeen: r.lastSeen,
      })),
    }),
  );

  // Catchall: every non-gateway-internal HTTP request gets forwarded to
  // the Verifier over SLIM. Agents POSTing to /proxy/forward, attestation
  // handshake routes, admin APIs — they all flow through this single
  // SLIM tunnel. The Verifier reconstructs the Request, runs it through
  // its Hono app, and returns the wire-encoded Response.
  app.all('*', async (c) => {
    const outcome = await forwardOverSlim(c.req.raw, gatewayConfigFromEnv());
    if (!outcome.ok || !outcome.response) {
      return c.json(
        {
          error: 'gateway-forward-failed',
          code: outcome.error?.code ?? 'unknown',
          message: outcome.error?.message ?? 'no error message',
        },
        502,
      );
    }
    return wireToResponse(outcome.response);
  });

  return app;
}

function startGateway(): void {
  // Subprotocol token follows the RFC 6455 grammar (no '/'). Use
  // `spellguard-slim-v0.1` rather than `spellguard-slim/v0.1`. When no
  // subprotocol is requested by the client we still accept the connection
  // — protocol version is renegotiated inside the `hello` frame.
  const SUBPROTOCOL = `spellguard-slim-v${PROTOCOL_VERSION}`;

  // One node:http server fronts both HTTP (Hono) and WebSocket (ws). The
  // ws server attaches in `noServer` mode and we hand it upgrade events
  // explicitly.
  const httpApp = buildHttpApp();
  const httpServer = createServer(getRequestListener(httpApp.fetch));

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false,
  });

  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  httpServer.listen(PORT, '0.0.0.0');

  wss.on('connection', (ws) => {
    console.log('[gateway] connection opened');
    ws.on('message', (raw: Buffer | string) => {
      const frame = parseFrame(raw.toString('utf-8'));
      if (!frame) {
        send(
          ws,
          gatewayFrame.error(undefined, 'invalid-frame', 'Malformed JSON'),
        );
        return;
      }
      switch (frame.type) {
        case 'hello':
          handleHello(ws, frame);
          return;
        case 'send':
          handleSend(ws, frame).catch((err: unknown) => {
            send(
              ws,
              gatewayFrame.error(
                frame.requestId,
                'internal',
                `handleSend threw: ${(err as Error)?.message ?? String(err)}`,
              ),
            );
          });
          return;
        case 'ping':
          handlePing(ws);
          return;
        case 'close':
          handleClose(ws);
          ws.close();
          return;
        case 'inbound-ack':
          // TODO: correlate with the inbound SRPC turn we're awaiting and
          // forward the response SecureMessage back to the SLIM caller.
          return;
        default: {
          const exhaustive: never = frame;
          send(
            ws,
            gatewayFrame.error(
              undefined,
              'invalid-frame',
              `Unknown frame type: ${JSON.stringify(exhaustive)}`,
            ),
          );
        }
      }
    });
    ws.on('close', () => handleClose(ws));
    ws.on('error', (err) => {
      console.warn(`[gateway] ws error: ${err.message}`);
    });
  });

  console.log(
    `[gateway] listening on ws://0.0.0.0:${PORT} (protocol ${SUBPROTOCOL})`,
  );

  // Inbound SLIM listener (Task 27). Best-effort: failures are logged
  // and the gateway keeps serving HTTP routes. Once `inboundListener`
  // is set, the /v1/register handler subscribes each registered
  // slimName so messages addressed to that agent get dispatched to
  // its callbackUrl.
  startGatewayInbound()
    .then((handle) => {
      inboundListener = handle;
      console.log('[gateway] inbound SLIM listener ready');
    })
    .catch((err: unknown) => {
      console.warn(
        `[gateway] inbound SLIM listener failed to start: ${(err as Error)?.message ?? String(err)}`,
      );
    });
}

/**
 * Process-level recycle diagnostics. The gateway recycles under sustained
 * load, but the cause (OOM vs the SLIM wedge detector's process.exit vs an
 * uncaught error) was invisible from outside (ECS shows only the exit code,
 * and /health goes unreachable mid-recycle). These three make the cause
 * legible in CloudWatch:
 *   - a periodic heap/RSS line so an OOM shows as a climbing trend before the
 *     SIGKILL (which Node can't trap);
 *   - uncaughtException / unhandledRejection logged + clean exit(1) so a crash
 *     names itself instead of dying silently;
 *   - SIGTERM logged so an ECS graceful stop (deploy / scale-in) is
 *     distinguishable from a crash recycle.
 */
function installRecycleDiagnostics(): void {
  const HEAP_LOG_INTERVAL_MS = 30_000;
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    console.log(
      `[gateway] mem rss=${mb(m.rss)}MiB heapUsed=${mb(m.heapUsed)}MiB heapTotal=${mb(m.heapTotal)}MiB external=${mb(m.external)}MiB uptime=${Math.round((Date.now() - STARTED_AT) / 1000)}s`,
    );
  }, HEAP_LOG_INTERVAL_MS);
  // Don't keep the event loop alive for logging alone.
  if (typeof timer.unref === 'function') timer.unref();

  process.on('uncaughtException', (err) => {
    console.error(
      `[gateway] fatal uncaughtException: ${err?.stack ?? err} — exiting so ECS replaces the task`,
    );
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(
      `[gateway] fatal unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)} — exiting so ECS replaces the task`,
    );
    setTimeout(() => process.exit(1), 100);
  });
  process.on('SIGTERM', () => {
    console.log(
      `[gateway] received SIGTERM (graceful stop — deploy or scale-in, NOT a crash) at uptime=${Math.round((Date.now() - STARTED_AT) / 1000)}s`,
    );
    process.exit(0);
  });
}

installRecycleDiagnostics();
startGateway();
