# @spellguard/gateway

The HTTP↔SLIM translation gateway for Spellguard's `agntcy` profile. It is the
single Workers-facing entry point for the agntcy deployment: agents POST plain
HTTP to it, and the gateway wraps each request as a SLIM message destined for
the Verifier. On inbound delivery, the gateway receives a SLIM message from
the Verifier and POSTs it as HTTP to the recipient agent's
`/_spellguard/receive` endpoint.

This service is **only used when `SPELLGUARD_PROFILE=agntcy`**. The default
`original` profile speaks HTTP end-to-end and does not deploy a gateway.

## What it is, and what it is not

- It **is** a thin translation layer between two transports (HTTP and SLIM)
  plus a small registry of `slimName → callbackUrl` that the Verifier
  populates via SLIM control messages.
- It **is not** a policy enforcer (the Verifier owns that), a directory
  client (the Verifier queries dir), or an audit sink (events ship from the
  Verifier to Management). The gateway holds no agent secrets, no policy
  state, and no business logic.

The split lets the Verifier scale or move independently — multiple Verifier
replicas could be served by one gateway, or the gateway could be replaced
with a WASM-native client per agent once upstream SLIM gains a WASM build.

## Quick start

```bash
pnpm --filter @spellguard/gateway run dev
```

By default it listens on `http://0.0.0.0:46358`. Point Workers agents at it
via their `VERIFIER_URL` (in agntcy mode the agent's "Verifier URL" is the
gateway URL).

## Docker

For local development the gateway runs on the host (via `pnpm run dev`) so it
hot-reloads; only the SLIM data plane + `dir` it bridges to run in Docker. To
run the gateway in a container instead, it lives in `docker-compose.agntcy.yml`
at the repo root under the `agntcy` profile (stop the host gateway first so it
doesn't collide on `:46358`):

```bash
docker compose -f docker-compose.agntcy.yml --profile agntcy up gateway
```

## Protocol

See `PROTOCOL.md` for the SLIM wire-frame shapes the gateway exchanges
with the Verifier.

## Status

Scaffolded. Frame routing and lifecycle plumbing are in place; the actual
`@agntcy/slim-bindings` calls are pending end-to-end validation against a
real SLIM data plane. See `docs/spellguard-agntcy-profile.md` for the
overall implementation plan.

## Why not run SLIM directly in the Worker-deployed agents?

Workers cannot load native node modules; `@agntcy/slim-bindings` is UniFFI
over Rust and ships as `.node` binaries. The gateway runs anywhere Node
runs (an EC2 instance, a docker container) and isolates the native
dependency from the edge runtime — agents stay on Workers and talk plain
HTTPS to a single endpoint that happens to bridge into the SLIM mesh
behind the scenes.

A future iteration may explore a WASM port of the SLIM client once
upstream `agntcy/slim` lands one, at which point Worker-resident agents
could speak SLIM natively and the gateway becomes optional. Until then,
the gateway is the supported deployment shape for the agntcy profile.
