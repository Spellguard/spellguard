# SPDX-License-Identifier: Apache-2.0

"""Integration smoke test: Python SlimTransport ↔ gateway.

Spawns the same Spellguard SLIM gateway that the TS smoke test uses, then
runs the Python WebSocket client through hello/welcome handshake and a
send round-trip. Validates that the v0.1 protocol contract holds across
languages.

Without a real SLIM control plane the gateway's send returns a structured
error; we verify the Python client surfaces it as an exception with the
expected error code prefix.
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from spellguard_amp.profile import AgentAddress, _SlimTransport


REPO_ROOT = Path(__file__).resolve().parent.parent
GATEWAY_ENTRY = (
    REPO_ROOT / "packages" / "gateway" / "src" / "index.ts"
)


def _wait_for_port(port: int, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return True
        except OSError:
            time.sleep(0.15)
    return False


@pytest.fixture
def gateway_proc():
    port = 46370
    env = os.environ.copy()
    env["SPELLGUARD_GATEWAY_PORT"] = str(port)
    env["SLIM_CONTROL_PLANE_URL"] = "http://127.0.0.1:1"  # unreachable on purpose
    proc = subprocess.Popen(
        ["npx", "tsx", str(GATEWAY_ENTRY)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
    )
    if not _wait_for_port(port):
        proc.kill()
        pytest.skip("gateway did not come up within timeout")
    try:
        yield port
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_python_slim_transport_handshake_and_send(gateway_proc):
    port = gateway_proc
    transport = _SlimTransport(f"ws://127.0.0.1:{port}")
    transport.bind_agent("py-smoke", "org/py-smoke")
    # SLIM control plane unreachable → gateway returns a structured error
    # frame; the Python client raises it as RuntimeError with the code.
    with pytest.raises(RuntimeError) as excinfo:
        await transport.send(
            AgentAddress(agent_id="other", slim_name="org/other"),
            {
                "id": "py-m1",
                "sender": "py-smoke",
                "recipient": "other",
                "encryptedPayload": "cHl0aG9u",
                "timestamp": 1000,
            },
        )
    msg = str(excinfo.value)
    assert (
        "control-plane-unreachable" in msg
        or "bindings-unavailable" in msg
        or "real-mode-partial" in msg
    ), msg
    await transport.close()
