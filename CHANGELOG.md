# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it reaches `1.0.0`. Pre-`1.0.0` releases may contain breaking changes
in any minor version bump — see the release notes for details.

## [0.1.0] - 2026-07-01

This release ships, for the first time, the **Claude Code** and **Codex**
coding-agent plugins, the shared **`@spellguard/agent-control`** credential-channel
client, the **AGNTCY SLIM gateway**, and the generated
**`@spellguard/management-api-types`** package. The demo agents can now run on the
**AGNTCY profile** (SLIM data plane + `dir` registry) via a one-command local-dev
stack, and all message legs gain gateway-opaque, app-layer encryption.

### Added

- **`@spellguard/claude-code-plugin`** — a Claude Code plugin (installable through
  the `/plugin` marketplace flow) that provisions and manages a scoped,
  attributable Spellguard GitHub credential. `SessionStart`/`PreToolUse`/`PostToolUse`
  hooks inject a git credential helper, spawn a background credential daemon, and
  record git activity (pushes, branch creates, PRs, commits); `/spellguard-setup`
  and `/spellguard-reset` skills handle browser-based provisioning and clean
  teardown. Revocation propagates within seconds and fails git operations closed
  with an actionable message. HTTPS remotes only (SSH refused). Optional portable
  SQLite code-attribution backend (`node:sqlite` / `better-sqlite3` with a
  self-install fallback); core tracking still works without the native module.
  Requires `SPELLGUARD_BASE_URL` (or `--base-url`) — the OSS build ships no default
  endpoint.
- **`@spellguard/codex-plugin`** — the OpenAI Codex counterpart (`codex plugin
  marketplace add` / `codex plugin add`), with `@spellguard-setup` /
  `@spellguard-reset` skills. Wires git/`gh` credential helpers through a
  Codex-scoped `~/.codex/config.toml` `[shell_environment_policy]` block (never the
  machine-global `~/.gitconfig`); credentials live session-local under
  `~/.config/spellguard/`. Runs a persistent agent-control daemon for push-based
  credential rotation/revocation, denies `git push` / `gh pr create` on a revoked
  credential, and shares the wire protocol, socket client, and daemon with the
  Claude Code plugin. Also requires `SPELLGUARD_BASE_URL` / `--base-url`.
- **`@spellguard/agent-control`** — a framework-neutral library holding the single
  TypeScript copy of the agent credential-channel client and wire protocol, shared
  by the Claude Code, Codex, and OpenClaw plugins. Includes `AgentControlClient`
  (PartySocket WebSocket transport with reconnect/resume, Hello/Ack handshake, and
  `credential_delivered` / `credential_rotated` / `credential_revoked` /
  `config_updated` frame handling), a typed version-pinned protocol
  (`AGENT_CONTROL_PROTOCOL_VERSION`) with a redacted-replay contract, a typed
  `openapi-fetch` management REST client (`agent-secret` and `bearer` auth,
  single-retry-on-5xx, agent-gone detection), and a versioned plugin-integration
  contract.
- **`@spellguard/management-api-types`** — a pure-types package exposing the
  management API as generated `openapi-typescript` definitions (`import type {
  paths, components, operations }`), the single source for building typed
  `openapi-fetch` clients. No runtime, no build step; safe in browser, Node, and
  Workers.
- **`@spellguard/gateway`** — an HTTP-to-SLIM translation service that lets
  HTTP/Workers agents participate in the AGNTCY SLIM transport. Wraps outbound HTTP
  as SLIM messages to the Verifier and POSTs SLIM-inbound messages to each agent's
  `/_spellguard/receive` callback, maintaining a `slimName -> callbackUrl` registry
  over SLIM control messages (documented WebSocket sidecar protocol in
  `PROTOCOL.md`). Isolates the native `@agntcy/slim-bindings` dependency on a Node
  host so edge agents stay on plain HTTPS. Wires up SLIM MLS per-session encryption
  on the gateway↔Verifier hops via shared-secret keying. Runs only under
  `SPELLGUARD_PROFILE=agntcy`; ships a Dockerfile for the compose profile or `pnpm
  dev` on the host. This is an early-stage component — per the package README its
  `@agntcy/slim-bindings` calls are still pending end-to-end validation against a
  live SLIM data plane.
- **AGNTCY-profile local-dev stack** — `docker-compose.agntcy.yml` brings up the
  SLIM data plane (`:46357`), a self-contained AGNTCY `dirctl daemon` with embedded
  SQLite/OCI store (`:8888`), and an optional profile-gated containerized Gateway
  (`:46358`). Adds `slim-config/server-config.yaml`, a `dev:agntcy` /
  `dev:agntcy:up` / `dev:agntcy:down` workflow, a protocol-flow diagram in the
  README, and pins `ghcr.io/agntcy/slim:2.0.0-alpha.1` +
  `ghcr.io/agntcy/dir-ctl:v1.4.0`. Integration tests now require the full agntcy
  stack running.

### Changed

