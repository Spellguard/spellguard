# spellguard-client

Python client for Spellguard agents - handles initialization, Verifier discovery, attestation, A2A agent discovery, and message routing.

Python port of [`@spellguard/client`](../client/README.md).

## Installation

```bash
pip install spellguard-client
# or as an editable install from the monorepo
pip install -e packages/client/py
```

## Quick Start

```python
from openai import AsyncOpenAI
from fastapi import Request
from fastapi.responses import JSONResponse

from spellguard_client.spellguard import create_spellguard
from spellguard_client.ai import generate_text


async def on_message(ctx):
    """Handle incoming messages from other agents."""
    result = await generate_text(
        model=ctx.model,
        model_name="anthropic/claude-sonnet-4",
        system="You are helpful.",
        prompt=ctx.message.get("prompt", str(ctx.message)),
    )
    return {"response": result.text}


spellguard = create_spellguard(
    agent_card={
        "name": "my-agent",
        "description": "My agent description",
        "url": "",  # auto-filled from config.self_url
        "skills": [{"id": "chat", "name": "Chat", "description": "General conversation"}],
    },
    config=lambda: {
        "type": "direct",
        "agent_id": "my-agent",
        "verifier_url": "http://localhost:3000",
        "self_url": "http://localhost:8801",
        "code_hash": "dev-hash",
    },
    model=lambda: AsyncOpenAI(
        api_key="your-api-key",
        base_url="https://openrouter.ai/api/v1",
    ),
    on_message=on_message,
)

app = spellguard.app()


@app.post("/chat")
async def chat(request: Request):
    body = await request.json()

    # generate_text automatically:
    # 1. Detects agent references ("from Agent B", "ask Agent C")
    # 2. Discovers agents via A2A protocol
    # 3. Routes through Verifier (bilateral or unilateral)
    result = await generate_text(
        model=spellguard.model,
        model_name="anthropic/claude-sonnet-4",
        system="You are helpful.",
        prompt=body["message"],
    )
    return JSONResponse({"response": result.text})
```

## Configuration Modes

### Managed (recommended)

The management server assigns a Verifier and handles discovery:

```python
config=lambda: {
    "type": "managed",
    "agent_id": "my-agent",
    "agent_secret": os.environ["SPELLGUARD_AGENT_SECRET"],
    "management_url": "https://mgmt.example.com/v1",
    "self_url": "https://my-agent.example.com",
    "code_hash": "sha256:abc123",
}
```

### Direct

For local development without a management server:

```python
config=lambda: {
    "type": "direct",
    "agent_id": "my-agent",
    "verifier_url": "http://localhost:3000",
    "self_url": "http://localhost:8801",
    "code_hash": "sha256:abc123",
    "expected_verifier_image_hash": "sha384:...",
}
```

### Verifier attestation, and mock mode

The client attests the Verifier before sending it anything. It checks the
Verifier's attestation document against the SHA384 image hash it expects —
`expected_verifier_image_hash` in direct mode, or `verifierImageHash` from the
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
every URL the agent talks to (`verifier_url`, and `management_url` when set) is a
local stack (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) or a throwaway
per-developer dev-stack (`spellguard-<service>-dev-<developer>.*.workers.dev`).
Anything else — `*.spellguard.ai`, a deployed worker whose name lacks the
`-dev-<developer>` suffix, or any host the SDK does not recognize — raises
`mock_attestation_forbidden_in_production` instead of quietly ignoring the flag.

### Tool policy checks fail closed

> **Breaking change.** Tool policy checks used to fail **open**. They now fail
> **closed** by default. Agents that wrap tools with `spellguard_tool()` (or the
> LangChain / CrewAI wrappers) will see those tools BLOCKED during a Verifier
> outage where they previously ran unchecked. Set `fail_open=True` to keep the
> old behaviour — read the tradeoff below before you do.

`check_tool_policy()` asks the Verifier's `/v1/tools/check` whether a tool call
may proceed, on both the input and the output phase.

**A 2xx carrying a recognized `effect` is the Verifier's decision, and is
returned verbatim.**

