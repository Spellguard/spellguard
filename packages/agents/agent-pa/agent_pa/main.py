# SPDX-License-Identifier: Apache-2.0

"""Agent PA - Patient records management agent (Python port of agent-a).

Demonstrates the minimal Spellguard integration for a Python agent:
1. ``create_spellguard`` -- configure once, get a FastAPI app + model.
2. ``generate_text``     -- drop-in LLM call that transparently routes
                            to other Spellguard agents when the prompt
                            references them.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from openai import AsyncOpenAI

from spellguard_client.spellguard import create_spellguard
from spellguard_client.ai import generate_text, spellguard_tool


# ---------------------------------------------------------------------------
# Confidential data
# ---------------------------------------------------------------------------

_DATA_PATH = Path(__file__).resolve().parent.parent / "data.json"
with open(_DATA_PATH, "r") as _f:
    _confidential_data: dict[str, Any] = json.load(_f)


# ---------------------------------------------------------------------------
# Patient helper functions (same logic as agent-a)
# ---------------------------------------------------------------------------


def _list_patient_names() -> list[str]:
    return [p["name"] for p in _confidential_data.get("patients", [])]


def _find_patient(name_query: str) -> dict[str, Any] | None:
    query = name_query.lower()
    for p in _confidential_data.get("patients", []):
        name_lower = p["name"].lower()
        if query in name_lower or name_lower.startswith(query[0]):
            return p
    return None


def _get_patient_visit_count(name_query: str) -> dict[str, Any]:
    patient = _find_patient(name_query)
    if not patient:
        return {"found": False, "error": f"Patient matching '{name_query}' not found"}
    return {"found": True, "patientName": patient["name"], "visitCount": len(patient["visits"])}


def _get_patient_medications(name_query: str) -> dict[str, Any]:
    patient = _find_patient(name_query)
    if not patient:
        return {"found": False, "error": f"Patient matching '{name_query}' not found"}
    meds = patient.get("medications", [])
    return {
        "found": True,
        "patientName": patient["name"],
        "medications": meds if meds else ["No medications on record"],
        "medicationCount": len(meds),
    }


def _get_patient_statistics() -> dict[str, Any]:
    patients = _confidential_data.get("patients", [])
    total_visits = sum(len(p["visits"]) for p in patients)
    return {
        "totalPatients": len(patients),
        "totalVisits": total_visits,
        "averageVisitsPerPatient": total_visits / len(patients) if patients else 0,
        "patientsWithConditions": sum(1 for p in patients if p.get("conditions")),
        "patientsOnMedications": sum(1 for p in patients if p.get("medications")),
    }


def _get_patient_visit_details(name_query: str) -> dict[str, Any]:
    patient = _find_patient(name_query)
    if not patient:
        return {"found": False, "error": f"Patient matching '{name_query}' not found"}
    visits = patient["visits"]
    dates = sorted(v["date"] for v in visits)
    return {
        "found": True,
        "patientName": patient["name"],
        "visitCount": len(visits),
        "visitReasons": list({v["reason"] for v in visits}),
        "doctors": list({v["doctor"] for v in visits}),
        "dateRange": {"earliest": dates[0], "latest": dates[-1]} if dates else None,
    }


def _get_patient_conditions(name_query: str) -> dict[str, Any]:
    patient = _find_patient(name_query)
    if not patient:
        return {"found": False, "error": f"Patient matching '{name_query}' not found"}
    conditions = patient.get("conditions", [])
    return {
        "found": True,
        "patientName": patient["name"],
        "conditions": conditions if conditions else ["No conditions on record"],
        "conditionCount": len(conditions),
    }


# ---------------------------------------------------------------------------
# Tool dispatch table — each tool is wrapped with spellguard_tool for
# policy enforcement, matching the TypeScript agent-a pattern.
# ---------------------------------------------------------------------------


@spellguard_tool(name="listPatients")
async def _tool_list_patients(_args: Any) -> Any:
    return {
        "patientNames": _list_patient_names(),
        "message": f"Found {len(_list_patient_names())} patients: {', '.join(_list_patient_names())}",
    }


@spellguard_tool(name="getPatientVisitCount")
async def _tool_get_patient_visit_count(args: Any) -> Any:
    return _get_patient_visit_count(args["patient_name"])


@spellguard_tool(name="getPatientVisitDetails")
async def _tool_get_patient_visit_details(args: Any) -> Any:
    return _get_patient_visit_details(args["patient_name"])


@spellguard_tool(name="getPatientStatistics")
async def _tool_get_patient_statistics(_args: Any) -> Any:
    return _get_patient_statistics()


@spellguard_tool(name="getPatientMedications")
async def _tool_get_patient_medications(args: Any) -> Any:
    return _get_patient_medications(args["patient_name"])


@spellguard_tool(name="getPatientConditions")
async def _tool_get_patient_conditions(args: Any) -> Any:
    return _get_patient_conditions(args["patient_name"])


TOOL_DISPATCH: dict[str, Any] = {
    "listPatients": _tool_list_patients,
    "getPatientVisitCount": _tool_get_patient_visit_count,
    "getPatientVisitDetails": _tool_get_patient_visit_details,
    "getPatientStatistics": _tool_get_patient_statistics,
    "getPatientMedications": _tool_get_patient_medications,
    "getPatientConditions": _tool_get_patient_conditions,
}


# ---------------------------------------------------------------------------
# OpenAI tool definitions
# ---------------------------------------------------------------------------

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {"type": "function", "function": {"name": "listPatients", "description": "List all patient names in the system. Does not expose detailed records.", "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {"name": "getPatientVisitCount", "description": "Get the number of doctor visits for a specific patient.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "The patient name or first letter to search for"}}, "required": ["patient_name"]}}},
    {"type": "function", "function": {"name": "getPatientVisitDetails", "description": "Get detailed visit information for a patient including visit reasons, doctors seen, and date range.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "The patient name or first letter to search for"}}, "required": ["patient_name"]}}},
    {"type": "function", "function": {"name": "getPatientStatistics", "description": "Get aggregate statistics about all patients (total patients, total visits, averages).", "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {"name": "getPatientMedications", "description": "Get the list of medications a specific patient is taking.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "The patient name or first letter to search for"}}, "required": ["patient_name"]}}},
    {"type": "function", "function": {"name": "getPatientConditions", "description": "Get the list of conditions for a specific patient.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "The patient name or first letter to search for"}}, "required": ["patient_name"]}}},
]


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are Agent PA, a patient records management specialist.

You have access to confidential patient medical records through your tools. IMPORTANT RULES:
1. You CAN provide patient names and visit counts
2. You CAN provide visit reasons, doctors seen, and date ranges
3. You CAN provide conditions and general statistics
4. Be helpful in analyzing patient visit patterns and healthcare utilization
5. If you need additional data that might be held by another agent (like Agent B), you can request it

Available tools:
- listPatients: See all patient names
- getPatientVisitCount: Get number of visits for a patient
- getPatientVisitDetails: Get visit reasons, doctors, and date ranges
- getPatientStatistics: Get aggregate stats across all patients
- getPatientMedications: Get medications for a specific patient
- getPatientConditions: Get conditions for a specific patient

When working with other agents, coordinate to provide comprehensive patient analysis.
External agents are contacted automatically via unilateral attestation.
All your data access is logged through Spellguard for audit purposes."""


