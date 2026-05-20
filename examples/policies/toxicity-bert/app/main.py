# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field
from transformers import pipeline


DEFAULT_MODEL_ID = "unitary/toxic-bert"
DEFAULT_THRESHOLD = 0.6
DEFAULT_SECONDARY_THRESHOLD = 0.05
DEFAULT_MAX_CONTENT_CHARS = 4000
PRIMARY_TOXIC_LABEL_HINTS = {
    "toxic",
    "toxicity",
}
ACTIONABLE_TOXIC_LABEL_HINTS = {
    "severe_toxic",
    "threat",
    "insult",
    "identity_hate",
    "hate",
    "harassment",
    "abusive",
}
BENIGN_LABEL_HINTS = {
    "not_toxic",
    "non_toxic",
    "safe",
    "neutral",
    "benign",
    "clean",
}

app = FastAPI(title="spellguard-toxicity-bert")


class PolicyRequest(BaseModel):
    content: str
    policyId: str | None = None
    policySlug: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)


class Detection(BaseModel):
    type: str
    confidence: float
    message: str | None = None


def _normalize_label(label: str) -> str:
    return label.strip().lower().replace("-", "_").replace(" ", "_")


def _is_benign_label(label: str) -> bool:
    normalized = _normalize_label(label)
    return normalized in BENIGN_LABEL_HINTS or normalized.startswith("not_")


def _is_toxic_label(label: str) -> bool:
    normalized = _normalize_label(label)
    if (
        normalized in PRIMARY_TOXIC_LABEL_HINTS
        or normalized in ACTIONABLE_TOXIC_LABEL_HINTS
    ):
        return True
    return "toxic" in normalized and not _is_benign_label(label)


def _is_actionable_toxic_label(label: str) -> bool:
    normalized = _normalize_label(label)
    return normalized in ACTIONABLE_TOXIC_LABEL_HINTS


@lru_cache(maxsize=1)
def get_runtime():
    model_id = os.getenv("MODEL_ID", DEFAULT_MODEL_ID)
    classifier = pipeline(
        "text-classification",
        model=model_id,
        tokenizer=model_id,
        device=-1,
    )
    return {
        "model_id": model_id,
        "classifier": classifier,
    }


def _extract_scores(raw_result: Any) -> list[dict[str, Any]]:
    if isinstance(raw_result, list) and raw_result and isinstance(raw_result[0], list):
        return raw_result[0]
    if isinstance(raw_result, list):
        return raw_result
    return []


def _semantic_threshold(config: dict[str, Any]) -> float:
    value = config.get("semanticThreshold", os.getenv("TOXICITY_THRESHOLD"))
    try:
        return float(value) if value is not None else DEFAULT_THRESHOLD
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD


def _semantic_secondary_threshold(config: dict[str, Any]) -> float:
    value = config.get(
        "semanticSecondaryThreshold",
        os.getenv("TOXICITY_SECONDARY_THRESHOLD"),
    )
    try:
        return float(value) if value is not None else DEFAULT_SECONDARY_THRESHOLD
    except (TypeError, ValueError):
        return DEFAULT_SECONDARY_THRESHOLD


def _max_content_chars() -> int:
    value = os.getenv("MAX_CONTENT_CHARS")
    try:
        return int(value) if value is not None else DEFAULT_MAX_CONTENT_CHARS
    except (TypeError, ValueError):
        return DEFAULT_MAX_CONTENT_CHARS


@app.on_event("startup")
def warm_model() -> None:
    get_runtime()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _evaluate_classifier_backend(
    content: str,
    threshold: float,
    secondary_threshold: float,
) -> list[Detection]:
    runtime = get_runtime()
    classifier = runtime["classifier"]
    raw_result = classifier(content, truncation=True, top_k=None)
    scores = _extract_scores(raw_result)

    best_toxic: dict[str, Any] | None = None
    best_actionable: dict[str, Any] | None = None
    for score in scores:
        label = str(score.get("label", ""))
        confidence = float(score.get("score", 0.0))
        if _is_benign_label(label):
            continue
        if _is_toxic_label(label):
            if best_toxic is None or confidence > float(
                best_toxic.get("score", 0.0)
            ):
                best_toxic = score
        if _is_actionable_toxic_label(label):
            if best_actionable is None or confidence > float(
                best_actionable.get("score", 0.0)
            ):
                best_actionable = score

    if not best_toxic:
        return []

    toxic_confidence = float(best_toxic.get("score", 0.0))
    if toxic_confidence < threshold:
        return []

    if best_actionable is None:
        return []

    confidence = float(best_actionable.get("score", 0.0))
    if confidence < secondary_threshold:
        return []
    label = str(best_actionable.get("label", "toxic"))

    return [
        Detection(
            type="toxicity:semantic",
            confidence=confidence,
            message=f'Semantic toxicity classifier matched "{label}"',
        )
    ]


@app.post("/evaluate", response_model=list[Detection])
def evaluate(request: PolicyRequest) -> list[Detection]:
    threshold = _semantic_threshold(request.config)
    secondary_threshold = _semantic_secondary_threshold(request.config)
    content = request.content[: _max_content_chars()]
    return _evaluate_classifier_backend(content, threshold, secondary_threshold)
