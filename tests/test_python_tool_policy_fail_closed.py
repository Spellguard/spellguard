# SPDX-License-Identifier: Apache-2.0

"""Tool policy checks fail CLOSED by default (Python twin of
tests/security/tool-policy-fail-closed.test.ts).

Regression suite for product-findings S2 (the SDK's fail-open defeats the
Verifier's fail-closed). At the pin, ``check_tool_policy()`` returned
``ToolCheckResult(effect="allow")`` for:

  1. ANY non-200 from the Verifier -- including its own deliberate
     ``503 {"error": "Policy data unavailable", "effect": "block"}``, the one
     answer the Verifier emits specifically to stop the call. The client
     discarded the Verifier's decision and allowed.
  2. Any raised exception: connection failure, the httpx timeout, and an
     unestablished channel (including "never configured at all").

The behaviour was hardcoded, so a consumer could not choose otherwise.

Post-fix posture (G3 -- fail closed is the default direction): a body carrying a
recognized ``effect`` is the Verifier's DECISION and is honoured whatever the
status code; anything else blocks with a machine-readable ``reason``; and
``fail_open=True`` (or ``SPELLGUARD_TOOL_POLICY_FAIL_OPEN=true``) restores the
allow for the no-decision cases only.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from spellguard_client.attestation import (
    TOOL_POLICY_FAIL_OPEN_ENV_VAR,
    check_tool_policy,
    configure,
    reset,
)
from spellguard_client.spellguard import create_spellguard
from spellguard_client.types import (
    AgentCard,
    DirectConfig,
    ManagedConfig,
    SpellguardConfig,
)

MOCK_FLAG = "SPELLGUARD_ALLOW_MOCK_ATTESTATION"

REAL_HASH = "sha384:" + ("a1b2c3d4" * 12)

AGENT_CARD = AgentCard(
    name="agent-tool-policy", url="http://localhost:9999", skills=[]
)


def _config(**overrides) -> SpellguardConfig:
    fields = {
        "agent_id": "agent-tool-policy",
        # localhost keeps the mock-attestation flag permissible (S1 / D1),
        # which is what lets this suite establish a channel without a real
        # Verifier.
        "verifier_url": "http://localhost:3000",
        "self_url": "http://localhost:9999",
        "code_hash": "sha256:test",
        "expected_verifier_image_hash": REAL_HASH,
        "agent_card": AGENT_CARD,
    }
    fields.update(overrides)
    return SpellguardConfig(**fields)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """Mock attestation on (localhost only), fail-open flag off, no state."""
    monkeypatch.setenv(MOCK_FLAG, "true")
    monkeypatch.delenv(TOOL_POLICY_FAIL_OPEN_ENV_VAR, raising=False)
    reset()
    yield
    reset()


def _install_verifier(monkeypatch, tools_check):
    """Stub ``/agents/register`` so a channel exists; delegate the tool check.

    ``tools_check`` is a zero-arg callable returning an ``httpx.Response`` or
    raising -- raising models a connection failure or the httpx timeout.

    ``counters["tool_check_timeouts"]`` and ``counters["register_timeouts"]``
    record the EFFECTIVE ``timeout=`` for each ``/v1/tools/check`` and
    ``/agents/register`` post -- the per-request value if the caller set
    one, else the client default. Those are the abort budgets that decide
    whether a slow-but-healthy control-plane call completes or turns into
    a manufactured block.
    """
    counters = {
        "tool_checks": 0,
        "tool_check_timeouts": [],
        "register_timeouts": [],
        "tool_check_tokens": [],
    }

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs) -> None:
            self._timeout = kwargs.get("timeout")

        async def __aenter__(self) -> "_FakeAsyncClient":
            return self

        async def __aexit__(self, *args) -> bool:
            return False

        async def post(self, url: str, **kwargs) -> httpx.Response:
            # httpx lets a per-request `timeout=` override the client
            # default, and the two legs use different spellings: the
            # tool check sets it on the CONSTRUCTOR, registration sets
            # it on the POST. Record whichever actually applies, so the
            # assertion is about the effective budget and not about the
            # shape of the call.
            effective = kwargs.get("timeout", self._timeout)
            if "/v1/discover" in url:
                return httpx.Response(
                    200,
                    json={
                        "verifierUrl": "http://localhost:3000",
                        "verifierPublicKey": "a" * 64,
                        "verifierRegion": "local",
                        "verifierId": "verifier-1",
                        "verifierImageHash": REAL_HASH,
                        "managementToken": "management-token-1",
                        "refreshInterval": 300,
                        "issuedAt": 0,
                        "expiresAt": 0,
                        "signature": "sig",
                    },
                )
            if "/agents/register" in url:
                counters["register_timeouts"].append(effective)
                return httpx.Response(
                    200,
                    json={
                        "verified": True,
                        # A fresh token per registration, as the Verifier
                        # issues one, so a re-registration is visible.
                        "channelToken": f"channel-token-{len(counters['register_timeouts'])}",
                        # The key discovery attested (#1259): registration
                        # must hand back the same key, or the channel is
                        # refused.
                        "sessionPublicKey": "a" * 64,
                        "sessionX25519PublicKey": "c" * 64,
                        "expiresAt": 0,
                    },
                )
            if "/v1/tools/check" in url:
                counters["tool_checks"] += 1
                counters["tool_check_timeouts"].append(effective)
                counters["tool_check_tokens"].append(
                    kwargs.get("headers", {}).get("X-Spellguard-Channel-Token")
                )
                return tools_check()
            return httpx.Response(500, text="unexpected leg in this test")

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    return counters


def _policy_data_unavailable() -> httpx.Response:
    """The Verifier's own fail-closed answer when it cannot load policy data."""
    return httpx.Response(
        503, json={"error": "Policy data unavailable", "effect": "block"}
    )