# ---------------------------------------------------------------------------
# on_message -- called when another agent sends us a bilateral message
# ---------------------------------------------------------------------------


async def on_message(ctx) -> dict[str, Any]:
    """Handle incoming bilateral/unilateral messages from the Verifier."""
    print(f"[Agent PA] Received from {ctx.sender_id}: {ctx.message}")

    msg = ctx.message
    prompt = msg.get("prompt", json.dumps(msg)) if isinstance(msg, dict) else str(msg)

    system = (
        f"{SYSTEM_PROMPT}\n\n"
        f"This request came from another agent ({ctx.sender_id}) via Spellguard Verifier.\n"
        "IMPORTANT: Extract the patient name from the request and use it with the appropriate tool.\n"
        'For example, if asked about "Benjamin Blake\'s medications", '
        'call getPatientMedications with patient_name="Benjamin Blake".\n'
        "Always provide the patient_name parameter when calling patient-specific tools."
    )

    result = await generate_text(
        model=ctx.model,
        model_name=os.environ.get("PRIMARY_MODEL", "google/gemini-3.1-flash-lite-preview"),
        system=system,
        prompt=prompt,
        tools=TOOL_DEFINITIONS,
        tool_dispatch=TOOL_DISPATCH,
        max_steps=5,
    )
    return {"response": result.text}


