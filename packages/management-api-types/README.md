# @spellguard/management-api-types

The single generated **types** source of truth for the Spellguard management API,
shared by every TypeScript consumer. Pure types — no runtime, no build, no
`dist`.

Generated from `packages/management/openapi.json` by `openapi-typescript` (via
`pnpm run gen:clients` and the dev type-watcher). Import types only:

```ts
import type { paths } from '@spellguard/management-api-types';
```

The import is erased at build, so the package is safe in every environment
(browser, Node, Workers) and adds nothing to any consumer's bundle.

## Runtime clients live with each auth class — not here

This package deliberately contains **no** runtime client, because the three ways
to authenticate to the management API don't share code and are coupled to their
own consumers' internal state:

| Consumer | Auth | Client lives in |
|---|---|---|
| Claude Code + Codex | `X-Spellguard-Agent-Id` / `-Secret` headers | `@spellguard/agent-control` → `createManagementClient` |
| OpenClaw | `Authorization: Bearer` (plugin-sync) + agent-secret (proxy-connect) | `@spellguard/agent-control` → `createManagementClient` (auth modes; OpenClaw is open source, so it shares the client) |
| Dashboard | Supabase bearer + active-org header + 401-refresh | `packages/management/dashboard/src/api/typed-client.ts` |
| Verifier (future) | management JWT | `packages/verifier/src/` |

Each creates `createClient<paths>()` with these types and attaches its own auth
middleware.
```
