![Spellguard](media/Spellguard_X_Banner_Image_1500x500px.png)

# Spellguard

Secure, auditable agent-to-agent communication framework. Agents communicate
through a Verifier that logs all interactions for auditability while
maintaining forward secrecy.

Supports pluggable backends for logging and archival — transparency logs for
tamper-evident commitments, S3 for encrypted message storage. Message content
is encrypted with a server public key before archiving, enabling on-demand
decryption for post-mortem incident analysis.

## Why Spellguard?

As AI agents become more autonomous and interact with each other, we need:

1. **Auditability** — A verifiable record of what agents communicated.
2. **Security** — Protection against compromised agents and MITM attacks.
3. **Simplicity** — Developers shouldn't need to understand cryptography to
   build secure agents.
4. **Interoperability** — Communicate with agents that don't use Spellguard.

## How It Works

```
┌─────────────┐     ┌─────────────────────┐     ┌─────────────┐     ┌─────────────────────┐     ┌─────────────┐
│   Agent A   │     │ @spellguard/client  │     │  Verifier   │     │ @spellguard/client  │     │   Agent B   │
│             │     │   (A's middleware)  │     │   (proxy)   │     │   (B's middleware)  │     │             │
└──────┬──────┘     └──────────┬──────────┘     └──────┬──────┘     └──────────┬──────────┘     └──────┬──────┘
       │                       │                       │                       │                       │
       │  generateText(...)    │                       │                       │                       │
       │──────────────────────>│                       │                       │                       │
       │                       │  1. Discover Agent B  │                       │                       │
       │                       │──────────────────────>│                       │                       │
       │                       │  2. Establish channel │                       │                       │
       │                       │<─────────────────────>│<─────────────────────>│                       │
       │                       │  3. Send message      │                       │                       │
       │                       │─────────────────────->│                       │                       │
       │                       │                       │  4. Policy checks     │                       │
       │                       │                       │  5. Log commitment    │                       │
       │                       │                       │  6. Archive message   │                       │
       │                       │                       │  7. Forward to Agent B│                       │
       │                       │                       │─────────────────────->│─────────────────────->│
       │                       │                       │                       │<──────────────────────│
       │                       │                       │<──────────────────────│      response         │
       │                       │<──────────────────────│      result           │                       │
```

**Key insight**: Agents never communicate directly. All messages flow through the Verifier, which handles discovery, verification, and logging automatically.

## Deployment

**☁️  Managed Service (Recommended)**

The fastest way to deploy Spellguard at your organization. Full dashboard, enterprise support, and zero infrastructure management.

