# @spellguard/client

Client middleware for Spellguard agents — handles initialization, Verifier discovery, attestation, A2A agent discovery, and message routing.

## Installation

```bash
pnpm add @spellguard/client
```

## Quick Start

```typescript
import { Hono } from 'hono';
import { createSpellguard } from '@spellguard/client';
import { generateText } from '@spellguard/client/ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

const app = new Hono<{ Bindings: Env }>();

// Mount Spellguard — handles init, Verifier callbacks, and Agent Card discovery
app.route(
  '/',
  createSpellguard<Env>({
    agentCard: {
      name: 'my-agent',
      description: 'My agent description',
      url: '',  // auto-filled from config.selfUrl
      skills: [{ id: 'chat', name: 'Chat', description: 'General conversation' }],
    },
    config: (env) => ({
      type: 'managed',
      agentId: env.AGENT_ID,
      agentSecret: env.SPELLGUARD_AGENT_SECRET,
      managementUrl: env.MANAGEMENT_URL,
      selfUrl: env.SELF_URL,
      codeHash: env.CODE_HASH,
    }),
    intentDetectionModel: (env) => {
      const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      return openrouter('anthropic/claude-3.5-haiku');
    },
    onMessage: async (message, senderId) => {
      // Handle incoming messages from other agents
      return { response: 'Hello!' };
    },
  }),
);

// Your agent's main endpoint
app.post('/chat', async (c) => {
  const { message } = await c.req.json();

  // generateText automatically:
  // 1. Detects agent references ("from Agent B", "ask Agent C")
  // 2. Discovers agents via A2A protocol
  // 3. Routes through Verifier (bilateral or unilateral)
  const result = await generateText({
    model: openrouter('anthropic/claude-sonnet-4'),
    prompt: message,
  });

  return c.json({ response: result.text });
});
```

## Configuration Modes

### Managed (recommended)

The management server assigns a Verifier and handles discovery:

```typescript
config: {
  type: 'managed',
  agentId: 'my-agent',
  agentSecret: process.env.SPELLGUARD_AGENT_SECRET!,
  managementUrl: 'https://mgmt.example.com/v1',
  selfUrl: 'https://my-agent.example.com',
  codeHash: 'sha256:abc123',
}
```

### Direct

For local development without a management server:

```typescript
config: {
  type: 'direct',
  agentId: 'my-agent',
  verifierUrl: 'http://localhost:3000',
  selfUrl: 'http://localhost:8787',
  codeHash: 'sha256:abc123',
  expectedVerifierImageHash: '...',
}
```

### Verifier attestation, and mock mode

The client attests the Verifier before sending it anything. It checks the
Verifier's attestation document against the SHA384 image hash it expects —
`expectedVerifierImageHash` in direct mode, or `verifierImageHash` from the
management server's discovery response in managed mode.

**Attestation fails closed.** If no expected image hash is configured, there is
nothing to verify against, so channel creation refuses with
`verifier_image_hash_unconfigured` rather than connecting to an unattested
Verifier. If you hit this in a managed deployment, the fix is server-side:
record the Verifier's image hash so `/v1/discover` returns `verifierImageHash`.

| Variable | Value | Effect |
|---|---|---|
| `SPELLGUARD_ALLOW_MOCK_ATTESTATION` | `true` | Skip Verifier attestation entirely. **Local development only.** |

Mock mode is never inferred from the image hash — the flag is the only way in,
and it must be exactly `true`.

**The flag is refused under a production configuration.** It activates only when
every URL the agent talks to (`verifierUrl`, and `managementUrl` when set) is a
local stack (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) or a throwaway
per-developer dev-stack (`spellguard-<service>-dev-<developer>.*.workers.dev`).
Anything else — `*.spellguard.ai`, a deployed worker whose name lacks the
`-dev-<developer>` suffix, or any host the SDK does not recognize — raises
`mock_attestation_forbidden_in_production` instead of quietly ignoring the flag.

### Tool policy checks fail closed

> **Breaking change.** Tool policy checks used to fail **open**. They now fail
> **closed** by default. Agents that wrap tools with `spellguardTool()` (or the
> LangChain / OpenAI wrappers) will see those tools BLOCKED during a Verifier
> outage where they previously ran unchecked. Set `failOpen: true` to keep the
> old behaviour — read the tradeoff below before you do.

`checkToolPolicy()` asks the Verifier's `/v1/tools/check` whether a tool call may
proceed, on both the input and the output phase.

**A 2xx carrying a recognized `effect` is the Verifier's decision, and is
returned verbatim.**

