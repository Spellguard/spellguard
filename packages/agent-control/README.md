# @spellguard/agent-control

The neutral, framework-agnostic **agent-control credential-socket client** and
**wire protocol** for Spellguard-managed agents.

This package holds the single TypeScript implementation of the
agent-to-backend credential-channel protocol client. The Spellguard agent
plugins depend on it so that the client and protocol live in one place rather
than being duplicated per framework:

- `@spellguard/claude-code-plugin` (Claude Code)
- `@spellguard/codex-plugin` (Codex)
- `@spellguard/openclaw-plugin` (OpenClaw)

## What's in here

| Module | Purpose |
| --- | --- |
| `client.ts` | `AgentControlClient` — the PartySocket transport, reconnect/resume, Hello/Ack handling, and the `secret` / `nonce` / `managed-bootstrap` start modes. |
| `protocol.ts` | The wire frames, credential descriptors, config descriptor, and close codes. **Types only — no runtime.** |
| `claim-flow.ts` | `runManagedBootstrap` — the managed-provisioning first-boot orchestrator (Lightsail / Railway), built on top of `AgentControlClient`. |

Framework-specific credential **handlers** (which write a particular agent's
on-disk config or mutate its git credential helper) deliberately do **not**
live here — they are not shareable, so each plugin keeps its own
`credential-handlers.ts`.

## Protocol parity

`protocol.ts` is the client-side mirror of the wire contract. Two other copies
cannot import this TypeScript package and must be kept structurally in sync:

1. **The Spellguard backend** (the server side of the channel).
2. **The Python mirror** used by the Hermes plugin.

Drift between the TypeScript copies and the server copy is verified by the
protocol-shape test. Any change to the wire shape here must update all copies
together.

## Build

This package commits its `dist/` (built `.mjs` + `.d.ts`) so consumers resolve
it without a separate build step:

```bash
pnpm --filter @spellguard/agent-control run build
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
