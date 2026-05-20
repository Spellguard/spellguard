# SPDX-License-Identifier: Apache-2.0

"""Tests for spellguard_client.dependencies (lockfile + report helpers)."""

import os
import tempfile

import pytest

from spellguard_client.dependencies import (
    LockfileFile,
    ParsedDependency,
    SUPPORTED_LOCKFILES,
    read_lockfile_from_dir,
    report_dependencies,
)


class TestPythonReadLockfileFromDir:
    def test_returns_none_when_no_lockfile_present(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            assert read_lockfile_from_dir(d) is None

    def test_finds_pnpm_lock(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "pnpm-lock.yaml"), "w") as f:
                f.write("lockfileVersion: '9.0'\n")
            r = read_lockfile_from_dir(d)
            assert r is not None
            assert r.filename == "pnpm-lock.yaml"
            assert "lockfileVersion" in r.content

    def test_prefers_pnpm_over_yarn(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "pnpm-lock.yaml"), "w") as f:
                f.write("pnpm")
            with open(os.path.join(d, "yarn.lock"), "w") as f:
                f.write("yarn")
            r = read_lockfile_from_dir(d)
            assert r is not None
            assert r.filename == "pnpm-lock.yaml"

    def test_finds_python_requirements(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "requirements.txt"), "w") as f:
                f.write("requests==2.28.0\n")
            r = read_lockfile_from_dir(d)
            assert r is not None
            assert r.filename == "requirements.txt"

    def test_supported_lockfiles_constant_matches_ts_ordering(self) -> None:
        # Sanity check: the Python list mirrors the TS module's order, so
        # cross-language behavior is consistent.
        assert SUPPORTED_LOCKFILES[0] == "pnpm-lock.yaml"
        assert "package-lock.json" in SUPPORTED_LOCKFILES
        assert "yarn.lock" in SUPPORTED_LOCKFILES
        assert "Cargo.lock" in SUPPORTED_LOCKFILES


class TestPythonReportDependencies:
    @pytest.mark.asyncio
    async def test_raises_when_neither_lockfile_nor_dependencies_provided(self) -> None:
        with pytest.raises(ValueError, match="either lockfile= or dependencies"):
            await report_dependencies(
                management_url="https://m.example.com",
                agent_id="a",
                agent_token="t",
            )

    @pytest.mark.asyncio
    async def test_lockfile_dataclass_round_trips(self) -> None:
        # Construction sanity check (no network)
        lf = LockfileFile(filename="pnpm-lock.yaml", content="lockfileVersion: 9")
        assert lf.filename == "pnpm-lock.yaml"

    @pytest.mark.asyncio
    async def test_parsed_dependency_dataclass_construction(self) -> None:
        dep = ParsedDependency(
            ecosystem="npm",
            package_name="lodash",
            package_version="4.17.21",
            dep_type="runtime",
        )
        assert dep.ecosystem == "npm"
        assert dep.dep_type == "runtime"
