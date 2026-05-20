# SPDX-License-Identifier: Apache-2.0

"""Agent PB - Data analysis and patient records agent (Python port of agent-b).

Same Spellguard integration pattern as agent-pa: ``create_spellguard`` +
``generate_text`` -- no Spellguard internals leak into agent code.
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
# Patient helper functions
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


def _get_patient_lab_insights(name_query: str) -> dict[str, Any]:
    patient = _find_patient(name_query)
    if not patient:
        return {"found": False, "error": f"Patient matching '{name_query}' not found"}

    labs = patient.get("labResults", {})
    cholesterol = labs.get("cholesterol", 0)
    glucose = labs.get("glucose", 0)

    chol_status = "Normal" if cholesterol < 200 else ("Borderline" if cholesterol < 240 else "High")
    gluc_status = "Normal" if glucose < 100 else ("Pre-diabetic" if glucose < 126 else "Diabetic")

    return {
        "found": True,
        "patientName": patient["name"],
        "labMetrics": list(labs.keys()),
        "healthIndicators": {"cholesterolStatus": chol_status, "glucoseStatus": gluc_status},
    }


# ---------------------------------------------------------------------------
# Generic data analysis helpers
# ---------------------------------------------------------------------------


def _compute_stats(numbers: list[float | int]) -> dict[str, Any]:
    sorted_nums = sorted(numbers)
    total = sum(numbers)
    count = len(numbers)
    mid = count // 2
    median = (sorted_nums[mid - 1] + sorted_nums[mid]) / 2 if count % 2 == 0 else sorted_nums[mid]
    return {"count": count, "min": min(numbers), "max": max(numbers), "average": total / count, "sum": total, "median": median}


def _analyze_numeric_data(key: str) -> dict[str, Any]:
    data = _confidential_data.get(key)
    if data is None:
        return {"available": False, "error": f"Key '{key}' not found"}
    if isinstance(data, list) and all(isinstance(v, (int, float)) for v in data):
        return {"available": True, "type": "numeric_array", "stats": _compute_stats(data)}
    if isinstance(data, dict):
        values = list(data.values())
        if all(isinstance(v, (int, float)) for v in values):
            return {"available": True, "type": "numeric_object", "stats": _compute_stats(values)}
    return {"available": True, "type": "array" if isinstance(data, list) else type(data).__name__, "error": "Data is not numeric, cannot compute statistics"}


def _get_data_metadata(key: str) -> dict[str, Any]:
    data = _confidential_data.get(key)
    if data is None:
        return {"exists": False}
    if isinstance(data, list):
        return {"exists": True, "type": "array", "itemCount": len(data)}
    if isinstance(data, dict):
        return {"exists": True, "type": "object", "itemCount": len(data), "keys": list(data.keys())}
    return {"exists": True, "type": type(data).__name__}


def _compare_data_sets(first_key: str, second_key: str) -> dict[str, Any]:
    a1, a2 = _analyze_numeric_data(first_key), _analyze_numeric_data(second_key)
    if not a1.get("stats") or not a2.get("stats"):
        return {"success": False, "error": "Both keys must contain numeric data", "details": {first_key: a1, second_key: a2}}
    return {
        "success": True,
        "comparison": {
            first_key: a1["stats"], second_key: a2["stats"],
            "insights": {
                "averageDifference": a1["stats"]["average"] - a2["stats"]["average"],
                "sumRatio": a1["stats"]["sum"] / a2["stats"]["sum"],
                "countDifference": a1["stats"]["count"] - a2["stats"]["count"],
            },
        },
    }


# ---------------------------------------------------------------------------
# Tool dispatch table
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Tool dispatch — each tool wrapped with spellguard_tool for policy
# enforcement, matching the TypeScript agent-b pattern.
# ---------------------------------------------------------------------------


@spellguard_tool(name="listAvailableData")
async def _tool_list_available_data(_args: Any) -> Any:
    return {"availableKeys": list(_confidential_data.keys()), "message": f"Found {len(_confidential_data)} data sets"}


@spellguard_tool(name="getDataInfo")
async def _tool_get_data_info(args: Any) -> Any:
    return _get_data_metadata(args["dataKey"])


@spellguard_tool(name="analyzeData")
async def _tool_analyze_data(args: Any) -> Any:
    return _analyze_numeric_data(args["dataKey"])


@spellguard_tool(name="compareDataSets")
async def _tool_compare_data_sets(args: Any) -> Any:
    return _compare_data_sets(args["firstDataKey"], args["secondDataKey"])


@spellguard_tool(name="listPatients")
async def _tool_list_patients(_args: Any) -> Any:
    return {"patientNames": _list_patient_names(), "message": f"Found {len(_list_patient_names())} patients"}


@spellguard_tool(name="getPatientVisitCount")
async def _tool_get_patient_visit_count(args: Any) -> Any:
    return _get_patient_visit_count(args["patient_name"])


@spellguard_tool(name="getPatientVisitDetails")
async def _tool_get_patient_visit_details(args: Any) -> Any:
    return _get_patient_visit_details(args["patient_name"])


@spellguard_tool(name="getPatientLabInsights")
async def _tool_get_patient_lab_insights(args: Any) -> Any:
    return _get_patient_lab_insights(args["patient_name"])


@spellguard_tool(name="getPatientInsurance")
async def _tool_get_patient_insurance(args: Any) -> Any:
    p = _find_patient(args["patient_name"])
    if not p:
        return {"found": False, "error": f"Patient matching '{args['patient_name']}' not found"}
    return {"found": True, "patientName": p["name"], "insuranceProvider": p["insuranceProvider"]}


TOOL_DISPATCH: dict[str, Any] = {
    "listAvailableData": _tool_list_available_data,
    "getDataInfo": _tool_get_data_info,
    "analyzeData": _tool_analyze_data,
    "compareDataSets": _tool_compare_data_sets,
    "listPatients": _tool_list_patients,
    "getPatientVisitCount": _tool_get_patient_visit_count,
    "getPatientVisitDetails": _tool_get_patient_visit_details,
    "getPatientLabInsights": _tool_get_patient_lab_insights,
    "getPatientInsurance": _tool_get_patient_insurance,
}


# ---------------------------------------------------------------------------
# OpenAI tool definitions
# ---------------------------------------------------------------------------

TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {"type": "function", "function": {"name": "listAvailableData", "description": "List all available confidential data keys. Does not expose any values.", "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {"name": "getDataInfo", "description": "Get metadata about a specific data key (type, count) without exposing values.", "parameters": {"type": "object", "properties": {"dataKey": {"type": "string", "description": "The data key to get information about"}}, "required": ["dataKey"]}}},
    {"type": "function", "function": {"name": "analyzeData", "description": "Compute aggregate statistics (min, max, average, sum, median) for numeric data. REQUIRES a dataKey parameter.", "parameters": {"type": "object", "properties": {"dataKey": {"type": "string", "description": "The data key to analyze (e.g. employee_salaries). Use listAvailableData first."}}, "required": ["dataKey"]}}},
    {"type": "function", "function": {"name": "compareDataSets", "description": "Compare statistics between two numeric data sets.", "parameters": {"type": "object", "properties": {"firstDataKey": {"type": "string", "description": "First data key"}, "secondDataKey": {"type": "string", "description": "Second data key"}}, "required": ["firstDataKey", "secondDataKey"]}}},
    {"type": "function", "function": {"name": "listPatients", "description": "List all patient names.", "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {"name": "getPatientVisitCount", "description": "Get the number of doctor visits for a patient.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "Patient name or first letter"}}, "required": ["patient_name"]}}},
    {"type": "function", "function": {"name": "getPatientVisitDetails", "description": "Get visit information including reasons, doctors, and date range.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "Patient name or first letter"}}, "required": ["patient_name"]}}},
    {"type": "function", "function": {"name": "getPatientLabInsights", "description": "Get lab result health indicators without exposing raw values.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "Patient name or first letter"}}, "required": ["patient_name"]}}},
    {"type": "function", "function": {"name": "getPatientInsurance", "description": "Get the insurance provider for a patient.", "parameters": {"type": "object", "properties": {"patient_name": {"type": "string", "description": "Patient name or first letter"}}, "required": ["patient_name"]}}},
]


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are Agent PB, a confidential data analysis specialist.

You have access to sensitive internal data and patient records through your tools. IMPORTANT RULES:
1. NEVER disclose raw values from the confidential data (especially lab results)
2. You CAN provide aggregate statistics (averages, sums, counts, min/max, medians)
3. You CAN describe trends and patterns in general terms
4. You CAN compare data sets using statistical measures
5. You CAN provide health status indicators (Normal/Borderline/High) for patient lab results
6. If asked for specific raw values, politely explain that you can only provide aggregated insights

DATA BOUNDARIES - IMPORTANT:
- You do NOT have medication data. Medications are managed by Agent A.
- You do NOT have patient conditions. Conditions are managed by Agent A.
- If asked about medications or conditions, you MUST route the request to Agent A.

Available tools:
- listAvailableData: See what data sets are available
- getDataInfo: Get metadata (type, count) about a data set
- analyzeData: Compute statistics on numeric data
- compareDataSets: Compare two data sets statistically
- listPatients: See all patient names
- getPatientVisitCount: Get number of visits for a patient
- getPatientVisitDetails: Get visit reasons, doctors, and date ranges
- getPatientLabInsights: Get health indicators from lab results
- getPatientInsurance: Get insurance provider for a patient

All your data access is logged through Spellguard for audit purposes."""


