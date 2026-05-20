# Agent PC — Care Coordinator (CrewAI)

A care coordination agent that uses [CrewAI](https://www.crewai.com/) to orchestrate multi-step tasks, pulling data from Agent PA (patient records) and Agent PB (data analysis) via the `SpellguardRouteTool` from [`spellguard-crewai`](../../crewai-py/README.md).

## Overview

| Property | Value |
|----------|-------|
| Port | 8803 |
| Framework | CrewAI + FastAPI |
| Model | `gpt-4.1-mini` via OpenRouter |
| Language | Python |

Agent PC demonstrates the CrewAI adapter pattern. It creates a CrewAI `Crew` with a coordinator agent that has access to the `spellguard_route` tool. When a query requires patient records or data analysis, the coordinator delegates to Agent PA or Agent PB through the Spellguard Verifier.

## Skills

- **Care Coordination** — Coordinates patient care across multiple specialist agents
- **Care Summary** — Creates comprehensive care summaries from multiple data sources

## Running

```bash
pnpm run dev:agent-pc
```

Or as part of the full stack: `pnpm run dev:all`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `SPELLGUARD_AGENT_SECRET` | Agent secret for management server authentication |
| `MANAGEMENT_URL` | Management server URL |
| `SELF_URL` | Agent's own URL (default: `http://localhost:8803`) |
| `AGENT_ID` | Agent identifier (default: `agent-pc`) |
| `CODE_HASH` | Agent code hash for attestation |
| `PORT` | Server port (default: `8803`) |

## Example

```bash
curl -X POST http://localhost:8803/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a care summary for Benjamin Blake including medication records and lab insights."}'
```

The coordinator gathers data from Agent PA (patient records) and Agent PB (lab analysis) via the Spellguard Verifier, then synthesizes a comprehensive care summary.

## License

MIT
