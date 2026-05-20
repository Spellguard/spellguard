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

## What It Handles

- **Lazy initialization** from Cloudflare Workers env bindings (or static config)
- **Verifier discovery** via management server or direct URL
- **Bidirectional attestation** with the Verifier
- **Agent discovery** via A2A Agent Cards
- **Message encryption** with ECDH + AES-256-GCM (ephemeral X25519 keys per message)
- **Automatic routing**: bilateral for Spellguard agents, unilateral for external A2A agents
- **Policy blocks and rate limits** are terminal — no silent fallback to unguarded paths
- **Hop-count propagation** — transparently tracks message depth via `AsyncLocalStorage` to prevent infinite routing loops (enforced by the Verifier)

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

Supported providers: AWS (STS), Azure AD, GCP, Verifier (TDX/SEV), SPIFFE, AWS AgentCore.

## Advanced Usage

The lower-level `discoverAndConfigure()` and `configure()` functions are exported for advanced use cases (e.g., plugins that aren't Hono apps).

## License

MIT
