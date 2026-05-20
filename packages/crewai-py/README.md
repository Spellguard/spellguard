# spellguard-crewai

CrewAI integration for Spellguard — a `BaseTool` adapter that routes prompts through the Spellguard Verifier, enabling CrewAI agents to participate in the Spellguard agent network.

Follows the same adapter pattern as the TS [`@spellguard/langchain`](../langchain/README.md) and [`@spellguard/openai`](../openai/README.md) integrations: wraps `resolve_and_collect_agent_responses()` + `build_agent_context_block()` from `spellguard-client` with minimal framework-specific glue.

## Installation

```bash
pip install spellguard-crewai
# or as an editable install from the monorepo
pip install -e packages/crewai-py
```

## Usage

```python
from crewai import Agent, Crew, LLM, Task
from spellguard_crewai import SpellguardRouteTool

spellguard_tool = SpellguardRouteTool()

agent = Agent(
    role="Care Coordinator",
    goal="Coordinate patient care across specialist agents.",
    backstory="You work with Agent PA and Agent PB to gather data.",
    tools=[spellguard_tool],
    llm=LLM(model="openai/gpt-4.1-mini", base_url="https://openrouter.ai/api/v1"),
)

task = Task(
    description="Ask Agent PA for patient records for Benjamin Blake.",
    expected_output="Patient record summary.",
    agent=agent,
)

crew = Crew(agents=[agent], tasks=[task])
result = crew.kickoff()
```

## How It Works

`SpellguardRouteTool` is a CrewAI `BaseTool` named `spellguard_route`:

1. Receives a prompt containing agent references (e.g., "ask Agent PA for patient records")
2. Calls `resolve_and_collect_agent_responses()` to detect agent references, discover agents via A2A, and route through the Spellguard Verifier
3. Formats the collected responses via `build_agent_context_block()`
4. Returns the context block to the CrewAI agent for synthesis

Prompts with no recognized agent references return a "no agents found" message.

**Prerequisite:** Spellguard must be initialized before the first call (e.g., via `create_spellguard` in the same process). The tool relies on the client middleware for Verifier configuration.

## Sync and Async

The tool supports both sync and async execution. When called synchronously inside an already-running event loop (e.g., FastAPI), it delegates to a thread pool to avoid blocking. The hop-count context variable is automatically propagated across thread boundaries via `contextvars.copy_context()`, ensuring the Verifier's loop-prevention mechanism works correctly even when CrewAI runs synchronously in a worker thread.

## License

MIT