# ---------------------------------------------------------------------------
# on_message -- called when another agent sends us a bilateral message
# ---------------------------------------------------------------------------


async def on_message(ctx) -> dict[str, Any]:
    print(f"[Agent PB] Received from {ctx.sender_id}: {ctx.message}")

    msg = ctx.message
    prompt = msg.get("prompt", json.dumps(msg)) if isinstance(msg, dict) else str(msg)

    system = (
        f"{SYSTEM_PROMPT}\n\n"
        f"This request came from another agent ({ctx.sender_id}) via Spellguard Verifier.\n"
        "Remember: provide only aggregate insights, never raw confidential values."
    )

    result = await generate_text(
        model=ctx.model,
        model_name=os.environ.get("PRIMARY_MODEL", "google/gemini-3.1-flash-lite-preview"),
        system=system,
        prompt=prompt,
        tools=TOOL_DEFINITIONS,
        tool_dispatch=TOOL_DISPATCH,
        max_steps=10,
    )
    return {"response": result.text}


# ---------------------------------------------------------------------------
# Spellguard setup
# ---------------------------------------------------------------------------

spellguard = create_spellguard(
    agent_card={
        "name": "agent-pb",
        "description": "Data analysis, patient records, and lab results agent",
        "url": "",
        "version": "1.0.0",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "skills": [
            {"id": "analyze-data", "name": "Analyze Data", "description": "Analyzes structured data and returns insights"},
            {"id": "process-array", "name": "Process Array", "description": "Processes arrays of numbers and returns statistics"},
            {"id": "patient-records", "name": "Patient Records", "description": "Access patient visit records, lab results, and insurance info"},
        ],
    },
    config=lambda: (
        {
            "type": "managed",
            "agent_id": os.environ.get("AGENT_ID", "agent-pb"),
            "agent_secret": os.environ.get("SPELLGUARD_AGENT_SECRET", ""),
            "management_url": os.environ.get("MANAGEMENT_URL", ""),
            "self_url": os.environ.get("SELF_URL", f"http://localhost:{os.environ.get('PORT', '8802')}"),
            "code_hash": os.environ.get("CODE_HASH", "dev-hash"),
        }
        if os.environ.get("MANAGEMENT_URL") and os.environ.get("SPELLGUARD_AGENT_SECRET")
        else {
            "type": "direct",
            "agent_id": os.environ.get("AGENT_ID", "agent-pb"),
            "verifier_url": os.environ.get("VERIFIER_URL", "http://localhost:3000"),
            "self_url": os.environ.get("SELF_URL", f"http://localhost:{os.environ.get('PORT', '8802')}"),
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
# FastAPI app -- Spellguard routes included automatically
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
    return {"status": "ok", "agent": "agent-pb"}


@app.post("/chat")
async def chat(request: Request) -> JSONResponse:
    body = await request.json()
    message: str = body.get("message", "")

    if not message:
        return JSONResponse({"error": "Message is required"}, status_code=400)

    print(f'[Agent PB] Processing: "{message[:100]}..."')

    try:
        result = await generate_text(
            model=spellguard.model,
            model_name=os.environ.get("PRIMARY_MODEL", "google/gemini-3.1-flash-lite-preview"),
            system=SYSTEM_PROMPT,
            prompt=message,
            tools=TOOL_DEFINITIONS,
            tool_dispatch=TOOL_DISPATCH,
            max_steps=10,
        )

        text = result.text
        # If the LLM exhausted all steps on tool calls without a final
        # synthesis, make one more call without tools to force a summary.
        if not text or len(text) < 20:
            synthesis = await generate_text(
                model=spellguard.model,
                model_name=os.environ.get("PRIMARY_MODEL", "google/gemini-3.1-flash-lite-preview"),
                system=SYSTEM_PROMPT,
                prompt=(
                    f"Based on the analysis you just performed, provide a concise "
                    f'summary answering the user\'s original question: "{message}"'
                ),
            )
            text = synthesis.text

        return JSONResponse({"response": text, "agent": "agent-pb"})
    except Exception as exc:
        print(f"[Agent PB] Error: {exc}")
        return JSONResponse(
            {"error": "Failed to process request", "details": str(exc)},
            status_code=500,
        )


@app.post("/analyze")
async def analyze(request: Request) -> JSONResponse:
    body = await request.json()
    data = body.get("data")

    if not data or not isinstance(data, list):
        return JSONResponse({"error": "Data array is required"}, status_code=400)

    stats = _compute_stats(data)
    stats["range"] = stats["max"] - stats["min"]
    return JSONResponse({"analysis": stats, "agent": "agent-pb"})


def main() -> None:
    port = int(os.environ.get("PORT", "8802"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
