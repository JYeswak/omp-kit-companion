#!/usr/bin/env python3
"""Test exact-SHA release reuse decisions and archive integrity checks."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("release_reuse", ROOT / "scripts" / "release_reuse.py")
if _spec is None or _spec.loader is None:
    raise ImportError("cannot load scripts/release_reuse.py")
release_reuse = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release_reuse)

SOURCE_SHA = "a" * 40
RUN_ID = "12345"
BASE_VERSION = "0.2.20"
REPOSITORY = "JYeswak/omp-kit-companion"
OMP_VERSIONS = {"minimum": "18.4.2", "certified": "18.8.6"}
EXPECTED_VERSION = f"{BASE_VERSION}-rehearsal.{RUN_ID}.1"


def green_ci_runs(source_sha: str = SOURCE_SHA) -> dict[str, Any]:
    return {
        "workflow_runs": [
            {
                "path": release_reuse.CI_WORKFLOW,
                "event": "push",
                "head_branch": "main",
                "head_sha": source_sha,
                "status": "completed",
                "conclusion": "success",
            }
        ]
    }


def candidate_run(source_sha: str = SOURCE_SHA) -> dict[str, Any]:
    return {
        "id": int(RUN_ID),
        "path": release_reuse.RELEASE_WORKFLOW,
        "event": "workflow_dispatch",
        "head_branch": "main",
        "head_sha": source_sha,
        "status": "completed",
        "conclusion": "success",
        "run_attempt": 1,
        "repository": {"full_name": REPOSITORY},
    }


def candidate_artifacts(source_sha: str = SOURCE_SHA) -> dict[str, Any]:
    names = release_reuse.required_candidate_artifacts()
    return {
        "artifacts": [
            {
                "name": name,
                "expired": False,
                "workflow_run": {"id": int(RUN_ID), "head_sha": source_sha},
            }
            for name in sorted(names)
        ]
    }


def candidate_proof_and_index(source_sha: str = SOURCE_SHA) -> tuple[dict[str, Any], dict[str, Any]]:
    assets = {
        platform: {
            "filename": f"omp-kit-v{EXPECTED_VERSION}-{platform}.tar",
            "sha256": "a" * 64,
            "manifest_sha256": "b" * 64,
        }
        for platform in release_reuse.SHIPPING_PLATFORMS
    }
    proof = {
        "schema_version": 1,
        "source_sha": source_sha,
        "version": EXPECTED_VERSION,
        "certified_platforms": list(release_reuse.SHIPPING_PLATFORMS),
        "omp_versions": OMP_VERSIONS,
        "platform_omp_versions": {
            platform: OMP_VERSIONS for platform in release_reuse.SHIPPING_PLATFORMS
        },
        "publication": "NOT_AUTHORIZED",
    }
    index = {
        "schema_version": 1,
        "version": EXPECTED_VERSION,
        "source_tag": f"v{EXPECTED_VERSION}",
        "assets": assets,
    }
    return proof, index


class ReleaseReuseTest(unittest.TestCase):
    def select(self, ci_runs: dict[str, Any], run: dict[str, Any] | None = None, artifacts: dict[str, Any] | None = None) -> dict[str, str]:
        return release_reuse.select_reuse(
            ci_runs,
            run,
            artifacts,
            source_sha=SOURCE_SHA,
            base_version=BASE_VERSION,
            requested_run_id=RUN_ID if run is not None else "",
            repository=REPOSITORY,
        )

    def test_exact_sha_green_ci_and_complete_candidate_are_reusable(self) -> None:
        result = self.select(green_ci_runs(), candidate_run(), candidate_artifacts())
        self.assertEqual(
            result,
            {
                "reuse_fast_ci": "true",
                "candidate_run_id": RUN_ID,
                "candidate_version": EXPECTED_VERSION,
            },
        )

    def test_missing_green_ci_runs_full_candidate_even_with_complete_prior_artifacts(self) -> None:
        result = self.select({"workflow_runs": []}, candidate_run(), candidate_artifacts())
        self.assertEqual(result["reuse_fast_ci"], "false")
        self.assertEqual(result["candidate_run_id"], "")
        self.assertEqual(result["candidate_version"], "")

    def test_ci_for_different_sha_cannot_be_reused(self) -> None:
        result = self.select(green_ci_runs("c" * 40), candidate_run(), candidate_artifacts())
        self.assertEqual(result["reuse_fast_ci"], "false")
        self.assertEqual(result["candidate_run_id"], "")

    def test_malformed_source_sha_fails_closed(self) -> None:
        result = release_reuse.select_reuse(
            green_ci_runs(),
            candidate_run(),
            candidate_artifacts(),
            source_sha="g" * 40,
            base_version=BASE_VERSION,
            requested_run_id=RUN_ID,
            repository=REPOSITORY,
        )
        self.assertEqual(result["reuse_fast_ci"], "false")
        self.assertEqual(result["candidate_run_id"], "")

    def test_missing_native_receipt_disables_candidate_reuse(self) -> None:
        artifacts = candidate_artifacts()
        artifacts["artifacts"] = [
            item for item in artifacts["artifacts"]
            if item["name"] != "native-receipt-linux-arm64-gnu-certified"
        ]
        result = self.select(green_ci_runs(), candidate_run(), artifacts)
        self.assertEqual(result["reuse_fast_ci"], "true")
        self.assertEqual(result["candidate_run_id"], "")
        self.assertEqual(result["candidate_version"], "")

    def test_candidate_index_requires_exact_source_version_tracks_and_platforms(self) -> None:
        proof, index = candidate_proof_and_index()
        self.assertTrue(
            release_reuse.candidate_index_matches(
                proof,
                index,
                source_sha=SOURCE_SHA,
                base_version=BASE_VERSION,
                run_id=RUN_ID,
                omp_versions=OMP_VERSIONS,
            )
        )
        wrong_sha = dict(proof, source_sha="c" * 40)
        self.assertFalse(
            release_reuse.candidate_index_matches(
                wrong_sha,
                index,
                source_sha=SOURCE_SHA,
                base_version=BASE_VERSION,
                run_id=RUN_ID,
                omp_versions=OMP_VERSIONS,
            )
        )
        wrong_tracks = dict(proof, omp_versions={"minimum": "18.4.2", "certified": "18.8.5"})
        self.assertFalse(
            release_reuse.candidate_index_matches(
                wrong_tracks,
                index,
                source_sha=SOURCE_SHA,
                base_version=BASE_VERSION,
                run_id=RUN_ID,
                omp_versions=OMP_VERSIONS,
            )
        )

    def test_archive_reuse_checks_bytes_against_release_index(self) -> None:
        archive_bytes = b"certified archive bytes"
        digest = hashlib.sha256(archive_bytes).hexdigest()
        filename = "candidate.tar"
        index = {
            "assets": {
                "linux-x64-gnu": {"filename": filename, "sha256": digest},
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / filename
            archive.write_bytes(archive_bytes)
            self.assertTrue(release_reuse.archive_matches_index(index, "linux-x64-gnu", Path(directory)))
            archive.write_bytes(b"changed archive bytes")
            self.assertFalse(release_reuse.archive_matches_index(index, "linux-x64-gnu", Path(directory)))

    def test_preflight_cli_rejects_reuse_without_green_ci(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ci_runs = root / "ci-runs.json"
            candidate = root / "candidate.json"
            artifacts = root / "artifacts.json"
            ci_runs.write_text(json.dumps({"workflow_runs": []}), encoding="utf-8")
            candidate.write_text(json.dumps({"id": 0}), encoding="utf-8")
            artifacts.write_text(json.dumps({"artifacts": []}), encoding="utf-8")
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                result = release_reuse.main(
                    [
                        "preflight",
                        "--ci-runs", str(ci_runs),
                        "--candidate-run", str(candidate),
                        "--artifacts", str(artifacts),
                        "--source-sha", SOURCE_SHA,
                        "--base-version", BASE_VERSION,
                        "--repository", REPOSITORY,
                    ]
                )
        self.assertEqual(result, 0)
        self.assertEqual(
            stdout.getvalue().splitlines(),
            ["reuse_fast_ci=false", "candidate_run_id=", "candidate_version="],
        )

    def test_invalid_reused_candidate_cli_fails_closed(self) -> None:
        proof, index = candidate_proof_and_index()
        proof["version"] = "0.2.21-rehearsal.12345.1"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proof_path = root / "proof.json"
            index_path = root / "index.json"
            omp_path = root / "omp.json"
            proof_path.write_text(json.dumps(proof), encoding="utf-8")
            index_path.write_text(json.dumps(index), encoding="utf-8")
            omp_path.write_text(json.dumps(OMP_VERSIONS), encoding="utf-8")
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                result = release_reuse.main(
                    [
                        "validate-index",
                        "--proof", str(proof_path),
                        "--index", str(index_path),
                        "--omp-config", str(omp_path),
                        "--source-sha", SOURCE_SHA,
                        "--base-version", BASE_VERSION,
                        "--run-id", RUN_ID,
                    ]
                )
        self.assertEqual(result, 1)
        self.assertEqual(stdout.getvalue().splitlines(), ["run_id=", "version="])


if __name__ == "__main__":
    unittest.main()
