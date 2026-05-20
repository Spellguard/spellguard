# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client.dependencies — agent-side helpers for reporting
lockfile / dependency snapshots to Management's advisory pipeline.

Mirrors :mod:`spellguard_client/dependencies.ts`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, List, Literal, Optional

import httpx

SUPPORTED_LOCKFILES: tuple[str, ...] = (
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "yarn.lock",
    "package-lock.json",
    "requirements.txt",
    "poetry.lock",
    "Cargo.lock",
    "go.sum",
    "sbom.cdx.json",
    "cyclonedx.json",
    "sbom.json",
)


@dataclass
class LockfileFile:
    filename: str
    content: str


@dataclass
class ParsedDependency:
    ecosystem: str
    package_name: str
    package_version: str
    dep_type: Literal["runtime", "dev", "transitive"]


def read_lockfile_from_dir(directory: str) -> Optional[LockfileFile]:
    """Locate and read the first supported lockfile in *directory*.

    Returns ``None`` if no lockfile is present; the caller decides
    whether to skip the upload or fail loudly.
    """
    for candidate in SUPPORTED_LOCKFILES:
        path = os.path.join(directory, candidate)
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                return LockfileFile(filename=candidate, content=f.read())
    return None


async def report_dependencies(
    *,
    management_url: str,
    agent_id: str,
    agent_token: str,
    lockfile: Optional[LockfileFile] = None,
    dependencies: Optional[List[ParsedDependency]] = None,
    lockfile_hash: Optional[str] = None,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """POST the agent's lockfile / dependencies to Management.

    Pass either ``lockfile`` (parser-driven ingestion) or ``dependencies``
    + ``lockfile_hash`` (caller pre-parsed). Returns the server's parse
    summary; raises ``RuntimeError`` on non-2xx responses.
    """
    body: dict[str, Any]
    if lockfile is not None:
        body = {
            "lockfile": {
                "filename": lockfile.filename,
                "content": lockfile.content,
            }
        }
    elif dependencies is not None and lockfile_hash is not None:
        body = {
            "dependencies": [
                {
                    "ecosystem": d.ecosystem,
                    "packageName": d.package_name,
                    "packageVersion": d.package_version,
                    "depType": d.dep_type,
                }
                for d in dependencies
            ],
            "lockfileHash": lockfile_hash,
        }
    else:
        raise ValueError(
            "report_dependencies: pass either lockfile= or "
            "dependencies= + lockfile_hash="
        )
    url = f"{management_url.rstrip('/')}/v1/agents/{agent_id}/dependencies"
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {agent_token}",
                "Content-Type": "application/json",
            },
            json=body,
        )
    if response.status_code >= 400:
        raise RuntimeError(
            f"report_dependencies failed: {response.status_code} "
            f"{response.reason_phrase} — {response.text}"
        )
    return response.json()


__all__ = [
    "SUPPORTED_LOCKFILES",
    "LockfileFile",
    "ParsedDependency",
    "read_lockfile_from_dir",
    "report_dependencies",
]