# =====================================================================
# (a) The Verifier's decision is honoured, whatever the status code
# =====================================================================


class TestPythonVerifierDecisionHonoured:
    async def test_503_block_is_honoured(self, monkeypatch):
        _install_verifier(monkeypatch, _policy_data_unavailable)
        configure(_config())

        result = await check_tool_policy(
            "input", "transferFunds", {"amount": 1_000_000}
        )

        assert result.effect == "block"

    async def test_503_block_is_honoured_on_output_phase(self, monkeypatch):
        _install_verifier(monkeypatch, _policy_data_unavailable)
        configure(_config())

        result = await check_tool_policy(
            "output", "readCustomerRecord", {}, {"ssn": "000-00-0000"}
        )

        assert result.effect == "block"

    async def test_allow_still_allows(self, monkeypatch):
        _install_verifier(
            monkeypatch, lambda: httpx.Response(200, json={"effect": "allow"})
        )
        configure(_config())

        result = await check_tool_policy("input", "listFiles", {})

        assert result.effect == "allow"
        assert result.reason is None

    async def test_flag_passes_through_on_200(self, monkeypatch):
        _install_verifier(
            monkeypatch, lambda: httpx.Response(200, json={"effect": "flag"})
        )
        configure(_config())

        result = await check_tool_policy("input", "listFiles", {})

        assert result.effect == "flag"

    async def test_redact_honoured_off_non_2xx(self, monkeypatch):
        _install_verifier(
            monkeypatch,
            lambda: httpx.Response(503, json={"effect": "redact", "data": "[X]"}),
        )
        configure(_config())

        result = await check_tool_policy("output", "readSecret", {}, "sk-1")

        assert result.effect == "redact"

    async def test_allow_refused_off_non_2xx(self, monkeypatch):
        # The decision rule must not be symmetric: honouring a non-2xx "allow"
        # would be the last remaining path by which a failed request grants
        # permission. No live handler emits one, so this pins the shape.
        _install_verifier(
            monkeypatch, lambda: httpx.Response(503, json={"effect": "allow"})
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_refused"

    async def test_flag_refused_off_non_2xx(self, monkeypatch):
        _install_verifier(
            monkeypatch, lambda: httpx.Response(500, json={"effect": "flag"})
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_refused"

    async def test_redact_passes_through_with_data(self, monkeypatch):
        _install_verifier(
            monkeypatch,
            lambda: httpx.Response(
                200, json={"effect": "redact", "data": "[REDACTED]"}
            ),
        )
        configure(_config())

        result = await check_tool_policy("output", "readSecret", {}, "sk-1")

        assert result.effect == "redact"
        assert result.data == "[REDACTED]"


# =====================================================================
# (b) No decision at all -> block
# =====================================================================


class TestPythonNoDecisionBlocks:
    async def test_500_without_effect_blocks(self, monkeypatch):
        _install_verifier(
            monkeypatch, lambda: httpx.Response(500, json={"error": "boom"})
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_refused"

    async def test_401_blocks(self, monkeypatch):
        _install_verifier(
            monkeypatch,
            lambda: httpx.Response(
                401, json={"error": "Invalid or expired channel token"}
            ),
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_refused"

    async def test_401_re_registers_once_and_takes_the_decision(self, monkeypatch):
        # #1603: another instance of the agent registered, so the Verifier no
        # longer knows this channel's token. The check re-registers once and
        # asks again with the new token, as a send does.
        answers = iter(
            [
                httpx.Response(
                    401, json={"error": "Invalid or expired channel token"}
                ),
                httpx.Response(200, json={"effect": "allow"}),
            ]
        )
        counters = _install_verifier(monkeypatch, lambda: next(answers))
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"
        assert counters["tool_check_tokens"] == ["channel-token-1", "channel-token-2"]
        assert len(counters["register_timeouts"]) == 2

    async def test_401_re_registers_only_once(self, monkeypatch):
        counters = _install_verifier(
            monkeypatch,
            lambda: httpx.Response(
                401, json={"error": "Invalid or expired channel token"}
            ),
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_refused"
        assert counters["tool_checks"] == 2
        assert len(counters["register_timeouts"]) == 2

    async def test_connection_failure_blocks(self, monkeypatch):
        def _boom() -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        _install_verifier(monkeypatch, _boom)
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_unreachable"

    async def test_timeout_blocks(self, monkeypatch):
        def _slow() -> httpx.Response:
            raise httpx.ReadTimeout("timed out")

        _install_verifier(monkeypatch, _slow)
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_unreachable"

    async def test_unestablished_channel_blocks(self, monkeypatch):
        class _RegistrationDown:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args) -> bool:
                return False

            async def post(self, url: str, **kwargs) -> httpx.Response:
                return httpx.Response(500, text="registration down")

        monkeypatch.setattr(httpx, "AsyncClient", _RegistrationDown)
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "channel_unavailable"

    async def test_never_configured_blocks(self):
        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "channel_unavailable"

    async def test_200_without_recognized_effect_blocks(self, monkeypatch):
        _install_verifier(
            monkeypatch, lambda: httpx.Response(200, json={"nothing": "useful"})
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "malformed_response"

    async def test_200_with_non_json_body_blocks(self, monkeypatch):
        _install_verifier(
            monkeypatch, lambda: httpx.Response(200, text="<html>gateway</html>")
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "malformed_response"


# =====================================================================
# (c) The explicit opt-out is reachable and does what it says
# =====================================================================


class TestPythonFailOpenOptIn:
    async def test_config_fail_open_allows_unreachable_verifier(self, monkeypatch):
        def _boom() -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        _install_verifier(monkeypatch, _boom)
        configure(_config(fail_open=True))

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"

    async def test_config_fail_open_allows_refusal_without_effect(self, monkeypatch):
        _install_verifier(
            monkeypatch, lambda: httpx.Response(500, json={"error": "boom"})
        )
        configure(_config(fail_open=True))

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"

    async def test_env_var_allows_when_never_configured(self, monkeypatch):
        monkeypatch.setenv(TOOL_POLICY_FAIL_OPEN_ENV_VAR, "true")

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"

    async def test_env_var_must_be_exactly_true(self, monkeypatch):
        monkeypatch.setenv(TOOL_POLICY_FAIL_OPEN_ENV_VAR, "1")

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"

    async def test_explicit_false_overrides_env_var(self, monkeypatch):
        monkeypatch.setenv(TOOL_POLICY_FAIL_OPEN_ENV_VAR, "true")

        def _boom() -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        _install_verifier(monkeypatch, _boom)
        configure(_config(fail_open=False))

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"

    async def test_fail_open_does_not_override_explicit_block(self, monkeypatch):
        # fail_open covers "the check could not complete", not "overrule the
        # Verifier". Its 503 {"effect": "block"} is a decision, and letting a
        # client flag discard it is the S2 defect itself.
        _install_verifier(monkeypatch, _policy_data_unavailable)
        configure(_config(fail_open=True))

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"


# =====================================================================
# (d) The opt-out has to reach create_spellguard() consumers
# =====================================================================


def _unreachable() -> httpx.Response:
    raise httpx.ConnectError("connection refused")


def _probe_instance(config):
    """A create_spellguard() instance over the given config mode."""
    return create_spellguard(
        agent_card=AGENT_CARD,
        config=config,
        on_message=lambda ctx: None,
    )


_DIRECT_KWARGS = {
    "type": "direct",
    "agent_id": "agent-tool-policy",
    "verifier_url": "http://localhost:3000",
    "self_url": "http://localhost:9999",
    "code_hash": "sha256:test",
    "expected_verifier_image_hash": REAL_HASH,
}

_MANAGED_KWARGS = {
    "type": "managed",
    "agent_id": "agent-tool-policy",
    "management_url": "http://localhost:8787",
    "self_url": "http://localhost:9999",
    "code_hash": "sha256:test",
}


class TestPythonFailOpenReachesCreateSpellguard:
    """`fail_open` must survive create_spellguard()'s config mapping.

    `create_spellguard()` is the FastAPI/Worker entry point, and the env var is
    not a universal fallback (the TS twin reads `globalThis.process.env`, which
    workerd does not populate from `vars` at the compatibility dates the agents
    pin). The config field is the route that has to work — and it passes
    through THREE field-by-field mappings: `_to_config_mode()` for the
    documented dict form, then `_initialize()`'s managed and direct branches.

    `_ensure_initialized()` is the same entry the FastAPI middleware calls
    (spellguard.py:197); driving it directly keeps the test focused.
    """

    async def test_direct_dataclass_fail_open_reaches_tool_policy(
        self, monkeypatch
    ):
        _install_verifier(monkeypatch, _unreachable)
        sg = _probe_instance(DirectConfig(**_DIRECT_KWARGS, fail_open=True))
        await sg._ensure_initialized()

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"

    async def test_managed_dataclass_fail_open_reaches_tool_policy(
        self, monkeypatch
    ):
        _install_verifier(monkeypatch, _unreachable)
        sg = _probe_instance(ManagedConfig(**_MANAGED_KWARGS, fail_open=True))
        await sg._ensure_initialized()

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"

    async def test_direct_dict_form_fail_open_reaches_tool_policy(
        self, monkeypatch
    ):
        # The dict form is what create_spellguard()'s own docstring shows.
        _install_verifier(monkeypatch, _unreachable)
        sg = _probe_instance({**_DIRECT_KWARGS, "fail_open": True})
        await sg._ensure_initialized()

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"

    async def test_managed_dict_form_fail_open_reaches_tool_policy(
        self, monkeypatch
    ):
        _install_verifier(monkeypatch, _unreachable)
        sg = _probe_instance({**_MANAGED_KWARGS, "fail_open": True})
        await sg._ensure_initialized()

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"

    async def test_direct_default_still_blocks(self, monkeypatch):
        _install_verifier(monkeypatch, _unreachable)
        sg = _probe_instance(DirectConfig(**_DIRECT_KWARGS))
        await sg._ensure_initialized()

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_unreachable"

    async def test_managed_default_still_blocks(self, monkeypatch):
        _install_verifier(monkeypatch, _unreachable)
        sg = _probe_instance(ManagedConfig(**_MANAGED_KWARGS))
        await sg._ensure_initialized()

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "block"
        assert result.reason == "verifier_unreachable"


# =====================================================================
# (e) The request budget must not manufacture a block of its own
# =====================================================================

# The TS twin's budget, read out of its source rather than copied, so
# "Python matches TypeScript" is CHECKED and not merely asserted.
_TS_ATTESTATION = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "client"
    / "ts"
    / "src"
    / "attestation.ts"
)


def _typescript_budget_seconds(path_marker: str) -> float:
    """Extract the ``AbortSignal.timeout`` guarding a TS control-plane fetch.

    ``path_marker`` is the endpoint path as it appears in the fetch
    template literal, e.g. ``"/v1/tools/check"``.
    """
    source = _TS_ATTESTATION.read_text(encoding="utf-8")
    # Anchor on the fetch CALL. Doc comments elsewhere in the file name the
    # same paths, so the first occurrence is not reliably the right one.
    anchor = source.rindex(path_marker)
    assert "fetch(" in source[max(0, anchor - 200) : anchor], (
        f"the last {path_marker} mention in "
        f"{_TS_ATTESTATION.name} is no longer the fetch call — "
        "this extractor needs updating"
    )
    match = re.search(
        r"AbortSignal\.timeout\(([0-9_]+)\)", source[anchor : anchor + 2000]
    )
    assert match is not None, (
        f"no AbortSignal.timeout(...) after the TS {path_marker} fetch — "
        f"{_TS_ATTESTATION.name} and this extractor have drifted"
    )
    return int(match.group(1).replace("_", "")) / 1000.0


class TestPythonToolCheckRequestBudget:
    """The Python tool-policy check must not abort inside the cold-start window.

    Python bounded ``/v1/tools/check`` at 10s while the TypeScript twin used
    60s, and the TS comment says why: this is the same SLIM hop as the other
    control-plane calls, and cold-session establishment takes ~20-30s.

    Under the old fail-OPEN default the asymmetry was invisible -- a premature
    abort cost nothing, because the client allowed the call anyway. Now that the
    default is fail-CLOSED (every case above), an abort inside that window
    BLOCKS the tool: the first tool call after an idle period gets a
    manufactured ``verifier_unreachable`` the Verifier never issued. No
    first-party agent wires the ``fail_open`` opt-out, so there is no escape
    hatch from it either.
    """

    async def test_tool_check_budget_matches_the_typescript_twin(
        self, monkeypatch
    ):
        counters = _install_verifier(
            monkeypatch, lambda: httpx.Response(200, json={"effect": "allow"})
        )
        configure(_config())

        result = await check_tool_policy("input", "transferFunds", {})

        assert result.effect == "allow"
        assert counters["tool_check_timeouts"] == [
            _typescript_budget_seconds("/v1/tools/check")
        ]

    def test_typescript_budget_still_covers_the_cold_start_window(self):
        # The other direction of the same defect: lowering the TS budget to
        # "match" Python would reintroduce the premature abort on both sides.
        assert _typescript_budget_seconds("/v1/tools/check") >= 30.0

    async def test_register_budget_matches_the_typescript_twin(
        self, monkeypatch
    ):
        # The SIBLING SITE. `/agents/register` is the other control-plane call
        # over the same SLIM hop, and Python bounded it at 10s while TS uses
        # 60s. Its failure mode reaches the same place by a different door:
        # `get_or_create_channel()` raises, `check_tool_policy` returns
        # `channel_unavailable`, and fail-closed turns that into a block.
        #
        # The TS comment at that fetch documents how this class of bug
        # propagates: "(c976c0c4 raised the message routes to 120s but left
        # this control-plane call at 10s.)" -- a previous fix that missed a
        # sibling site, which is exactly what fixing only the tool-check leg
        # would have repeated.
        counters = _install_verifier(
            monkeypatch, lambda: httpx.Response(200, json={"effect": "allow"})
        )
        configure(_config())

        await check_tool_policy("input", "transferFunds", {})

        assert counters["register_timeouts"] == [
            _typescript_budget_seconds("/agents/register")
        ]

    def test_typescript_register_budget_still_covers_the_window(self):
        assert _typescript_budget_seconds("/agents/register") >= 30.0
