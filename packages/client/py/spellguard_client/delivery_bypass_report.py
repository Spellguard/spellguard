# SPDX-License-Identifier: Apache-2.0
#
# #1407 slice B (REM-064), Python mirror of the TS ``delivery-bypass-report.ts``:
# a bypass of the mediated path raises an alert a person sees. The Verifier
# never sees a delivery that didn't come through it, so the receiver reports
# it: each delivery ``/_spellguard/receive`` refused (or, in report-only mode,
# accepted unverified) is posted to management's
# ``POST /v1/agents/:id/delivery-bypass`` with the agent secret, and the org's
# owners and admins get a dashboard notice.
#
# Anyone who can reach the agent can POST to ``/_spellguard/receive``, so the
# reporter sends at most one report per outcome and reason every five minutes;
# management also folds repeats into one open notice. Like the usage telemetry
# it is fire-and-forget and fail-open: it never raises into, or slows, the
# receive handler.

from __future__ import annotations

import asyncio
import time
from typing import Literal
from urllib.parse import quote

import httpx

from .attestation import get_config
from .usage_telemetry import _resolve_base_url

DeliveryBypassOutcome = Literal["refused", "accepted_unverified"]

# Management's closed vocabulary (``DELIVERY_BYPASS_REASONS``): the ctls
# delivery-auth failures plus the SDK's own checks. No ``plaintext_refused``:
# a plaintext delivery refused after it passed the signature check came from
# the Verifier, so it is not a bypass (#1858).
DeliveryBypassReason = Literal[
    "missing",
    "unsupported_version",
    "unknown_key",
    "stale",
    "bad_signature",
    "replayed",
    "missing_channel_token",
    "plaintext_accepted",
]

_REPORT_INTERVAL_S = 5 * 60.0
_EMIT_TIMEOUT_S = 5.0


def _now() -> float:
    return time.monotonic()


class DeliveryBypassReporter:
    """A per-agent reporter (one per ``SpellguardInstance``)."""

    def __init__(self) -> None:
        self._last_reported: dict[tuple[str, str], float] = {}
        # Keep a reference so a pending report isn't garbage-collected.
        self._pending: set[asyncio.Task[None]] = set()

    def __call__(
        self, outcome: DeliveryBypassOutcome, reason: DeliveryBypassReason
    ) -> None:
        try:
            cfg = get_config()
            agent_id = getattr(cfg, "agent_id", None)
            agent_secret = getattr(cfg, "agent_secret", None)
            if not agent_id or not agent_secret:
                return
            base = _resolve_base_url(cfg)
            if not base:
                return
            key = (outcome, reason)
            now = _now()
            last = self._last_reported.get(key)
            if last is not None and now - last < _REPORT_INTERVAL_S:
                return
            self._last_reported[key] = now
            task = asyncio.get_running_loop().create_task(
                _send(
                    f"{base}/v1/agents/{quote(agent_id, safe='')}/delivery-bypass",
                    agent_secret,
                    {"outcome": outcome, "reason": reason},
                )
            )
            self._pending.add(task)
            task.add_done_callback(self._pending.discard)
        except Exception:
            return  # fail-open: a report must never affect the delivery's answer


async def _send(url: str, agent_secret: str, body: dict[str, str]) -> None:
    try:
        async with httpx.AsyncClient(timeout=_EMIT_TIMEOUT_S) as client:
            await client.post(
                url,
                json=body,
                headers={
                    "Authorization": f"Bearer {agent_secret}",
                    "Content-Type": "application/json",
                },
            )
    except Exception:
        return
