# @openclaw/spellguard

OpenClaw plugin for Spellguard — registers Spellguard tools via OpenClaw's plugin API for agent discovery and Verifier-routed communication.

## Overview

This plugin integrates Spellguard with [OpenClaw](https://github.com/openclaw-ai/openclaw) by exposing three tools that an LLM agent can invoke autonomously:

| Tool | Description |
|------|-------------|
| `spellguard_route` | Auto-detect agent references in a prompt, discover agents, and route through Verifier |
| `spellguard_status` | Check Spellguard connection status and configuration |
| `spellguard_discover` | Discover a specific agent by name via A2A protocol |

## Setup

### 1. Configure the plugin

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "spellguard": {
        "enabled": true,
        "config": {
          "verifierUrl": "http://localhost:3000",
          "selfUrl": "http://localhost:9000",
          "agentId": "openclaw-agent",
          "agentSecret": "test-secret-openclaw-agent-12345678"
        }
      }
    }
  }
}
```

### 2. Install the plugin

```bash
pnpm run install:openclaw
```

That runs the bundled build, `pnpm pack`s the result, and installs the
tarball into openclaw. The plugin ships as a single self-contained
`dist/index.js` so openclaw doesn't try to resolve workspace symlinks
or fetch `@spellguard/*` from npm.

### 3. Configure the gateway

```bash
openclaw config set gateway.mode local
openclaw config set gateway.port 4000
openclaw config set gateway.auth.token "$(openssl rand -hex 32)"
```

### 4. Start and stop

```bash
pnpm run dev:openclaw       # Start the gateway
pnpm run dev:openclaw:stop  # Stop the gateway
```

Verify: `openclaw gateway health` and `openclaw plugins list`.

## Security Hooks

When `verifierUrl` is configured, the plugin registers security hooks that evaluate
channel traffic against Spellguard policies via the Verifier server.

### Outbound Protection (`message_sending`)

Scans agent responses before delivery to Slack/Discord channels. Cancels
messages that violate policies (prompt injection, PII exfiltration, etc.).

### Inbound Blocking (`before_dispatch`)

Evaluates inbound messages against Spellguard policies via the Verifier before they
reach the LLM. When a violation is detected, the guard returns `{ handled: true }`
to suppress LLM dispatch and posts a threaded block notice with a
`:no_entry_sign:` reaction in Slack. Works on stock upstream OpenClaw in both
Socket Mode and HTTP Events mode — no fork required.

### Inbound Observation (`message_received`)

Observes all inbound channel messages and stashes the Slack message `ts`
(messageId) for the `before_dispatch` guard to use when posting threaded block
notices. This hook is observe-only — blocking is handled by `before_dispatch`.

### System Prompt Hardening (`before_prompt_build`)

When a policy violation is detected in the inbound prompt, injects a Spellguard
alert into the LLM context instructing it to ignore the flagged content.

### Tool Call Blocking (`before_tool_call`)

Scans tool call parameters for policy violations. Blocks dangerous tool
invocations with a reason message.

### Configuration

All hooks require `verifierUrl` in the plugin config:

```json
{
  "plugins": {
    "entries": {
      "spellguard": {
        "enabled": true,
        "config": {
          "verifierUrl": "http://localhost:3000",
          "agentId": "my-agent",
          "agentSecret": "sg-..."
        }
      }
    }
  }
}
```

## Testing

There are three levels of testing:

| File | What it tests | Requirements |
|------|---------------|-------------|
| `tests/openclaw-integration.test.ts` | Plugin tools via mock `OpenClawPluginApi` | Verifier + agents |
| `tests/openclaw-gateway-wiring.test.ts` | Gateway loads plugin, routes `/tools/invoke` | Verifier + agents + gateway |
| `tests/openclaw-e2e.test.ts` | LLM agent invokes Spellguard tools via chat | Verifier + agents + gateway + LLM API key |

All auto-skip when their requirements aren't met.

### Agent Chat E2E (optional)

Requires an LLM API key configured in the gateway agent:

```bash
openclaw models auth paste-token --provider openrouter
openclaw models set openrouter/anthropic/claude-sonnet-4
```

## License

MIT
