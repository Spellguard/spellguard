# SPDX-License-Identifier: Apache-2.0

"""Agent PC - Care Coordinator agent using CrewAI.

Uses CrewAI to orchestrate multi-step tasks. Agent routing follows the same
automatic pattern as all other Spellguard adapters: intent detection and Verifier
routing happen *before* the crew kicks off, and agent responses are injected
into the task context. The SpellguardRouteTool is still available for ad-hoc
routing during crew execution.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import uvicorn
from crewai import Agent, Crew, LLM, Process, Task
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from spellguard_client.spellguard import create_spellguard
from spellguard_crewai import SpellguardRouteTool, pre_route


# ---------------------------------------------------------------------------
# CrewAI setup
# ---------------------------------------------------------------------------

spellguard_tool = SpellguardRouteTool()


def _get_llm() -> LLM:
    """Create a CrewAI LLM pointing at OpenRouter (OpenAI-compatible API)."""
    return LLM(
        model=os.environ.get("PRIMARY_MODEL", "openai/gpt-5.4-mini"),
        api_key=os.environ.get("OPENROUTER_API_KEY", ""),
        base_url="https://openrouter.ai/api/v1",
    )


def _get_coordinator() -> Agent:
    """Create a fresh CrewAI coordinator agent."""
    return Agent(
        role="Care Coordinator",
        goal=(
            "Coordinate patient care by gathering data from specialist agents "
            "and synthesizing comprehensive care summaries."
        ),
        backstory=(
            "You are a care coordinator responsible for creating comprehensive "
            "care plans. You work with Agent PA (patient records specialist) and "
            "Agent PB (data analysis specialist) to gather all relevant patient "
            "information and create actionable care summaries."
        ),
        tools=[spellguard_tool],
        llm=_get_llm(),
        verbose=True,
    )


def build_crew(query: str, agent_context: str = "") -> Crew:
    """Build a CrewAI Crew for the given query.

    If *agent_context* is provided (from automatic pre-routing), it is
    injected into the gather task so the crew has the data upfront —
    matching the transparent routing pattern used by all other Spellguard
    adapters.  When no context is provided the crew answers from its own
    knowledge without contacting other agents.
    """
    coordinator = _get_coordinator()

    if agent_context:
        gather_desc = (
            f"Based on this query: '{query}'\n\n"
            "The following data has already been collected from other "
            "Spellguard agents:\n\n"
            f"{agent_context}\n\n"
            "Use this data to inform your response. You may also use the "
            "spellguard_route tool to contact additional agents if needed."
        )
    else:
        gather_desc = (
            f"Based on this query: '{query}'\n\n"
            "Gather relevant information to address this query. "
            "If the query explicitly references another agent by name, "
            "use the spellguard_route tool to contact them. Otherwise, "
            "answer using your own expertise as a care coordinator."
        )

    gather_task = Task(
        description=gather_desc,
        expected_output="Information gathered to address the query.",
        agent=coordinator,
    )

    synthesize_task = Task(
        description=(
            "Using the data gathered in the previous step, create a comprehensive "
            "care summary that addresses the original query. Include key findings, "
            "relevant statistics, and actionable recommendations."
        ),
        expected_output="A comprehensive care summary with findings and recommendations.",
        agent=coordinator,
    )

    return Crew(
        agents=[coordinator],
        tasks=[gather_task, synthesize_task],
        process=Process.sequential,
        verbose=True,
    )


# ---------------------------------------------------------------------------
# on_message -- called when another agent sends us a bilateral message
# ---------------------------------------------------------------------------


async def on_message(ctx: Any) -> dict[str, Any]:
    """Handle incoming bilateral/unilateral messages from Verifier."""
    print(f"[Agent PC] Received from {ctx.sender_id}: {ctx.message}")

    msg = ctx.message
    prompt = msg.get("prompt", json.dumps(msg)) if isinstance(msg, dict) else str(msg)

    agent_context = await pre_route(prompt)
    crew = build_crew(prompt, agent_context)
    result = await asyncio.to_thread(crew.kickoff)

    return {"response": str(result)}


# ---------------------------------------------------------------------------
# Spellguard setup
# ---------------------------------------------------------------------------

_spellguard = create_spellguard(
    agent_card={
        "name": "agent-pc",
        "description": "Care coordinator agent that orchestrates multi-step tasks using CrewAI",
        "url": "",
        "version": "1.0.0",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "skills": [
            {
                "id": "care-coordination",
                "name": "Care Coordination",
                "description": "Coordinates patient care across multiple specialist agents",
            },
            {
                "id": "care-summary",
                "name": "Care Summary",
                "description": "Creates comprehensive care summaries from multiple data sources",
            },
        ],
    },
    config=lambda: (
        {
            "type": "managed",
            "agent_id": os.environ.get("AGENT_ID", "agent-pc"),
            "agent_secret": os.environ.get("SPELLGUARD_AGENT_SECRET", ""),
            "management_url": os.environ.get("MANAGEMENT_URL", ""),
            "self_url": os.environ.get(
                "SELF_URL", f"http://localhost:{os.environ.get('PORT', '8803')}"
            ),
            "code_hash": os.environ.get("CODE_HASH", "dev-hash"),
        }
        if os.environ.get("MANAGEMENT_URL")
        and os.environ.get("SPELLGUARD_AGENT_SECRET")
        else {
            "type": "direct",
            "agent_id": os.environ.get("AGENT_ID", "agent-pc"),
            "verifier_url": os.environ.get("VERIFIER_URL", "http://localhost:3000"),
            "self_url": os.environ.get(
                "SELF_URL", f"http://localhost:{os.environ.get('PORT', '8803')}"
            ),
            "code_hash": os.environ.get("CODE_HASH", "dev-hash"),
            "expected_verifier_image_hash": os.environ.get(
                "EXPECTED_VERIFIER_IMAGE_HASH", "sha384:dev-placeholder"
            ),
        }
    ),
    on_message=on_message,
)


# ---------------------------------------------------------------------------
# FastAPI app -- Spellguard routes included automatically
# ---------------------------------------------------------------------------

app = _spellguard.app()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "agent": "agent-pc"}


@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()
    message: str = body.get("message", "")

    if not message:
        return JSONResponse({"error": "Message is required"}, status_code=400)

    print(f'[Agent PC] Processing: "{message[:100]}..."')

    try:
        agent_context = await pre_route(message)
        crew = build_crew(message, agent_context)
        result = await asyncio.to_thread(crew.kickoff)
        return JSONResponse({"response": str(result), "agent": "agent-pc"})
    except Exception as exc:
        print(f"[Agent PC] Error: {exc}")
        return JSONResponse(
            {"error": "Failed to process request", "details": str(exc)},
            status_code=500,
        )


def main() -> None:
    port = int(os.environ.get("PORT", "8803"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