[Request a demo at spellguard.ai →](https://spellguard.ai)

**🛠️  Self-Hosted**

This repository contains the open source implementation — ideal for development, testing, or custom integrations. Run everything locally with `pnpm run dev`, configure policies via `packages/verifier/bindings.json`, and build a production image from `packages/verifier/Dockerfile`. See [Development](#development) below to get started.

## Packages

### TypeScript

| Package | Description |
|---------|-------------|
| `@spellguard/client` (`packages/client/ts/`) | Client middleware — discovery, attestation, A2A routing |
| `@spellguard/verifier` (`packages/verifier/`) | Verifier proxy server — message routing, policy enforcement, audit logging |
| `@spellguard/ctls` (`packages/ctls/ts/`) | Confidential TLS — bidirectional attestation, ephemeral keys, Ed25519 |
| `@spellguard/amp` (`packages/amp/ts/`) | Auditable Messaging Protocol — ECDH encryption, commitment logging |
| `@spellguard/langchain` (`packages/langchain/ts/`) | LangChain.js integration — wrap any `BaseChatModel` |
| `@spellguard/openai` (`packages/openai/`) | OpenAI SDK integration — wrap an OpenAI client |
| `@spellguard/openclaw-plugin` (`packages/openclaw-plugin/`) | OpenClaw plugin |
| `@spellguard/policy-sdk` (`packages/policy-sdk/`) | SDK for building external policy servers |
| `@spellguard/policy-catalog` (`packages/policy-catalog/`) | Policy definitions as JSONC — validate, diff, sync |
| `@spellguard/mcp-guard` (`packages/mcp-guard/`) | MCP server guard |

### Python

| Package | Description |
|---------|-------------|
| `spellguard-ctls` (`packages/ctls/py/`) | Python port of cTLS |
| `spellguard-amp` (`packages/amp/py/`) | Python port of AMP |
| `spellguard-client` (`packages/client/py/`) | Python client — FastAPI integration, `generate_text` |
| `spellguard-langchain` (`packages/langchain/py/`) | Python LangChain integration |
| `spellguard-crewai` (`packages/crewai-py/`) | CrewAI integration |

Demo agents live in `packages/agents/`.

## Setup

```bash
# Node dependencies
pnpm install

# Build workspace TS libs. Required before typecheck/test because
# workspace packages resolve each other through `exports` fields that
# point at ./dist/.
pnpm run build:libs

# Python dependencies (requires Python 3.13)
pnpm run setup:python
```

## Development

Each demo agent under `packages/agents/` reads its LLM credentials from a
local `.env` file. Copy each agent's `.env.example` to `.env` and fill in
your OpenRouter key:

```bash
# Repeat for every agent you plan to run (agent-a, agent-b, agent-c, ...).
cp packages/agents/agent-a/.env.example packages/agents/agent-a/.env
# Then edit the file and set:
#   OPENROUTER_API_KEY=sk-or-v1-...
```

Agents will fail to start without a valid `OPENROUTER_API_KEY`.

### AGNTCY profile (default for the demo agents)

The demo agents under `packages/agents/` ship configured for the **`agntcy`
profile** (`SPELLGUARD_PROFILE=agntcy`): instead of speaking plain HTTP, they
route agent↔agent traffic over the [AGNTCY SLIM](https://github.com/agntcy/slim)
data plane and resolve each other through an AGNTCY `dir` registry. Two backing
services can't run on the host without Docker, so start them first (requires
Docker):

```bash
# Start the SLIM data plane (:46357) + AGNTCY dir (:8888) in the background.
pnpm run dev:agntcy:up
# ...then run the Verifier + Gateway + every demo agent on the host:
SPELLGUARD_PROFILE=agntcy pnpm run dev
```

`pnpm run dev:agntcy` does both in one step (boots the backing services, then runs
`pnpm run dev` with the profile set); `pnpm run dev:agntcy:down` stops them. The
Verifier logs the active profile at startup so you can confirm:

```
[Verifier] Profile: agntcy (transport=slim, directory=dir, identity=agntcy-vc)
```

```bash
pnpm run dev:agntcy           # SLIM backing services + Verifier + Gateway + agents
pnpm run dev:verifier         # Or: just the Verifier server (no agents)
```

> Running without the SLIM backing services (e.g. plain `pnpm run dev`) leaves
> the Verifier and Gateway retrying their SLIM connection — start the data plane
> with `pnpm run dev:agntcy:up` first.

### Policy enforcement

The Verifier loads policy bindings from `packages/verifier/bindings.json`
on startup. The shipped file wires up three demo policies (prompt-injection
flagging on every agent by default, a six-seven regex flag on `agent-a`
outbound, and a keyword block on `agent-b` inbound) — edit it to define
your own rules.

The file format mirrors the `ResolvedPolicyConfig` type at
`packages/verifier/src/proxy/policy-evaluator-types.ts`. Each entry has a
`policyType` (e.g. `regex`, `keyword`, `injection`), an `effect`
(`flag` | `block` | `redact` | …), and a `config` blob consumed by the
matching policy engine.

To point at a different file, set `VERIFIER_LOCAL_POLICIES`:

```bash
VERIFIER_LOCAL_POLICIES=/path/to/my-bindings.json pnpm run dev:verifier
```

Policy decisions land in an in-memory audit ring at `GET /logs/audit-events`
on the Verifier (filter with `?agentId=` and `?limit=`).

## Testing

```bash
pnpm run typecheck
pnpm run lint
pnpm run test                 # TypeScript unit tests (vitest)
pnpm run test:python          # Python unit tests (pytest)
# Integration tests need the full agntcy stack (SLIM data plane + dir + Verifier +
# Gateway + agents) running. Start it with `pnpm run dev:agntcy` in another
# terminal before running either of these:
pnpm run test:integration     # TypeScript integration tests
pnpm run test:python:integration
```

If typecheck or test fails with `Cannot find module '@spellguard/...'`, run
`pnpm run build:libs` first — workspace packages import each other through
compiled `./dist/` outputs.

## License

See [LICENSE](LICENSE).
