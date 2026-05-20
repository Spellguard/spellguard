# Better Auth Identity Server Example

A minimal, stateless identity server for Spellguard's `better-auth` provider. Agents sign in anonymously and receive a permanent API key that Spellguard verifies on every discovery request — no database required.

## How it works

```
Agent                        This server                   Spellguard
  │                               │                              │
  │  POST /sign-in/anonymous      │                              │
  │──────────────────────────────>│                              │
  │  ← { token, userId }          │                              │
  │                               │                              │
  │  POST /api-key/create         │                              │
  │  Authorization: Bearer <tok>  │                              │
  │──────────────────────────────>│                              │
  │  ← { key: "ba_live_…" }       │                              │
  │                               │                              │
  │         POST /v1/discover     │                              │
  │         X-Spellguard-Platform-Attestation: base64([{         │
  │           provider: "better-auth", token: "ba_live_…" }])   │
  │──────────────────────────────────────────────────────────────>
  │                               │  POST /api-key/verify        │
  │                               │<─────────────────────────────│
  │                               │  ← { valid: true, key: … }  │
  │                               │─────────────────────────────>│
  │  ← { verifierUrl, managementToken, … }                            │
```

Sessions and API keys are stored in memory — data resets on restart. This is intentional for demos and local development.

## Setup

```bash
cd examples/better-auth-server
cp .env.example .env        # edit BETTER_AUTH_SECRET
pnpm install
pnpm dev
```

The server starts on `http://localhost:4000` by default.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BETTER_AUTH_SECRET` | Yes | — | Random secret, used to guard the server. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_BASE_URL` | No | `http://localhost:4000` | Public base URL (used in logs). |
| `PORT` | No | `4000` | Port to listen on. |
| `CORS_ORIGINS` | No | `http://localhost:5173` | Comma-separated allowed CORS origins. |

## Endpoints

### `POST /api/auth/sign-in/anonymous`

Creates an anonymous session. No body required.

```bash
curl -s -X POST http://localhost:4000/api/auth/sign-in/anonymous \
  -H "Content-Type: application/json" | jq .
```

```json
{
  "token": "abc123…",
  "user": { "id": "anon_…", "isAnonymous": true },
  "session": { "token": "abc123…", "expiresAt": "…" }
}
```

---

### `POST /api/auth/api-key/create`

Exchanges a session token for a permanent API key. Requires `Authorization: Bearer <session-token>` (or the `better-auth.session_token` cookie).

```bash
SESSION=$(curl -s -X POST http://localhost:4000/api/auth/sign-in/anonymous \
  -H "Content-Type: application/json" | jq -r .token)

curl -s -X POST http://localhost:4000/api/auth/api-key/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SESSION" \
  -d '{"name": "my-agent"}' | jq .
```

```json
{
  "key": "ba_live_…",
  "id": "…",
  "name": "my-agent",
  "userId": "anon_…",
  "enabled": true,
  "createdAt": "…"
}
```

---

### `POST /api/auth/api-key/verify`

Verifies an API key. This is the endpoint Spellguard calls — you don't normally call it directly.

```bash
curl -s -X POST http://localhost:4000/api/auth/api-key/verify \
  -H "Content-Type: application/json" \
  -d '{"key": "ba_live_…"}' | jq .
```

```json
{
  "valid": true,
  "error": null,
  "key": { "id": "…", "name": "my-agent", "userId": "anon_…", "enabled": true }
}
```

---

### `GET /health`

```bash
curl http://localhost:4000/health
# {"status":"ok"}
```

## Configuring an agent in Spellguard

1. In the Spellguard dashboard, create or edit an agent and set **Auth Mode** to `Platform` or `Dual`.
2. Add a **Better Auth** identity requirement with:
   - **Server URL**: `http://localhost:4000` (or your deployed URL)
   - Leave all other fields empty for open access.
3. Click **Auth — generate API key** to generate a `ba_live_…` key directly from the UI.
4. Copy the key and set it as `BETTER_AUTH_API_KEY` in your agent's environment.

## Testing the full flow via curl

```bash
# 1. Generate an API key
SESSION=$(curl -s -X POST http://localhost:4000/api/auth/sign-in/anonymous \
  -H "Content-Type: application/json" | jq -r .token)

KEY=$(curl -s -X POST http://localhost:4000/api/auth/api-key/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SESSION" \
  -d '{"name":"test"}' | jq -r .key)

echo "API key: $KEY"

# 2. Test through the Spellguard management verifier
ATTESTATION=$(echo "[{\"provider\":\"better-auth\",\"token\":\"$KEY\"}]" | base64 -w 0)

curl -s -X POST http://localhost:3001/v1/discover \
  -H "Content-Type: application/json" \
  -H "X-Spellguard-Platform-Attestation: $ATTESTATION" \
  -d '{"agentId":"your-agent-id"}' | jq .verifierUrl,.managementToken
```

## Deploying

This server is a plain Node.js/Hono app — deploy it anywhere Node.js runs:

- **Railway**: `railway up`
- **Fly.io**: `fly launch && fly deploy`
- **VPS**: `pnpm build && node dist/index.js`

Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_BASE_URL` in your hosting environment, then point the **Server URL** constraint in the Spellguard dashboard at the public URL.

> **Note**: In-memory storage means API keys are lost on restart. For production use, wrap the `sessions` and `apiKeys` Maps with a persistent store (Redis, KV, etc.) or use the full [Better Auth](https://better-auth.com) library with a database adapter.
