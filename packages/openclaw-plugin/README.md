# @spellguard/openclaw-plugin

OpenClaw plugin for Spellguard — registers Spellguard tools via OpenClaw's plugin API for agent discovery and Verifier-routed communication.

## Overview

This plugin integrates Spellguard with [OpenClaw](https://github.com/openclaw-ai/openclaw) by exposing three tools that an LLM agent can invoke autonomously:

| Tool | Description |
|------|-------------|
| `spellguard_route` | Auto-detect agent references in a prompt, discover agents, and route through Verifier |
| `spellguard_status` | Check Spellguard connection status and configuration |
| `spellguard_discover` | Discover a specific agent by name via A2A protocol |

## Setup

OpenClaw bots receive Spellguard credentials via a persistent agent-control
socket; you do **not** paste secrets into `openclaw.json` any longer. The
one-time ritual is:

### 1. Install the plugin

```bash
pnpm run install:openclaw
```

That runs the bundled build, `pnpm pack`s the result, and installs the
tarball into openclaw. The plugin ships as a single self-contained
`dist/index.js` so openclaw doesn't try to resolve workspace symlinks
or fetch `@spellguard/*` from npm.

### 2. Run the credential setup CLI

`npm install -g @spellguard/openclaw-plugin` puts `openclaw-spellguard-setup`
on PATH (the plugin is self-contained — it ships both the gateway extension and
the claim CLI, built on `@spellguard/agent-control`):

```bash
openclaw-spellguard-setup --base-url https://console.example.com
```

In the managed-provisioning flow the cloud-init / Railway bootstrap runs this
same CLI automatically with `SPELLGUARD_BOOTSTRAP_NONCE` set, which dispatches
it into managed-bootstrap mode (no browser step). Interactively, the CLI
prints a `/setup?bootstrap=…` URL. Open it in a browser, sign in,
fill the agent-name form, and approve the GitHub authorization. The CLI
captures the resulting credential and writes it to:

```
~/.config/spellguard-openclaw/credentials.json   (POSIX 0600)
```

Override the directory with `OPENCLAW_SPELLGUARD_CONFIG_DIR=/some/path`
(useful for Coolify-managed deployments where the home directory is
ephemeral but a persistent volume is mounted elsewhere).

### 3. Configure the plugin

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
          "managementUrl": "https://console.example.com"
        }
      }
    }
  }
}
```

Note: `agentSecret` is **no longer required**. If your existing config still
contains one, it will be ignored (and the plugin emits a deprecation log
line — see "Legacy config flow" below).

### 4. Configure the gateway

```bash
openclaw config set gateway.mode local
openclaw config set gateway.port 4000
openclaw config set gateway.auth.token "$(openssl rand -hex 32)"
```

### 5. Start and stop

```bash
pnpm run dev:openclaw       # Start the gateway
pnpm run dev:openclaw:stop  # Stop the gateway
```

Verify:
```bash
openclaw plugins call spellguard spellguard_status
```

Expect the output's `credential.source` to be `"socket"`.

### Known limitations

The plugin delivers credentials to a 0600 on-disk store, but does **not**
yet consume the credential for git or HTTP operations. The credential
socket is currently a delivery-only feature — rotation, refresh, and
revocation propagate into the store, and `getActiveGithubCredential()`
exposes the `scopedToken`, but no consumer adapter inside the plugin
reads it for an actual credential-needing action. The only consumer
today is `spellguard_status`, which deliberately omits the secret from
its payload.

Until a follow-up wires a consumer adapter, credential-using actions
must still go through whatever surface the bot uses today (typically a
manually-configured `GITHUB_TOKEN` env var or the legacy
`agentSecret`-driven REST flow). Tracking: #257.

## Legacy config flow (transition window)

For deployments that have not yet run the setup CLI, the plugin falls back
to the legacy `agentSecret`-based credential path. This path is supported
for **two minor releases** from the merge of this stream; after that
window, the legacy branch in `src/index.ts` is removed in a follow-up PR.

Operators can monitor migration via the structured log line:
```
{"event":"credential_source.legacy_only","message":"..."}
```

When both paths exist (legacy config still set AND new store populated),
the socket wins and an additional log line warns the operator to remove the
stale `agentSecret`:
```
{"event":"credential_source.legacy_config_active","message":"..."}
```

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
