// SPDX-License-Identifier: Apache-2.0

/**
 * Spellguard — Better Auth identity server example (stateless / no database)
 *
 * A minimal Node.js server that mimics the Better Auth API key flow using
 * in-memory storage. Zero external dependencies beyond Hono. Restart wipes
 * all sessions and keys — intended for demos and local development.
 *
 * Agent flow:
 *   1. POST /api/auth/sign-in/anonymous  → receives a session token (JSON body)
 *   2. POST /api/auth/api-key/create     → exchanges session for a permanent API key
 *   3. Agent stores the key; includes it in every Spellguard request
 *
 * Spellguard verifier flow:
 *   POST /api/auth/api-key/verify  → Spellguard calls this to validate a key
 */

import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

// ─── Config ──────────────────────────────────────────────────────────────────

const SECRET = process.env.BETTER_AUTH_SECRET;
if (!SECRET) throw new Error('BETTER_AUTH_SECRET env var is required');

const BASE_URL = process.env.BETTER_AUTH_BASE_URL ?? 'http://localhost:4000';
const PORT = Number(process.env.PORT ?? 4000);

// ─── In-memory stores ─────────────────────────────────────────────────────────

interface Session {
  userId: string;
  expiresAt: number; // unix ms
}

interface ApiKey {
  id: string;
  key: string;
  userId: string;
  name?: string;
  enabled: boolean;
  createdAt: number;
}

const sessions = new Map<string, Session>();
const apiKeys = new Map<string, ApiKey>(); // keyed by key string

function randomHex(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function newSessionToken() {
  return randomHex(24);
}

function newApiKey() {
  // ba_live_<hex> — matches the format callers expect
  return `ba_live_${randomHex(24)}`;
}

/** Remove sessions older than their TTL (called lazily). */
function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(token);
  }
}

// ─── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono();

app.use('*', logger());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : ['http://localhost:5173'],
    credentials: true,
  }),
);

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// ─── POST /api/auth/sign-in/anonymous ─────────────────────────────────────────
// Creates an anonymous user + session. Returns a session token in the body
// (and optionally sets a cookie for browser clients).

app.post('/api/auth/sign-in/anonymous', (c) => {
  pruneExpiredSessions();

  const userId = `anon_${randomHex(12)}`;
  const token = newSessionToken();
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  sessions.set(token, {
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  c.header(
    'Set-Cookie',
    `better-auth.session_token=${token}; HttpOnly; SameSite=Lax; Path=/`,
  );

  return c.json({
    token,
    user: { id: userId, isAnonymous: true },
    session: {
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    },
  });
});

// ─── POST /api/auth/api-key/create ────────────────────────────────────────────
// Requires a valid session token (Authorization: Bearer <token> or cookie).
// Returns a permanent API key for the session's user.

app.post('/api/auth/api-key/create', async (c) => {
  const sessionToken = resolveSessionToken(c.req);
  if (!sessionToken) {
    return c.json({ error: 'Missing session token' }, 401);
  }

  pruneExpiredSessions();
  const session = sessions.get(sessionToken);
  if (!session || session.expiresAt < Date.now()) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as { name?: string };

  const key = newApiKey();
  const entry: ApiKey = {
    id: randomHex(8),
    key,
    userId: session.userId,
    name: body.name,
    enabled: true,
    createdAt: Date.now(),
  };
  apiKeys.set(key, entry);

  return c.json({
    key,
    id: entry.id,
    name: entry.name,
    userId: entry.userId,
    enabled: entry.enabled,
    createdAt: new Date(entry.createdAt).toISOString(),
  });
});

// ─── POST /api/auth/api-key/verify ────────────────────────────────────────────
// Called by Spellguard to verify an agent's API key.

app.post('/api/auth/api-key/verify', async (c) => {
  let body: { key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        valid: false,
        error: { message: 'Invalid JSON', code: 'INVALID_JSON' },
        key: null,
      },
      400,
    );
  }

  const { key } = body;
  if (!key || typeof key !== 'string') {
    return c.json(
      {
        valid: false,
        error: { message: 'Missing key', code: 'MISSING_KEY' },
        key: null,
      },
      400,
    );
  }

  const entry = apiKeys.get(key);
  if (!entry) {
    return c.json({
      valid: false,
      error: { message: 'API key not found', code: 'KEY_NOT_FOUND' },
      key: null,
    });
  }

  if (!entry.enabled) {
    return c.json({
      valid: false,
      error: { message: 'API key is disabled', code: 'KEY_DISABLED' },
      key: null,
    });
  }

  return c.json({
    valid: true,
    error: null,
    key: {
      id: entry.id,
      name: entry.name,
      userId: entry.userId,
      enabled: entry.enabled,
    },
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveSessionToken(req: {
  header: (name: string) => string | undefined;
}): string | null {
  // 1. Authorization: Bearer <token>
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);

  // 2. Cookie: better-auth.session_token=<token>
  const cookie = req.header('cookie') ?? '';
  const match = cookie.match(/better-auth\.session_token=([^;]+)/);
  if (match) return match[1];

  return null;
}

// ─── Start ───────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(
    `Better Auth server running on ${BASE_URL} (stateless/in-memory)`,
  );
  console.log(`  Sign-in:  POST ${BASE_URL}/api/auth/sign-in/anonymous`);
  console.log(`  Create:   POST ${BASE_URL}/api/auth/api-key/create`);
  console.log(`  Verify:   POST ${BASE_URL}/api/auth/api-key/verify`);
});
