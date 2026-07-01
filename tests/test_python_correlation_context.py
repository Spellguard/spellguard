# SPDX-License-Identifier: Apache-2.0

"""
Trace-context propagation in the Python client (parity with the
TypeScript ``hop-context`` tests in ``tests/client-correlation-context.test.ts``).

The Python and TS clients both stamp ``_spellguardHops`` /
``_spellguardCorrelationId`` on outbound payloads from contextvars
and re-establish them on receive, so audit_logs entries from one
multi-hop conversation share a single ``correlation_id``.  These
tests lock in the contextvar invariants on the Python side.
"""

import asyncio

import pytest

from spellguard_client import (
    get_current_correlation_id,
    get_current_hops,
    get_current_sender_id,
    new_correlation_id,
    set_current_correlation_id,
    set_current_hops,
    set_current_sender_id,
)
from spellguard_client.ai import (
    _current_correlation_id,
    _current_hops,
    _current_sender_id,
)


@pytest.mark.asyncio
async def test_set_current_correlation_id_propagates_inside_async_context():
    """Top-level callers install a trace id; nested awaits see it."""
    upstream_id = "trace-from-upstream-agent"
    hops_token = set_current_hops(0)
    corr_token = set_current_correlation_id(upstream_id)
    try:
        assert get_current_hops() == 0
        assert get_current_correlation_id() == upstream_id

        async def nested() -> str | None:
            await asyncio.sleep(0)
            return get_current_correlation_id()

        # Crossing an await boundary preserves the contextvar.
        assert await nested() == upstream_id
    finally:
        _current_correlation_id.reset(corr_token)
        _current_hops.reset(hops_token)

    # After reset, both are back to defaults.
    assert get_current_hops() == 0
    assert get_current_correlation_id() is None


@pytest.mark.asyncio
async def test_concurrent_flows_get_isolated_correlation_ids():
    """Two concurrent flows installing their own ids must not see each other."""

    async def flow(tag: str, hold_seconds: float) -> tuple[str, str | None]:
        token = set_current_correlation_id(new_correlation_id())
        try:
            id_before = get_current_correlation_id()
            # Yield long enough that the other flow installs its own
            # contextvar in an overlapping interleave before we resume.
            await asyncio.sleep(hold_seconds)
            id_after = get_current_correlation_id()
            assert id_after == id_before
            return tag, id_after
        finally:
            _current_correlation_id.reset(token)

    a, b = await asyncio.gather(flow("a", 0.03), flow("b", 0.01))

    assert a[1] is not None
    assert b[1] is not None
    assert a[1] != b[1]


def test_outside_any_scope_correlation_id_is_none_and_hops_is_zero():
    assert get_current_hops() == 0
    assert get_current_correlation_id() is None


def test_new_correlation_id_returns_unique_values():
    a = new_correlation_id()
    b = new_correlation_id()
    assert isinstance(a, str)
    assert len(a) > 0
    assert a != b


# Immediate-sender context (parity with the TS sender-exclusion tests). The
# receive handler installs the inbound sender so nested routing excludes
# back-routing to it (2-node cycle prevention — DAG routing).
@pytest.mark.asyncio
async def test_set_current_sender_id_propagates_inside_async_context():
    token = set_current_sender_id("kyc-screener")
    try:
        assert get_current_sender_id() == "kyc-screener"

        async def nested() -> str | None:
            await asyncio.sleep(0)
            return get_current_sender_id()

        assert await nested() == "kyc-screener"
    finally:
        _current_sender_id.reset(token)
    # Filter is a no-op once cleared (top-level send / chat has no inbound).
    assert get_current_sender_id() is None


def test_outside_any_scope_sender_id_is_none():
    assert get_current_sender_id() is None


@pytest.mark.asyncio
async def test_concurrent_receives_get_isolated_sender_ids():
    """A module global would cross-contaminate; the contextvar must not."""

    async def receive(sender: str, hold_seconds: float) -> tuple[str, str | None]:
        token = set_current_sender_id(sender)
        try:
            before = get_current_sender_id()
            await asyncio.sleep(hold_seconds)
            after = get_current_sender_id()
            assert after == before
            return sender, after
        finally:
            _current_sender_id.reset(token)

    a, b = await asyncio.gather(receive("agent-a", 0.03), receive("agent-b", 0.01))
    assert a[1] == "agent-a"
    assert b[1] == "agent-b"
