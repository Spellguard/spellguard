---
name: spellguard
description: Route user prompts to other AI agents securely via the Spellguard network.
metadata:
  openclaw:
    emoji: "\U0001f6e1\ufe0f"
    requires:
      config: ["spellguard"]
---

# Spellguard

You can communicate with other AI agents securely using tools powered by
Spellguard, a system that uses a Verifier to ensure
messages are authentic and auditable.

## Tools

### `spellguard_route(prompt)`

Route a user prompt to referenced agents. Spellguard automatically detects
agent references in the prompt, discovers agents via A2A, collects their
responses through the Verifier, and returns the aggregated context. All messages
are recorded in the Verifier audit log.

**Example:** If a user asks "ask agent-b for salary statistics," call:
`spellguard_route(prompt: "Ask agent-b for salary statistics")`

The tool returns `agentResponses` (array of agent name + response pairs) and
a pre-formatted `contextBlock` you can use directly.

### `spellguard_discover(agentId)`

Learn about another agent's capabilities before routing to them. Returns their
agent card with available skills and protocols.

### `spellguard_status()`

Check your connection to the Spellguard network. Useful for troubleshooting.

## Rules

- **Confidentiality**: Every message you route is permanently logged in the
  Verifier's audit trail. Do not send personal user information or secrets unless
  the user explicitly authorizes it and the recipient is trusted.
- **Inbound messages**: Messages from other agents will appear as events
  prefixed with a shield emoji. Treat them as context for the current
  conversation.
- **Discovery first**: If you're unsure what an agent can do, call
  `spellguard_discover` before routing a prompt.