**Off a non-2xx the rule is one-way: only a decision that DENIES the call
(`block`, `redact`) is honoured.** That is what preserves the Verifier's own
fail-closed answer — `503 {"effect": "block"}`, returned when it cannot load
policy data. The client used to discard it because 503 is not 200, converting
the one case the Verifier is designed to block into an allow. It is also why the
rule does not simply run in both directions: a non-2xx carrying `allow` — or
`flag`, which also lets the call through — is treated as `verifier_refused`, not
as consent. A failed request must never grant permission.

**A check that cannot complete blocks.** The result is
`ToolCheckResult(effect="block", reason=...)` with one of:

| `reason` | Cause |
|---|---|
| `channel_unavailable` | No channel to the Verifier — registration failed, or `configure()` was never called. |
| `verifier_unreachable` | The request never completed: connection failure, DNS, or the httpx timeout. |
| `verifier_refused` | A non-2xx that carries no decision this client will act on — no `effect` at all (401 bad channel token, 403 agent mismatch, 400 bad body, 5xx), or an `allow`/`flag` that a non-2xx may not grant. |
| `malformed_response` | The body was not JSON, or carried no recognized `effect`. |
| `check_failed` | The check itself hit an unexpected error. The check never raises; this is how such an error reaches the caller. |

#### Opting out

To trade that enforcement for availability, set `fail_open` on the config you
already pass to `create_spellguard()` — it works on both modes, and on both the
dict and the dataclass form:

```python
spellguard = create_spellguard(
    agent_card={...},
    config=lambda: {
        "type": "managed",
        "agent_id": "my-agent",
        "management_url": "https://mgmt.example.com/v1",
        "self_url": "https://my-agent.example.com",
        "code_hash": "sha256:abc123",
        # Tool calls run UNCHECKED whenever the policy check cannot complete.
        "fail_open": True,
    },
    on_message=on_message,
)
```

The lower-level `configure(SpellguardConfig(..., fail_open=True))` /
`discover_and_configure(SpellguardDiscoveryConfig(..., fail_open=True))` take
the same field.

**What `fail_open=True` costs:** a tool call RUNS UNCHECKED whenever the policy
check cannot complete. Every policy bound to that tool is silently skipped for
the duration of the outage, and nothing else signals it. It does not overrule
the Verifier — an explicit denial still wins, so a `503 {"effect": "block"}`
still blocks.

| Variable | Value | Effect |
|---|---|---|
| `SPELLGUARD_TOOL_POLICY_FAIL_OPEN` | `true` | Secondary route, for a process that never passes a config at all. |

**The environment variable is not a universal fallback** — it is read from
`os.environ`, so it only works in a runtime that exposes one. The TypeScript
twin has the sharper version of this caveat (Cloudflare Workers), but the rule
is the same: when in doubt, use the config field. `fail_open` on the config wins
when both are set.

## What It Handles

- **Lazy initialization** on first request (config can be a callable for deferred env access)
- **Verifier discovery** via management server or direct URL
- **Bidirectional attestation** with the Verifier
- **Agent discovery** via A2A Agent Cards
- **Message encryption** with ECDH + AES-256-GCM (ephemeral X25519 keys per message)
- **Automatic routing**: bilateral for Spellguard agents, unilateral for external A2A agents
- **Tool-calling loop** built into `generate_text` (dispatches tools via a dict)
- **Hop-count propagation** — transparently tracks message depth via `contextvars` to prevent infinite routing loops (enforced by the Verifier)
- **Signed deliveries** — `/_spellguard/receive` accepts only deliveries this agent's Verifier signed (report-only against a Verifier that doesn't advertise `deliveryAuth: v1`)
- **Bypass alerts** — each refused or unverified delivery is reported to management (at most once per outcome and reason every five minutes), which alerts the organization's owners and admins on the dashboard

## Key Differences from TypeScript

| TypeScript | Python |
|-----------|--------|
| Hono middleware | FastAPI app via `spellguard.app()` |
| Vercel AI SDK `generateText` | `generate_text()` with OpenAI SDK |
| `createOpenRouter(...)` | `AsyncOpenAI(base_url="https://openrouter.ai/api/v1")` |
| `env` bindings (Cloudflare Workers) | `os.environ` / lambda config |
| `spellguard.getModel()` | `spellguard.model` property |

## Advanced Usage

The lower-level `configure()`, `discover_and_configure()`, and `resolve_agent_card()` functions are exported from `spellguard_client` for advanced use cases.

## License

MIT
