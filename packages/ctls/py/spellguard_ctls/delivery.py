# SPDX-License-Identifier: Apache-2.0

"""
spellguard_ctls.delivery - Signed deliveries (#1244)

Python twin of ``packages/ctls/ts/src/delivery/delivery-auth.ts``. An agent's
``/_spellguard/receive`` accepts only deliveries its own Verifier signed with
the Ed25519 session key the agent pinned from its attested registration. The
signed string is::

    spellguard-delivery-v1
    <recipient agent id>
    <sha256(channel token)>
    <timestamp ms>
    <nonce, 128-bit hex>
    <sha256(raw body)>

joined with newlines. Both SDKs are pinned by the shared vectors in
``tests/fixtures/delivery-auth/delivery-auth-v1.json``.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Protocol

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

DELIVERY_AUTH_VERSION = "v1"
DELIVERY_AUTH_SCHEME = "spellguard-delivery-v1"

# Header names, exactly as the Verifier sends them.
DELIVERY_AUTH_HEADERS = {
    "version": "X-Spellguard-Delivery-Auth",
    "keyId": "X-Spellguard-Delivery-Key",
    "timestamp": "X-Spellguard-Delivery-Timestamp",
    "nonce": "X-Spellguard-Delivery-Nonce",
    "signature": "X-Spellguard-Delivery-Signature",
}

# A delivery's timestamp must be within this of the receiver's clock.
DELIVERY_AUTH_MAX_SKEW_MS = 5 * 60 * 1000

_HEX_32 = re.compile(r"^[0-9a-fA-F]{32}$")
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_HEX_128 = re.compile(r"^[0-9a-fA-F]{128}$")
_DIGITS = re.compile(r"^\d{1,16}$")


class DeliveryNonceStore(Protocol):
    """Records accepted nonces. ``check_and_record`` returns True the first
    time it sees ``key`` and False for a replay; ``now_ms`` is the clock the
    delivery was judged by. A deployment with several receivers passes a
    shared store."""

    def check_and_record(self, key: str, expires_at_ms: int, now_ms: int) -> bool: ...


class DeliveryNonceCache:
    """Bounded in-process nonce cache (LRU). Entries are forgotten once their
    delivery could no longer pass the timestamp window. Thread-safe, since
    the FastAPI app and CrewAI worker threads can share one process."""

    def __init__(self, max_entries: int = 10_000) -> None:
        self._max_entries = max_entries
        self._entries: OrderedDict[str, int] = OrderedDict()
        self._lock = threading.Lock()

    def check_and_record(self, key: str, expires_at_ms: int, now_ms: int) -> bool:
        with self._lock:
            while self._entries:
                oldest_key, oldest_exp = next(iter(self._entries.items()))
                if oldest_exp > now_ms:
                    break
                self._entries.pop(oldest_key)
            existing = self._entries.get(key)
            if existing is not None and existing > now_ms:
                return False
            self._entries.pop(key, None)
            self._entries[key] = expires_at_ms
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
            return True


def _sha256_hex(data: str | bytes) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


def delivery_key_id(public_key_hex: str) -> str:
    """sha256 over the raw 32 key bytes, truncated to 16 hex characters."""
    return hashlib.sha256(bytes.fromhex(public_key_hex)).hexdigest()[:16]


def delivery_signing_string(
    *,
    recipient_agent_id: str,
    channel_token: str,
    timestamp: int,
    nonce: str,
    body: str | bytes,
) -> str:
    return "\n".join(
        [
            DELIVERY_AUTH_SCHEME,
            recipient_agent_id,
            _sha256_hex(channel_token),
            str(timestamp),
            nonce,
            _sha256_hex(body),
        ]
    )


def sign_delivery(
    *,
    recipient_agent_id: str,
    channel_token: str,
    body: str | bytes,
    public_key_hex: str,
    sign: Callable[[bytes], str],
    now: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """The headers that authenticate one delivery. ``sign`` returns a hex
    Ed25519 signature over the bytes it is given."""
    timestamp = now if now is not None else int(time.time() * 1000)
    nonce = nonce if nonce is not None else secrets.token_hex(16)
    signature = sign(
        delivery_signing_string(
            recipient_agent_id=recipient_agent_id,
            channel_token=channel_token,
            timestamp=timestamp,
            nonce=nonce,
            body=body,
        ).encode("utf-8")
    )
    return {
        DELIVERY_AUTH_HEADERS["version"]: DELIVERY_AUTH_VERSION,
        DELIVERY_AUTH_HEADERS["keyId"]: delivery_key_id(public_key_hex),
        DELIVERY_AUTH_HEADERS["timestamp"]: str(timestamp),
        DELIVERY_AUTH_HEADERS["nonce"]: nonce,
        DELIVERY_AUTH_HEADERS["signature"]: signature,
    }


def _verify_signature(message: str, signature_hex: str, public_key_hex: str) -> bool:
    if not _HEX_128.match(signature_hex) or not _HEX_64.match(public_key_hex.lower()):
        return False
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex)).verify(
            bytes.fromhex(signature_hex), message.encode("utf-8")
        )
        return True
    except Exception:
        return False


def verify_delivery(
    *,
    header: Callable[[str], str | None],
    recipient_agent_id: str,
    channel_token: str,
    body: str | bytes,
    public_key_hex: str,
    nonces: DeliveryNonceStore,
    now: int | None = None,
    max_skew_ms: int = DELIVERY_AUTH_MAX_SKEW_MS,
) -> dict:
    """The agent side. ``public_key_hex`` is the session key from the agent's
    own attested registration, never a key the delivery supplies. Returns
    ``{"ok": True, "key_id": ...}`` or ``{"ok": False, "reason": ...}``; a
    nonce is recorded only after the signature verified."""

    def read(name: str) -> str | None:
        value = header(name)
        return value if value else None

    version = read(DELIVERY_AUTH_HEADERS["version"])
    if version is None:
        return {"ok": False, "reason": "missing"}
    if version != DELIVERY_AUTH_VERSION:
        return {"ok": False, "reason": "unsupported_version"}
    key_id = read(DELIVERY_AUTH_HEADERS["keyId"])
    timestamp_raw = read(DELIVERY_AUTH_HEADERS["timestamp"])
    nonce = read(DELIVERY_AUTH_HEADERS["nonce"])
    signature = read(DELIVERY_AUTH_HEADERS["signature"])
    if not key_id or not timestamp_raw or not nonce or not signature:
        return {"ok": False, "reason": "missing"}

    expected_key_id = delivery_key_id(public_key_hex)
    if key_id.lower() != expected_key_id:
        return {"ok": False, "reason": "unknown_key"}

    now_ms = now if now is not None else int(time.time() * 1000)
    if not _DIGITS.match(timestamp_raw):
        return {"ok": False, "reason": "stale"}
    timestamp = int(timestamp_raw)
    if abs(now_ms - timestamp) > max_skew_ms:
        return {"ok": False, "reason": "stale"}

    if not _HEX_32.match(nonce):
        return {"ok": False, "reason": "bad_signature"}
    message = delivery_signing_string(
        recipient_agent_id=recipient_agent_id,
        channel_token=channel_token,
        timestamp=timestamp,
        nonce=nonce,
        body=body,
    )
    if not _verify_signature(message, signature.lower(), public_key_hex):
        return {"ok": False, "reason": "bad_signature"}

    if not nonces.check_and_record(
        f"{expected_key_id}:{nonce.lower()}", timestamp + max_skew_ms, now_ms
    ):
        return {"ok": False, "reason": "replayed"}
    return {"ok": True, "key_id": expected_key_id}