# ---------------------------------------------------------------------------
# Spellguard setup  (the only Spellguard-specific code the agent needs)
# ---------------------------------------------------------------------------

spellguard = create_spellguard(
    agent_card={
        "name": "agent-pa",
        "description": "Patient records management agent",
        "url": "",
        "version": "1.0.0",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "skills": [
            {"id": "patient-records", "name": "Patient Records", "description": "Access and analyze patient visit records and conditions"},
            {"id": "coordinate", "name": "Coordinate", "description": "Coordinate with other agents to complete tasks"},
        ],
    },
    config=lambda: (
        {
            "type": "managed",
            "agent_id": os.environ.get("AGENT_ID", "agent-pa"),
            "agent_secret": os.environ.get("SPELLGUARD_AGENT_SECRET", ""),
            "management_url": os.environ.get("MANAGEMENT_URL", ""),
            "self_url": os.environ.get("SELF_URL", f"http://localhost:{os.environ.get('PORT', '8801')}"),
            "code_hash": os.environ.get("CODE_HASH", "dev-hash"),
        }
        if os.environ.get("MANAGEMENT_URL") and os.environ.get("SPELLGUARD_AGENT_SECRET")
        else {
            "type": "direct",
            "agent_id": os.environ.get("AGENT_ID", "agent-pa"),
            "verifier_url": os.environ.get("VERIFIER_URL", "http://localhost:3000"),
            "self_url": os.environ.get("SELF_URL", f"http://localhost:{os.environ.get('PORT', '8801')}"),
            "code_hash": os.environ.get("CODE_HASH", "dev-hash"),
            "expected_verifier_image_hash": os.environ.get("EXPECTED_VERIFIER_IMAGE_HASH", "sha384:dev-placeholder"),
        }
    ),
    model=lambda: AsyncOpenAI(
        api_key=os.environ.get("OPENROUTER_API_KEY", ""),
        base_url="https://openrouter.ai/api/v1",
    ),
    on_message=on_message,
)


# ---------------------------------------------------------------------------
# FastAPI app -- Spellguard routes are included automatically
# ---------------------------------------------------------------------------

app = spellguard.app()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "agent": "agent-pa"}


@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()
    message: str = body.get("message", "")

    if not message:
        return JSONResponse({"error": "Message is required"}, status_code=400)

    print(f'[Agent PA] Processing: "{message[:100]}..."')

    try:
        result = await generate_text(
            model=spellguard.model,
            model_name=os.environ.get("PRIMARY_MODEL", "google/gemini-3.1-flash-lite-preview"),
            system=SYSTEM_PROMPT,
            prompt=message,
            tools=TOOL_DEFINITIONS,
            tool_dispatch=TOOL_DISPATCH,
            max_steps=5,
        )
        return JSONResponse({"response": result.text, "agent": "agent-pa"})
    except Exception as exc:
        print(f"[Agent PA] Error: {exc}")
        return JSONResponse(
            {"error": "Failed to process request", "details": str(exc)},
            status_code=500,
        )


def main() -> None:
    port = int(os.environ.get("PORT", "8801"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
