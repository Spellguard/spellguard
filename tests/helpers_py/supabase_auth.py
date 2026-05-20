# SPDX-License-Identifier: Apache-2.0

"""Supabase authentication helpers for integration tests.

Mirrors tests/helpers/supabase-auth.ts.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


def get_supabase_auth_config() -> dict[str, str] | None:
    """Read Supabase URL and anon key from env vars."""
    url = (
        os.environ.get("SUPABASE_URL")
        or os.environ.get("E2E_SUPABASE_URL")
        or os.environ.get("STAGING_SUPABASE_URL")
        or ""
    )
    anon_key = (
        os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("E2E_SUPABASE_ANON_KEY")
        or os.environ.get("STAGING_SUPABASE_ANON_KEY")
        or ""
    )
    if not url or not anon_key:
        return None
    return {"url": url, "anon_key": anon_key}


def _auth_headers(anon_key: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
    }


async def is_supabase_auth_reachable(config: dict[str, str]) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{config['url']}/auth/v1/.well-known/jwks.json"
            )
            return resp.is_success
    except Exception:
        return False


async def sign_in_with_password(
    config: dict[str, str], email: str, password: str
) -> dict[str, Any]:
    """Sign in and return ``{"access_token": ..., "user": ...}``."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{config['url']}/auth/v1/token?grant_type=password",
            headers=_auth_headers(config["anon_key"]),
            json={"email": email, "password": password},
        )
        if not resp.is_success:
            raise RuntimeError(
                f"Supabase login failed: {resp.status_code} {resp.text}"
            )
        data = resp.json()
        return {
            "access_token": data["access_token"],
            "refresh_token": data["refresh_token"],
            "user": data["user"],
        }


async def ensure_supabase_session(
    email: str, password: str
) -> dict[str, Any] | None:
    """Return ``{"config": ..., "session": {"access_token": ...}}`` or None."""
    config = get_supabase_auth_config()
    if not config:
        return None
    reachable = await is_supabase_auth_reachable(config)
    if not reachable:
        return None
    session = await sign_in_with_password(config, email, password)
    return {"config": config, "session": session}