**Off a non-2xx the rule is one-way: only a decision that DENIES the call
(`block`, `redact`) is honoured.** That is what preserves the Verifier's own
fail-closed answer — `503 { effect: 'block' }`, returned when it cannot load
policy data. The client used to discard it because 503 is not 200, converting
the one case the Verifier is designed to block into an allow. It is also why the
rule does not simply run in both directions: a non-2xx carrying `allow` — or
`flag`, which also lets the call through — is treated as `verifier_refused`, not
as consent. A failed request must never grant permission.

**A check that cannot complete blocks.** The result is
`{ effect: 'block', reason }` with one of:

| `reason` | Cause |
|---|---|
| `channel_unavailable` | No channel to the Verifier — registration failed, or `configure()` was never called. |
| `verifier_unreachable` | The request never completed: connection failure, DNS, or the abort timeout. |
| `verifier_refused` | A non-2xx that carries no decision this client will act on — no `effect` at all (401 bad channel token, 403 agent mismatch, 400 bad body, 5xx), or an `allow`/`flag` that a non-2xx may not grant. |
| `malformed_response` | The body was not JSON, or carried no recognized `effect`. |
| `check_failed` | The check itself hit an unexpected error. The check never raises; this is how such an error reaches the caller. |

#### Opting out

To trade that enforcement for availability, set `failOpen` on the config you
already pass to `createSpellguard()` — it works on both modes:

```typescript
createSpellguard<Env>({
  agentCard: { /* … */ },
  config: (env) => ({
    type: 'managed',
    agentId: env.AGENT_ID,
    managementUrl: env.MANAGEMENT_URL,
    selfUrl: env.SELF_URL,
    codeHash: env.CODE_HASH,
    // Tool calls run UNCHECKED whenever the policy check cannot complete.
    failOpen: true,
  }),
  onMessage: async () => ({ ok: true }),
});
```

The lower-level `configure({ …, failOpen: true })` /
`discoverAndConfigure({ …, failOpen: true })` take the same field.

**What `failOpen: true` costs:** a tool call RUNS UNCHECKED whenever the policy
check cannot complete. Every policy bound to that tool is silently skipped for
the duration of the outage, and nothing else signals it. It does not overrule
the Verifier — an explicit denial still wins, so a `503 { effect: 'block' }`
still blocks.

| Variable | Value | Effect |
|---|---|---|
| `SPELLGUARD_TOOL_POLICY_FAIL_OPEN` | `true` | Secondary route, for a process that never passes a config at all. |

**The environment variable is not a universal fallback.** It is read from
`process.env`, so it only works in a runtime that exposes one — Node, Bun, Deno.
**On Cloudflare Workers it does nothing** unless the Worker's
`compatibility_date` is late enough for workerd to populate `process.env` from
`vars`; the agents in this repo pin dates that predate it. On a Worker, the
config field above is the only opt-out. `failOpen` on the config wins when both
are set.

## What It Handles

- **Lazy initialization** from Cloudflare Workers env bindings (or static config)
- **Verifier discovery** via management server or direct URL
- **Bidirectional attestation** with the Verifier
- **Agent discovery** via A2A Agent Cards
- **Message encryption** with ECDH + AES-256-GCM (ephemeral X25519 keys per message)
- **Automatic routing**: bilateral for Spellguard agents, unilateral for external A2A agents
- **Policy blocks and rate limits** are terminal — no silent fallback to unguarded paths
- **Hop-count propagation** — transparently tracks message depth via `AsyncLocalStorage` to prevent infinite routing loops (enforced by the Verifier)
- **Signed deliveries** — `/_spellguard/receive` accepts only deliveries this agent's Verifier signed (report-only against a Verifier that doesn't advertise `deliveryAuth: 'v1'`)
- **Bypass alerts** — each refused or unverified delivery is reported to management (at most once per outcome and reason every five minutes), which alerts the organization's owners and admins on the dashboard

## Platform Attestation

Agents can authenticate via platform identity instead of shared secrets:

```typescript
config: {
  type: 'managed',
  agentId: 'my-agent',
  managementUrl: '...',
  selfUrl: '...',
  codeHash: '...',
  platformAttestation: {
    providers: [
      {
        provider: 'aws',
        getToken: async () => generatePresignedCallerIdentityUrl(),
      },
    ],
  },
}
```

Supported providers — the `AttestationProvider` union, which mirrors the
management server's own union member for member: `aws`, `azure`,
`azure-maa`, `clerk`, `gcp`, `salesforce`, `spiffe`, `verifier`,
`nitro-verifier`, `aws-agentcore`, `better-auth`, `jwk`, `oidc`,
`vestauth`, `x509`.

## Advanced Usage

The lower-level `discoverAndConfigure()` and `configure()` functions are exported for advanced use cases (e.g., plugins that aren't Hono apps).

## License

MIT
