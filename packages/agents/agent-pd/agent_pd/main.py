# SPDX-License-Identifier: Apache-2.0

"""Agent PD - Research assistant agent using LangChain.

Demonstrates Spellguard + LangChain integration:
1. ``create_spellguard``              -- configure once, get a FastAPI app.
2. ``create_spellguard_chat_model``   -- wrap any LangChain ``BaseChatModel``
   with transparent Verifier agent routing.

The LangChain adapter handles the *outbound* side (wrapping the chat model),
while ``create_spellguard`` handles inbound bilateral routing — matching
the same separation used by all other Spellguard adapters.
"""

from __future__ import annotations

import json
import os
from typing import Any

import uvicorn
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from langchain_openai import ChatOpenAI

from spellguard_client.spellguard import create_spellguard
from spellguard_langchain import create_spellguard_chat_model


# ---------------------------------------------------------------------------
# LangChain model setup
# ---------------------------------------------------------------------------


def _get_chat_model() -> ChatOpenAI:
    """Create a ChatOpenAI model via OpenRouter."""
    return ChatOpenAI(
        model=os.environ.get("PRIMARY_MODEL", "google/gemini-3.1-flash-lite-preview"),
        api_key=os.environ.get("OPENROUTER_API_KEY", ""),
        base_url="https://openrouter.ai/api/v1",
        max_tokens=2048,
    )


# Wrap the LangChain model with Spellguard — agent references in prompts
# are automatically detected, routed through the Verifier, and injected as
# context before the final LLM call.
_langchain_model = create_spellguard_chat_model(_get_chat_model())

SYSTEM_PROMPT = """You are Agent PD, a research assistant specializing in \
topic summarization and knowledge synthesis.

You help users by researching topics and providing clear, well-structured \
summaries. When working with other agents:
- You can summarize and synthesize information from multiple sources
- You provide clear explanations of complex topics
- You organize information into actionable insights

If another agent (such as Agent B for data analysis) is referenced, their \
response will be automatically included in your context. Use that data to \
enrich your summaries.

Keep responses focused, well-organized, and informative."""


# ---------------------------------------------------------------------------
# on_message -- called when another agent sends us a bilateral message
# ---------------------------------------------------------------------------


async def on_message(ctx: Any) -> dict[str, Any]:
    """Handle incoming bilateral/unilateral messages from the Verifier."""
    print(f"[Agent PD] Received from {ctx.sender_id}: {ctx.message}")

    msg = ctx.message
    prompt = msg.get("prompt", json.dumps(msg)) if isinstance(msg, dict) else str(msg)

    system = (
        f"{SYSTEM_PROMPT}\n\n"
        f"This request came from another agent ({ctx.sender_id}) via Spellguard Verifier.\n"
        "Provide a thorough research summary addressing their query."
    )

    from langchain_core.messages import HumanMessage, SystemMessage

    messages = [SystemMessage(content=system), HumanMessage(content=prompt)]
    result = await _langchain_model.ainvoke(messages)
    return {"response": result.content}


# ---------------------------------------------------------------------------
# Spellguard setup
# ---------------------------------------------------------------------------

_spellguard = create_spellguard(
    agent_card={
        "name": "agent-pd",
        "description": "Research assistant that summarizes topics using LangChain",
        "url": "",
        "version": "1.0.0",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "skills": [
            {
                "id": "research",
                "name": "Research",
                "description": "Research and summarize topics across domains",
            },
            {
                "id": "synthesize",
                "name": "Synthesize",
                "description": "Synthesize information from multiple sources into clear summaries",
            },
        ],
    },
    config=lambda: (
        {
            "type": "managed",
            "agent_id": os.environ.get("AGENT_ID", "agent-pd"),
            "agent_secret": os.environ.get("SPELLGUARD_AGENT_SECRET", ""),
            "management_url": os.environ.get("MANAGEMENT_URL", ""),
            "self_url": os.environ.get(
                "SELF_URL", f"http://localhost:{os.environ.get('PORT', '8804')}"
            ),
            "code_hash": os.environ.get("CODE_HASH", "dev-hash"),
        }
        if os.environ.get("MANAGEMENT_URL")
        and os.environ.get("SPELLGUARD_AGENT_SECRET")
        else {
            "type": "direct",
            "agent_id": os.environ.get("AGENT_ID", "agent-pd"),
            "verifier_url": os.environ.get("VERIFIER_URL", "http://localhost:3000"),
            "self_url": os.environ.get(
                "SELF_URL", f"http://localhost:{os.environ.get('PORT', '8804')}"
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
    return {"status": "ok", "agent": "agent-pd"}


@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()
    message: str = body.get("message", "")

    if not message:
        return JSONResponse({"error": "Message is required"}, status_code=400)

    print(f'[Agent PD] Processing: "{message[:100]}..."')

    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        messages = [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=message),
        ]
        result = await _langchain_model.ainvoke(messages)
        return JSONResponse({"response": result.content, "agent": "agent-pd"})
    except Exception as exc:
        print(f"[Agent PD] Error: {exc}")
        return JSONResponse(
            {"error": "Failed to process request", "details": str(exc)},
            status_code=500,
        )


def main() -> None:
    port = int(os.environ.get("PORT", "8804"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