- **`@spellguard/amp`** — adds a pluggable profile system (`loadProfile` /
  `ProfileBundle`) that swaps transport, discovery, and identity at deploy time via
  `SPELLGUARD_PROFILE` (default `original`). A new full `agntcy` profile provides
  SLIM data-plane transport over a gateway WebSocket, the AGNTCY `dir` registry for
  resolve/publish, and AGNTCY Identity Ed25519 JWT Verifiable Credentials; an
  unknown profile falls back to `original` with a warning, and unreachable AGNTCY
  infra fails loudly with structured errors. Adds `deriveAgentKeyPair(seed)`
  (deterministic X25519 via domain-separated HKDF) and `generateAgentKeyPair()` for
  gateway-opaque app-layer encryption. New `@spellguard/amp/profile` entrypoint,
  mirrored in the Python `spellguard_amp` package. The AGNTCY profile is renamed
  from `slim` to `agntcy`.
- **`@spellguard/client`** — adds gateway-opaque, app-layer encryption on every
  message leg: the client derives a per-agent X25519 keypair from its stable
  secret, registers the public key with the Verifier, and encrypts/decrypts inbound
  deliveries, replies, and sends so an intermediary gateway sees only ciphertext
  (agents without secret material stay on the legacy plaintext path). Resolves the
  active messaging profile at init, normalizes the management base URL (with or
  without a `/v1` suffix), and raises request timeouts to tolerate SLIM cold-session
  establishment and LLM-bearing routing (registration/policy checks 10s→60s;
  message-send legs gain an explicit 120s timeout).
- **`@spellguard/verifier`** — adds the full AGNTCY SLIM delivery path (worker-thread
  SLIM endpoint, gRPC `dir` resolution, HTTP-over-SLIM delivery to the gateway),
  with SLIM-only delivery when no management URL is set (the directory is the sole
  registry; resolution fails loudly rather than falling back to HTTP). Adds
  gateway-opaque message encryption to a recipient's registered X25519 key (X25519 +
  AES-256-GCM, HKDF info `spellguard-amp-v1`) with automatic plaintext fallback for
  legacy agents. Adds self-healing for the native SLIM RSS leak (proactive
  low-watermark self-recycle that exits only when no delivery is in flight), an
  off-loop SharedArrayBuffer liveness/health responder, a FIFO concurrency gate on
  inbound SLIM handling, supervised SLIM worker threads with backoff respawn, and an
  8s discovery-fetch deadline. Exposes the active profile/transport on system-info
  and heartbeat output.
- **`@spellguard/ctls`** — adds an optional `clientPublicKey` (X25519, hex) and
  `slimName` (AGNTCY SLIM name) to `RegisteredAgent` so the Verifier can encrypt
  delivered payloads to the agent and route over SLIM when discovered via the SLIM
  profile (both fall back to legacy/HTTP when absent). Raises the attestation-fetch
  per-attempt timeout 8s→60s and reduces retries 2→1 for cold SLIM gateway sessions.
- **LangChain and OpenAI adapters** — now capture and report per-call LLM token
  usage. `wrapOpenAI` reports usage from non-streaming chat completions (including
  cached-input and reasoning tokens; streaming skipped); the LangChain adapter
  (TypeScript and Python `SpellguardChatModel`) emits usage read defensively across
  provider-specific shapes. Emission is fire-and-forget and fail-open — it never
  throws into the underlying LLM call.
- **`@spellguard/openclaw-plugin`** — renamed from `@openclaw/spellguard` (npm scope
  migration; update imports). Raises the default `before_dispatch` Verifier-evaluate
  timeout 5s→10s and adds a configurable `verifierTimeout` (ms) option. Adds an
  Apache-2.0 LICENSE.
- **mcp-guard** — renames the `--management-url` flag to `--base-url` and the
  `SPELLGUARD_MANAGEMENT_URL` env var to `SPELLGUARD_BASE_URL`; the value must
  include the `/v1` path prefix.
- Upgraded `@agntcy/slim-bindings` and the SLIM data-plane image to `2.0.0-alpha.1`.

### Fixed

- **Routing cycles (`@spellguard/client`)** — a receiving agent no longer
  auto-routes back to its immediate inbound sender; the sender id is carried through
  the hop-context store and excluded from auto-route targets, keeping the
  communication graph a DAG.
- **Bilateral response-leg policy gap (`@spellguard/verifier`)** — recipient outbound
  policies are now evaluated on bilateral responses (redaction, quarantine,
  obligation dispatch) instead of the response leg being hardcoded to allow; no
  behavior change for agents without outbound bindings.
- **SLIM gateway resilience (`@spellguard/gateway`)** — a wedge detector recycles a
  wedged bindings process via soft consecutive/decaying-window counters, and an
  exactly-once publish-phase retry transparently replaces a dead cached session
  instead of surfacing one-shot send failures.

## [0.0.2] - 2026-05-20

### Added

- `CODE_OF_CONDUCT.md` adopting the [Contributor Covenant 2.1][cc21] by
  reference, with `conduct@spellguard.ai` as the reporting channel.
  Linked from `CONTRIBUTING.md`.

[cc21]: https://www.contributor-covenant.org/version/2/1/code_of_conduct/

## [0.0.1] - 2026-05-18

Initial OSS export of the Spellguard subset: client middleware, Verifier
proxy server, cTLS, AMP, LangChain / OpenAI / OpenClaw adapters, policy
SDK and catalog, demo agents, and the cross-language Python ports.
