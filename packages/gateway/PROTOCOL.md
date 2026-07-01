# Slim Sidecar Wire Protocol

Status: **v0.1 draft**. Frame shapes are stable; semantics are subject to
revision as the SLIM transport is wired up across follow-up commits on
`feat/agntcy-slim-profile`.

## Why a sidecar

`@agntcy/slim-bindings` is a native Node module (UniFFI over Rust). It can't
run inside Cloudflare Workers, but the Verifier and example agents in this
repo all target Workers. The sidecar runs the native binding on a Node host
and exposes a minimal WebSocket bridge that Workers code can speak to.

A future Phase 7 commit may replace this with a WASM port (Rust-core
compiled with a pluggable transport that uses Workers' `connect()` API).
Until then, **slim profile = Workers + sidecar**.

## Transport

WebSocket. The Spellguard client (`SlimTransport`) opens a single persistent
connection per process and multiplexes all sends/receives over it.

- URL: `ws://<host>:<port>` (default `46358`)
- Subprotocol: `spellguard-slim-v0.1` (RFC 6455 token grammar — no `/`)
- Frame format: UTF-8 JSON, one frame per WebSocket message
- Heartbeat: client sends `{"type":"ping"}` every 30s; sidecar responds with
  `{"type":"pong"}` carrying current sidecar uptime in ms

## Frames

### Client → sidecar

#### `hello` (first frame after open)

Negotiates protocol version and binds the connection to an agent identity in
the SLIM mesh.

```json
{
  "type": "hello",
  "agentId": "agent-a",
  "slimName": "org-acme/agent-a",
  "version": "0.1"
}
```

Sidecar responds with `welcome` (success) or `error` (mismatch, registration
refused, etc).

#### `send` (outbound message)

Request a SLIM SRPC call to a recipient. The recipient address is profile-
agnostic; the sidecar interprets `slimName` to route on the SLIM data plane.

```json
{
  "type": "send",
  "requestId": "uuid-v4",
  "to": { "agentId": "agent-b", "slimName": "org-acme/agent-b" },
  "message": {
    "id": "msg-...",
    "sender": "agent-a",
    "recipient": "agent-b",
    "encryptedPayload": "base64...",
    "timestamp": 1716580000000
  }
}
```

Sidecar responds with `send-result` carrying the recipient's response
SecureMessage (or an error frame correlated by `requestId`).

#### `close`

Graceful shutdown. Sidecar drops the agent from its session table.

### Sidecar → client

#### `welcome`

Successful `hello` ack. Carries the SLIM control-plane URL the sidecar is
connected to, for diagnostics.

```json
{
  "type": "welcome",
  "controlPlane": "https://slim-cp.example:46357",
  "agentId": "agent-a",
  "version": "0.1"
}
```

#### `inbound` (push)

A SLIM message arrived for the bound agent. The client's `SlimTransport`
demultiplexes by recipient agent and invokes whichever handler the upper
layer registered via `transport.listen()`.

```json
{
  "type": "inbound",
  "from": { "agentId": "agent-b", "slimName": "org-acme/agent-b" },
  "message": {
    "id": "msg-...",
    "sender": "agent-b",
    "recipient": "agent-a",
    "encryptedPayload": "base64...",
    "timestamp": 1716580000050
  }
}
```

Client responds with `inbound-ack` carrying the response SecureMessage. The
sidecar then completes the SLIM SRPC turn back to the original sender.

#### `send-result`

Response to a prior `send` frame. `requestId` matches the request.

```json
{
  "type": "send-result",
  "requestId": "uuid-v4",
  "message": {
    "id": "msg-...",
    "sender": "agent-b",
    "recipient": "agent-a",
    "encryptedPayload": "base64...",
    "timestamp": 1716580000050
  }
}
```

#### `error`

Generic error. `requestId` is present when the error correlates with a
specific request; absent for connection-level errors.

```json
{
  "type": "error",
  "requestId": "uuid-v4",
  "code": "agent-not-found",
  "message": "No SLIM route for slimName=org-acme/agent-z"
}
```

## Error codes (v0.1)

| Code | Meaning |
|---|---|
| `not-implemented` | Stub handler is still in place (current state of every code path). |
| `agent-not-found` | SLIM data plane has no route for the supplied `slimName`. |
| `version-mismatch` | Client requested a protocol version the sidecar doesn't speak. |
| `invalid-frame` | Frame failed JSON parse or schema validation. |
| `internal` | Catch-all. Check sidecar logs. |

## Lifecycle

1. Client opens the WebSocket and sends `hello`.
2. Sidecar registers the agent in its session table, opens (or reuses) a
   SLIM session for the agent's `slimName`, and replies `welcome`.
3. Client sends `send` frames; sidecar forwards them via SLIM SRPC.
4. Inbound SLIM messages arrive at the sidecar, which pushes them as
   `inbound` frames.
5. On disconnect, sidecar drops the session table entry. Reconnect requires
   a fresh `hello`.

## Out of scope (deferred to follow-up commits)

- MLS group join: currently the sidecar speaks SLIM in its default session
  mode. Group-key agreement is wired up in Phase 4 alongside AgntcyIdentity.
- Backpressure / flow control: client and sidecar both buffer naively.
- Authentication of the sidecar connection itself (client→sidecar trust). At
  v0.1 we rely on the sidecar listening on localhost only.
