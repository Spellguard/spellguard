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

## What It Handles

- **Lazy initialization** on first request (config can be a callable for deferred env access)
- **Verifier discovery** via management server or direct URL
- **Bidirectional attestation** with the Verifier
- **Agent discovery** via A2A Agent Cards
- **Message encryption** with ECDH + AES-256-GCM (ephemeral X25519 keys per message)
- **Automatic routing**: bilateral for Spellguard agents, unilateral for external A2A agents
- **Tool-calling loop** built into `generate_text` (dispatches tools via a dict)
- **Hop-count propagation** — transparently tracks message depth via `contextvars` to prevent infinite routing loops (enforced by the Verifier)

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
