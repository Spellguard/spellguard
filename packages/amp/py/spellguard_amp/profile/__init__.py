# SPDX-License-Identifier: Apache-2.0
"""Profile abstractions for the Python side of Spellguard.

Mirrors the TypeScript ``@spellguard/amp/profile`` module: an ``original``
bundle (HTTP + A2A + CTLS) and an ``agntcy`` bundle — the full AGNTCY stack:
SLIM data plane (transport) via the Node sidecar + AGNTCY ``dir`` (discovery)
over REST + Ed25519-signed Verifiable Credentials (identity). (Formerly the
``slim`` bundle; renamed because it is the whole AGNTCY stack, not just SLIM.)

A single ``SPELLGUARD_PROFILE`` env var picks between the two profiles. No
per-component toggles; no mock fallbacks. If the SLIM stack, ``dir`` node,
or sidecar isn't running, real-mode calls fail with a clear error.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional, Protocol, runtime_checkable

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PrivateFormat,
    NoEncryption,
    PublicFormat,
)

try:
    import websockets
    from websockets.asyncio.client import connect as ws_connect  # type: ignore
except ImportError:  # pragma: no cover - websockets is a hard dep in requirements.txt
    websockets = None  # type: ignore
    ws_connect = None  # type: ignore


ProfileName = Literal["original", "agntcy"]
TransportName = Literal["http", "slim"]  # 'slim' = genuine AGNTCY SLIM transport
DirectoryName = Literal["a2a-wellknown", "dir"]
IdentityName = Literal["ctls", "agntcy-vc"]


@dataclass(frozen=True)
class AgentAddress:
    """Profile-agnostic agent address. Transports interpret what they need."""

    agent_id: str
    url: Optional[str] = None
    slim_name: Optional[str] = None
    did: Optional[str] = None


@runtime_checkable
class SpellguardTransport(Protocol):
    name: str

    async def send(self, to: AgentAddress, msg: dict) -> dict:  # noqa: D401
        """Send a SecureMessage to ``to`` and return the response."""


@runtime_checkable
class SpellguardDirectory(Protocol):
    name: str

    async def resolve(self, agent_name_or_url: str) -> Optional[AgentAddress]:
        """Resolve an agent name to an address."""


@runtime_checkable
class SpellguardIdentity(Protocol):
    name: str

    async def issue_credential(
        self,
        agent_id: str,
        attestation_evidence: str,
        ttl_seconds: int = 3600,
    ) -> dict:
        """Issue a credential for the agent."""

    async def verify_credential(self, credential: str) -> Optional[dict]:
        """Verify a credential; return claims when valid."""


@dataclass
class ProfileBundle:
    profile: ProfileName
    transport: SpellguardTransport
    directory: SpellguardDirectory
    identity: SpellguardIdentity


# ---------- Original profile (facades over existing Python code) ----------


class _HttpTransport:
    name = "http"

    async def send(self, to: AgentAddress, msg: dict) -> dict:
        raise NotImplementedError(
            "HttpTransport.send: not invoked in original profile — see "
            "spellguard_client.attestation for the existing HTTP send path."
        )


class _A2ADirectory:
    name = "a2a-wellknown"

    async def resolve(self, agent_name_or_url: str) -> Optional[AgentAddress]:
        raise NotImplementedError(
            "A2ADirectory.resolve: not invoked in original profile — see "
            "spellguard_client.discovery.resolve_agent_card."
        )


class _CtlsIdentity:
    name = "ctls"

    async def issue_credential(
        self,
        agent_id: str,
        attestation_evidence: str,
        ttl_seconds: int = 3600,
    ) -> dict:
        raise NotImplementedError(
            "CtlsIdentity.issue_credential: not invoked in original profile."
        )

    async def verify_credential(self, credential: str) -> Optional[dict]:
        raise NotImplementedError(
            "CtlsIdentity.verify_credential: not invoked in original profile."
        )


def create_original_profile() -> ProfileBundle:
    return ProfileBundle(
        profile="original",
        transport=_HttpTransport(),
        directory=_A2ADirectory(),
        identity=_CtlsIdentity(),
    )


# ---------- Agntcy profile ----------


PROTOCOL_VERSION = "0.1"
SUBPROTOCOL = f"spellguard-slim-v{PROTOCOL_VERSION}"


class _SlimTransport:
    """WebSocket client to the Spellguard SLIM sidecar.

    Mirrors the TypeScript SlimTransport: single persistent connection per
    process, bound to one agent identity, multiplexing send/inbound frames
    by ``requestId``.
    """

    name = "gateway"

    def __init__(self, sidecar_url: str) -> None:
        self.sidecar_url = sidecar_url
        self._connection: Optional[Any] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._bound_agent: Optional[tuple[str, str]] = None
        self._connect_lock = asyncio.Lock()

    def bind_agent(self, agent_id: str, slim_name: str) -> None:
        if self._bound_agent is not None:
            if self._bound_agent != (agent_id, slim_name):
                raise RuntimeError(
                    f"SlimTransport already bound to {self._bound_agent}; "
                    f"cannot rebind to ({agent_id}, {slim_name})"
                )
            return
        self._bound_agent = (agent_id, slim_name)

    async def _ensure_connected(self) -> Any:
        if self._connection is not None:
            return self._connection
        async with self._connect_lock:
            if self._connection is not None:
                return self._connection
            if ws_connect is None:
                raise RuntimeError(
                    "websockets package not installed; cannot connect to SLIM sidecar"
                )
            if self._bound_agent is None:
                raise RuntimeError(
                    "SlimTransport.send called before bind_agent — "
                    "call transport.bind_agent(agent_id, slim_name) first."
                )
            agent_id, slim_name = self._bound_agent
            conn = await ws_connect(
                self.sidecar_url,
                subprotocols=[SUBPROTOCOL],  # type: ignore[list-item]
                open_timeout=5,
            )
            await conn.send(
                json.dumps(
                    {
                        "type": "hello",
                        "agentId": agent_id,
                        "slimName": slim_name,
                        "version": PROTOCOL_VERSION,
                    }
                )
            )
            welcome_raw = await asyncio.wait_for(conn.recv(), timeout=5)
            welcome = json.loads(welcome_raw)
            if welcome.get("type") != "welcome":
                await conn.close()
                raise RuntimeError(
                    f"Expected welcome frame, got {welcome.get('type')}: "
                    f"{welcome.get('message', '')}"
                )
            self._connection = conn
            self._reader_task = asyncio.create_task(self._read_loop())
            return conn

    async def _read_loop(self) -> None:
        conn = self._connection
        if conn is None:
            return
        try:
            async for raw in conn:
                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                req_id = frame.get("requestId")
                if frame.get("type") == "send-result" and req_id:
                    fut = self._pending.pop(req_id, None)
                    if fut and not fut.done():
                        fut.set_result(frame.get("message"))
                elif frame.get("type") == "error" and req_id:
                    fut = self._pending.pop(req_id, None)
                    if fut and not fut.done():
                        fut.set_exception(
                            RuntimeError(
                                f"[agntcy profile] sidecar error: "
                                f"{frame.get('code', 'unknown')} — "
                                f"{frame.get('message', '')}"
                            )
                        )
        except Exception:
            # Connection dropped; let pending requests time out via the caller.
            pass

    async def send(self, to: AgentAddress, msg: dict) -> dict:
        conn = await self._ensure_connected()
        request_id = str(uuid.uuid4())
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[request_id] = future
        await conn.send(
            json.dumps(
                {
                    "type": "send",
                    "requestId": request_id,
                    "to": {"agentId": to.agent_id, "slimName": to.slim_name},
                    "message": msg,
                }
            )
        )
        try:
            return await asyncio.wait_for(future, timeout=30)
        finally:
            self._pending.pop(request_id, None)

    async def send_unilateral(
        self,
        a2a_agent_url: str,
        msg: dict,
        method: str = "tasks/send",
    ) -> dict:
        """Bridge to plain HTTP for external A2A-only agents (Fork-4)."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                a2a_agent_url,
                json={
                    "jsonrpc": "2.0",
                    "id": msg["id"],
                    "method": method,
                    "params": {
                        "id": msg["id"],
                        "message": {
                            "role": "user",
                            "parts": [
                                {"type": "text", "text": msg["encryptedPayload"]}
                            ],
                        },
                    },
                },
            )
            response.raise_for_status()
            data = response.json()
            artifacts = (data.get("result") or {}).get("artifacts") or []
            text = (
                artifacts[0]["parts"][0]["text"]
                if artifacts and artifacts[0].get("parts")
                else ""
            )
            return {
                "id": f"resp-{msg['id']}",
                "sender": a2a_agent_url,
                "recipient": msg["sender"],
                "encryptedPayload": text,
                "timestamp": int(time.time() * 1000),
            }

    async def close(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
        if self._connection:
            await self._connection.close()
        self._connection = None
        self._reader_task = None
        self._pending.clear()


class _DirDirectory:
    """REST client for AGNTCY ``dir``. Real HTTP only — fails loudly when the
    dir node is unreachable."""

    name = "agntcy-dir"

    def __init__(self, dir_url: str) -> None:
        self.dir_url = dir_url.rstrip("/")

    async def resolve(self, agent_name_or_url: str) -> Optional[AgentAddress]:
        if agent_name_or_url.startswith(("http://", "https://")):
            return AgentAddress(
                agent_id=agent_name_or_url, url=agent_name_or_url
            )
        url = f"{self.dir_url}/v1/records/by-name/{agent_name_or_url}"
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(url, headers={"Accept": "application/json"})
            if response.status_code == 404:
                return None
            response.raise_for_status()
            record = response.json()
        if not record.get("agentId"):
            return None
        return AgentAddress(
            agent_id=record["agentId"],
            slim_name=record.get("slimName"),
            url=record.get("url"),
        )

    async def publish(self, card: dict) -> None:
        url = f"{self.dir_url}/v1/records"
        agent_id = card.get("agent_id") or card["agentId"]
        endpoint = card.get("endpoint", "")
        is_url = endpoint.startswith(("http://", "https://"))
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.post(
                url,
                json={
                    "agentId": agent_id,
                    "slimName": None if is_url else endpoint,
                    "url": endpoint if is_url else None,
                    "skills": card.get("skills"),
                    "org": card.get("org"),
                },
            )
            response.raise_for_status()


# ---------- Identity ----------


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


class _AgntcyIdentity:
    """Real EdDSA-signed JWT Verifiable Credentials.

    Generates an Ed25519 keypair on first use; signs `vc+jwt` credentials
    in the W3C VC-JWT shape. Cross-process verification requires the
    issuer's public JWK to be shared (typically via
    ``/.well-known/jwks.json`` exposed by the Verifier).
    """

    name = "agntcy-vc"

    def __init__(self, issuer_url: str) -> None:
        self.issuer_url = issuer_url
        self._private_key: Optional[Ed25519PrivateKey] = None
        self._public_key: Optional[Ed25519PublicKey] = None

    def _ensure_key(self) -> None:
        if self._private_key is None:
            self._private_key = Ed25519PrivateKey.generate()
            self._public_key = self._private_key.public_key()

    def public_jwk(self) -> dict:
        """Public JWK for the in-process issuer key."""
        self._ensure_key()
        assert self._public_key is not None
        raw = self._public_key.public_bytes(
            encoding=Encoding.Raw, format=PublicFormat.Raw
        )
        return {
            "kty": "OKP",
            "crv": "Ed25519",
            "alg": "EdDSA",
            "use": "sig",
            "x": _b64url_encode(raw),
        }

    @staticmethod
    def _sha256_hex(payload: str) -> str:
        import hashlib

        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    async def issue_credential(
        self,
        agent_id: str,
        attestation_evidence: str,
        ttl_seconds: int = 3600,
    ) -> dict:
        self._ensure_key()
        assert self._private_key is not None
        now = int(time.time())
        exp = now + ttl_seconds
        header = {"alg": "EdDSA", "typ": "vc+jwt"}
        payload = {
            "iss": self.issuer_url,
            "sub": agent_id,
            "aud": "spellguard-verifier",
            "iat": now,
            "exp": exp,
            "jti": str(uuid.uuid4()),
            "attestationHash": self._sha256_hex(attestation_evidence),
            "codeAttested": len(attestation_evidence) > 0,
        }
        signing_input = (
            _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
            + "."
            + _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
        )
        signature = self._private_key.sign(signing_input.encode("ascii"))
        return {
            "credential": signing_input + "." + _b64url_encode(signature),
            "expires_at": exp * 1000,
        }

    async def verify_credential(self, credential: str) -> Optional[dict]:
        parts = credential.split(".")
        if len(parts) != 3:
            return None
        header_b64, payload_b64, signature_b64 = parts
        signing_input = (header_b64 + "." + payload_b64).encode("ascii")
        try:
            signature = _b64url_decode(signature_b64)
            self._ensure_key()
            assert self._public_key is not None
            self._public_key.verify(signature, signing_input)
            payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
        except (InvalidSignature, ValueError, json.JSONDecodeError):
            return None
        # Match the TS verifier's audience + issuer enforcement.
        if payload.get("iss") != self.issuer_url:
            return None
        if payload.get("aud") != "spellguard-verifier":
            return None
        # RFC 7519: token is invalid when current time is at or past `exp`.
        if payload.get("exp", 0) <= int(time.time()):
            return None
        sub = payload.get("sub")
        if not isinstance(sub, str):
            return None
        return {
            "agent_id": sub,
            "code_attested": bool(payload.get("codeAttested", False)),
            "claims": {
                "attestation_hash": payload.get("attestationHash"),
                "iss": payload.get("iss"),
                "exp": payload.get("exp"),
            },
        }


def create_agntcy_profile(env: Optional[dict] = None) -> ProfileBundle:
    env = env or {}
    return ProfileBundle(
        profile="agntcy",
        transport=_SlimTransport(
            env.get("SPELLGUARD_SLIM_GATEWAY_URL", "ws://localhost:46358")
        ),
        directory=_DirDirectory(
            env.get("SPELLGUARD_DIR_URL", "http://localhost:8888")
        ),
        identity=_AgntcyIdentity(
            env.get("SPELLGUARD_IDENTITY_ISSUER_URL", "http://localhost:8889")
        ),
    )


# ---------- Loader ----------


_KNOWN_PROFILES = {"original", "agntcy"}


def load_profile(env: Optional[dict] = None) -> ProfileBundle:
    """Resolve the active profile bundle.

    Reads ``SPELLGUARD_PROFILE`` from ``env`` (falling back to
    ``os.environ``). Defaults to ``original``; unknown values fall back to
    ``original`` with a warning so a typo never crashes a deployment.
    """

    env = dict(os.environ) if env is None else env
    raw = (env.get("SPELLGUARD_PROFILE") or "original").lower()
    if raw not in _KNOWN_PROFILES:
        import warnings

        warnings.warn(
            f'Unknown SPELLGUARD_PROFILE="{raw}", falling back to "original"',
            stacklevel=2,
        )
        raw = "original"

    if raw == "agntcy":
        return create_agntcy_profile(env)
    return create_original_profile()


__all__ = [
    "AgentAddress",
    "DirectoryName",
    "IdentityName",
    "ProfileBundle",
    "ProfileName",
    "SpellguardDirectory",
    "SpellguardIdentity",
    "SpellguardTransport",
    "TransportName",
    "create_original_profile",
    "create_agntcy_profile",
    "load_profile",
]
