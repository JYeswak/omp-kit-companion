#!/usr/bin/env python3
"""Test exact-SHA release reuse decisions and archive integrity checks."""
from __future__ import annotations

import contextlib
import argparse
import copy
import hashlib
import importlib.util
import io
import os
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
import zipfile
from unittest.mock import patch

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
        "created_at": "2026-10-17T01:00:00Z",
        "run_started_at": "2026-10-17T01:00:00Z",
        "updated_at": "2026-10-17T01:10:00Z",
    }


def candidate_artifacts(source_sha: str = SOURCE_SHA, attempt: int = 1) -> dict[str, Any]:
    names = release_reuse.required_candidate_artifacts(attempt)
    return {
        "artifacts": [
            {
                "id": 100 + number,
                "created_at": "2026-10-17T01:05:00Z",
                "name": name,
                "expired": False,
                "workflow_run": {"id": int(RUN_ID), "head_sha": source_sha},
            }
            for number, name in enumerate(sorted(names))
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


def owner_fixture() -> tuple[dict[str, Any], dict[str, Any], bytes]:
    notes = b"### Fixed\n\n- Actual source-range fixture note.\n"
    allocation = {"schema_version": 1, "protocol": release_reuse.ALLOCATION_PROTOCOL, "repository": REPOSITORY,
                  "train_run_id": "810", "train_attempt": "1", "owner_sha": "e" * 40,
                  "source_sha": SOURCE_SHA, "version": BASE_VERSION, "base_tag": "v0.2.19",
                  "notes_sha256": hashlib.sha256(notes).hexdigest(), "rehearsal": False,
                  "qualification_attempt_policy": "same-native-run"}
    encoded = (json.dumps(allocation, sort_keys=True) + "\n").encode()
    bound = {"schema_version": 1, "train_run_id": "810", "train_attempt": "1",
             "allocation_artifact_id": "900", "allocation_sha256": hashlib.sha256(encoded).hexdigest(),
             "qualification_run_id": RUN_ID, "qualification_minimum_attempt": 1, "qualification_head_sha": "f" * 40}
    return allocation, bound, notes


def selected_owner(attempt: int = 1) -> dict[str, Any]:
    allocation, bound, _ = owner_fixture()
    return dict(allocation, qualification_run_id=RUN_ID, qualification_attempt=attempt,
                allocation_artifact_id=bound["allocation_artifact_id"], allocation_sha256=bound["allocation_sha256"])


@contextlib.contextmanager
def final_authority(values: dict[str, Any], latest: dict[str, Any] | None = None, qualified: dict[str, Any] | None = None):
    allocation, bound, notes = owner_fixture()
    index_files = {"candidate-proof.json": json.dumps(values["proof"]).encode(),
                   "release-index.json": json.dumps(values["index"]).encode()}
    selection_files = {"selection.json": json.dumps(values["binding"]).encode(), "release-notes.md": notes}
    def artifacts(repository, row, expected):
        if row["name"].startswith("signed-consumer-"):
            platform = row["name"].removeprefix("signed-consumer-").rsplit("-attempt-", 1)[0]
            return {"receipt.json": json.dumps(values["signed_consumers"][platform]).encode()}
        if row["name"].startswith("native-receipt-"):
            identity = row["name"].removeprefix("native-receipt-").rsplit("-attempt-", 1)[0]
            platform, track = identity.rsplit("-", 1)
            stage = {
                "schema_version": 1, "scope": "source-workflow-integrity",
                "source_sha": SOURCE_SHA, "archive_sha256": values["index"]["assets"][platform]["sha256"],
                "manifest_sha256": values["index"]["assets"][platform]["manifest_sha256"],
                "public_installation": "NOT_VERIFIED",
                "producer": {"repository": REPOSITORY,
                             "workflow_ref": f"{REPOSITORY}/{release_reuse.RELEASE_WORKFLOW}@refs/heads/main",
                             "run_id": str(values["run"]["id"]), "run_attempt": str(values["run"]["run_attempt"])},
            }
            stage.update(values.get("staging_overrides", {}).get(identity, {}))
            receipt = {"source_sha": SOURCE_SHA, "version": BASE_VERSION, "platform": platform,
                       "omp_track": track, "requested_omp_version": OMP_VERSIONS[track],
                       "omp_version": OMP_VERSIONS[track], "certified": True, "archive_staging": stage}
            return {"receipt.json": json.dumps(receipt).encode()}
        return index_files if row["name"].startswith("unpublished-candidate-index") else selection_files
    def api(repository, endpoint, **kwargs):
        if endpoint == "releases?per_page=100":
            return [[{"tag_name": tag, "draft": False, "prerelease": False}
                     for tag in values.get("published", ["v0.2.19"])]]
        return qualified if qualified is not None and endpoint == f"actions/runs/{RUN_ID}" else (latest or values["run"])
    with patch.object(release_reuse, "_load_owner_authority", return_value=(allocation, bound, notes)), \
         patch.object(release_reuse, "_api", side_effect=api), \
         patch.object(release_reuse, "_artifact_files", side_effect=artifacts):
        yield


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

    def test_release_bump_reuses_only_the_named_parent_ci(self) -> None:
        parent = "c" * 40
        inherited = release_reuse.select_reuse(
            green_ci_runs(parent), None, None, source_sha=SOURCE_SHA, base_version=BASE_VERSION,
            requested_run_id="", repository=REPOSITORY, ci_sha=parent,
        )
        self.assertEqual(inherited["reuse_fast_ci"], "true")
        other = release_reuse.select_reuse(
            green_ci_runs(parent), None, None, source_sha=SOURCE_SHA, base_version=BASE_VERSION,
            requested_run_id="", repository=REPOSITORY, ci_sha="d" * 40,
        )
        self.assertEqual(other["reuse_fast_ci"], "false")

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
            if item["name"] != "native-receipt-linux-arm64-gnu-certified-attempt-1"
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


class RollingReleaseTest(unittest.TestCase):
    def test_running_and_red_descendants_do_not_starve_eligible_green(self) -> None:
        a, b, c = "a" * 40, "b" * 40, "c" * 40
        rows = green_ci_runs(a)["workflow_runs"]
        rows += [dict(rows[0], head_sha=b, status="in_progress", conclusion=None),
                 dict(rows[0], head_sha=c, conclusion="failure")]
        runs = {"workflow_runs": rows}
        self.assertEqual(release_reuse.select_source(runs, [c, b, a]), a)
        rows[1].update(status="completed", conclusion="failure")
        self.assertEqual(release_reuse.select_source(runs, [c, b, a]), a)
        rows[1]["conclusion"] = "success"
        self.assertEqual(release_reuse.select_source(runs, [c, b, a]), b)
        rows[2]["conclusion"] = "success"
        # Completing A's event last does not let event order beat main ancestry.
        self.assertEqual(release_reuse.select_source({"workflow_runs": list(reversed(rows))}, [c, b, a]), c)
        with self.assertRaisesRegex(ValueError, "superseded"):
            release_reuse.select_source(runs, [c, b, a], a)

    def test_latest_attempt_and_exact_ci_workflow_are_authoritative(self) -> None:
        good = dict(green_ci_runs()["workflow_runs"][0], id=1, run_number=1, run_attempt=1)
        running = dict(good, run_attempt=2, status="in_progress", conclusion=None)
        self.assertFalse(release_reuse.has_green_main_ci({"workflow_runs": [running, good]}, SOURCE_SHA))
        for change in ({"path": ".github/workflows/omp-certify.yml"}, {"event": "schedule"},
                       {"head_branch": "other"}, {"conclusion": "failure"}, {"conclusion": "cancelled"}):
            self.assertEqual(release_reuse.select_source({"workflow_runs": [dict(good, **change)]}, [SOURCE_SHA]), "")
        with self.assertRaisesRegex(ValueError, "outside"):
            release_reuse.select_source({"workflow_runs": [good]}, [SOURCE_SHA], "d" * 40)

    def final_fixture(self, root: Path) -> tuple[list[str], dict[str, Any]]:
        proof, index = candidate_proof_and_index()
        proof["version"] = BASE_VERSION
        index["version"] = BASE_VERSION
        index["source_tag"] = "v" + BASE_VERSION
        run = dict(candidate_run(), head_sha="f" * 40,
                   display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"))
        artifacts = candidate_artifacts("f" * 40)
        artifacts["artifacts"].append({"id": 999, "name": "release-selection-attempt-1", "expired": False,
                                      "created_at": "2026-10-17T01:05:00Z",
                                      "workflow_run": {"id": int(RUN_ID), "head_sha": "f" * 40}})
        _, _, notes = owner_fixture()
        binding = selected_owner()
        values = {"proof": proof, "index": index, "run": run, "artifacts": artifacts,
                  "binding": binding, "omp-config": OMP_VERSIONS}
        args = ["verify-final"]
        for name, value in values.items():
            path = root / f"{name}.json"
            path.write_text(json.dumps(value))
            args += [f"--{name}", str(path)]
        (root / "notes.md").write_bytes(notes)
        args += ["--notes", str(root / "notes.md"), "--repository", REPOSITORY, "--source-sha", SOURCE_SHA,
                 "--version", BASE_VERSION, "--train-id", "810", "--run-id", RUN_ID, "--phase", "qualify"]
        return args, values

    def signed_fixture(self, root: Path) -> tuple[list[str], dict[str, Any]]:
        args, values = self.final_fixture(root)
        values["qualified_run"] = copy.deepcopy(values["run"])
        run = values["run"]
        run.update(id=67890, head_sha=SOURCE_SHA, head_branch="v" + BASE_VERSION,
                   display_title=release_reuse.release_title("sign", BASE_VERSION, SOURCE_SHA, "810"))
        rows = values["artifacts"]["artifacts"]
        rows[:] = [row for row in rows if not row["name"].startswith("native-receipt-")]
        index_hash = hashlib.sha256((root / "index.json").read_bytes()).hexdigest()
        consumers = {}
        for number, platform in enumerate(release_reuse.SHIPPING_PLATFORMS):
            for offset, name in enumerate((f"sbom-{platform}-attempt-1", f"signed-consumer-{platform}-attempt-1")):
                rows.append({"id": 2000 + number * 2 + offset, "name": name, "expired": False,
                             "created_at": "2026-10-17T01:05:00Z"})
            consumers[platform] = {
                "schema_version": 1, "kind": "signed-native-consumer", "platform": platform,
                "version": BASE_VERSION, "source_sha": SOURCE_SHA,
                "archive_sha256": values["index"]["assets"][platform]["sha256"],
                "index_sha256": index_hash, "run_id": "67890", "run_attempt": 1,
                "previous_version": "0.2.19", "installed_version": BASE_VERSION,
                "checks": {"public_installer": True, "compiled_upgrade": True},
            }
        for row in rows:
            row["workflow_run"] = {"id": 67890, "head_sha": SOURCE_SHA}
        values["signed_consumers"] = consumers
        for name in ("run", "artifacts"):
            (root / f"{name}.json").write_text(json.dumps(values[name]))
        args[args.index("--phase") + 1] = "sign"
        args[args.index("--run-id") + 1] = "67890"
        return args, values

    def test_final_certification_accepts_historical_source_but_not_partial_or_foreign_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, original = self.final_fixture(root)
            with final_authority(original), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release_reuse.main(args), 0)
                cases = [
                    ("run", dict(original["run"], head_branch="untrusted")),
                    ("run", dict(original["run"], path=".github/workflows/omp-certify.yml")),
                    ("run", dict(original["run"], repository={"full_name": "another/repository"})),
                    ("run", dict(original["run"], run_attempt=2)),
                    ("proof", dict(original["proof"], source_sha="e" * 40)),
                    ("proof", dict(original["proof"], version="0.2.21")),
                    ("proof", dict(original["proof"], certified_platforms=list(release_reuse.SHIPPING_PLATFORMS[:2]))),
                    ("proof", dict(original["proof"], platform_omp_versions={})),
                    ("proof", dict(original["proof"], omp_versions={"minimum": "18.4.2", "certified": "18.8.5"})),
                    ("binding", dict(original["binding"], qualification_run_id="999")),
                    ("binding", dict(original["binding"], source_sha="e" * 40)),
                ]
                artifacts = copy.deepcopy(original["artifacts"])
                artifacts["artifacts"] = [row for row in artifacts["artifacts"] if row["name"] != "native-receipt-linux-arm64-gnu-certified-attempt-1"]
                cases.append(("artifacts", artifacts))
                for field, value in (("expired", True), ("created_at", "2026-10-16T00:00:00Z"), ("created_at", None)):
                    changed = copy.deepcopy(original["artifacts"])
                    changed["artifacts"][0][field] = value
                    cases.append(("artifacts", changed))
                for name, changed in cases:
                    with self.subTest(name=name, changed=changed):
                        path = root / f"{name}.json"
                        path.write_text(json.dumps(changed))
                        with self.assertRaises(ValueError):
                            release_reuse.main(args)
                        path.write_text(json.dumps(original[name]))
                (root / "notes.md").write_text("- Tampered notes.\n")
                with self.assertRaises(ValueError):
                    release_reuse.main(args)

    def test_qualification_refuses_foreign_staging_context_or_public_installation_claim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, values = self.final_fixture(root)
            key = release_reuse.SHIPPING_PLATFORMS[0] + "-minimum"
            producer = {"repository": REPOSITORY,
                        "workflow_ref": f"{REPOSITORY}/{release_reuse.RELEASE_WORKFLOW}@refs/heads/main",
                        "run_id": RUN_ID, "run_attempt": "1"}
            changes = [
                {"source_sha": "e" * 40}, {"archive_sha256": "f" * 64}, {"manifest_sha256": "f" * 64},
                {"scope": "published-installation"}, {"public_installation": "VERIFIED"},
                {"producer": dict(producer, run_id="999")}, {"producer": dict(producer, run_attempt=2)},
                {"producer": dict(producer, run_attempt="2")},
                {"producer": dict(producer, workflow_ref="another/repository/workflow@refs/heads/main")},
            ]
            with final_authority(values), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release_reuse.main(args), 0)
                for change in changes:
                    with self.subTest(change=change):
                        values["staging_overrides"] = {key: change}
                        with self.assertRaises(ValueError):
                            release_reuse.main(args)

    def test_tag_ref_signing_cannot_claim_main_execution_identity(self) -> None:
        run = dict(candidate_run(), head_branch="v" + BASE_VERSION,
                   display_title=release_reuse.release_title("sign", BASE_VERSION, SOURCE_SHA, "810"))
        self.assertTrue(release_reuse.final_run_matches(run, repository=REPOSITORY, source_sha=SOURCE_SHA,
                                                       version=BASE_VERSION, train_id="810", phase="sign"))
        for changed in (dict(run, head_branch="main"), dict(run, head_sha="f" * 40),
                        dict(run, display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"))):
            self.assertFalse(release_reuse.final_run_matches(changed, repository=REPOSITORY, source_sha=SOURCE_SHA,
                                                            version=BASE_VERSION, train_id="810", phase="sign"))

    def test_signed_final_requires_actual_installer_and_upgrade_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, values = self.signed_fixture(root)
            with final_authority(values, qualified=values["qualified_run"]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release_reuse.main(args), 0)
                rows = values["artifacts"]["artifacts"]
                rows[:] = [row for row in rows if not row["name"].startswith("signed-consumer-")]
                (root / "artifacts.json").write_text(json.dumps(values["artifacts"]))
                with self.assertRaises(ValueError):
                    release_reuse.main(args)

    def test_signed_consumer_refuses_noop_wrong_bytes_foreign_attempt_and_unpublished_previous(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, values = self.signed_fixture(root)
            platform = release_reuse.SHIPPING_PLATFORMS[0]
            original = copy.deepcopy(values["signed_consumers"][platform])
            mutations = [
                {"checks": {"public_installer": True, "compiled_upgrade": False}},
                {"installed_version": "0.2.19"}, {"archive_sha256": "f" * 64},
                {"index_sha256": "f" * 64}, {"run_id": RUN_ID}, {"run_attempt": 2},
                {"previous_version": "0.0.0-ci.0"}, {"previous_version": BASE_VERSION},
                {"previous_version": "0.2.18"},
            ]
            with final_authority(values, qualified=values["qualified_run"]), contextlib.redirect_stdout(io.StringIO()):
                for mutation in mutations:
                    with self.subTest(mutation=mutation):
                        values["signed_consumers"][platform] = dict(original, **mutation)
                        with self.assertRaises(ValueError):
                            release_reuse.main(args)

    def test_active_q_and_version_wait_for_exact_publisher_not_release_existence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            plan = {"kind": "resume", "source_sha": SOURCE_SHA, "version": BASE_VERSION, "train_id": "810", "train_attempt": "1",
                    "qualification_run_id": RUN_ID, "rehearsal": "false", "publisher_floor": 0, "recovery_ids": []}
            path = Path(directory) / "plan.json"
            path.write_text(json.dumps(plan))
            # The signer appears on the next poll, i.e. inside the publisher-delivery grace window this test is about.
            qualified = dict(candidate_run("f" * 40), updated_at="2999-01-01T00:00:00Z",
                             display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"))
            signed = dict(candidate_run(), id=67890, head_branch=f"v{BASE_VERSION}",
                          display_title=release_reuse.release_title("sign", BASE_VERSION, SOURCE_SHA, "810"))
            calls = {"cycle": 0, "publisher": 0}
            def rows(repository, workflow, event="workflow_dispatch", **kwargs):
                if workflow == "release.yml":
                    calls["cycle"] += 1
                    return [] if calls["cycle"] == 1 else [signed]
                return []
            def api(repository, endpoint, **kwargs):
                if endpoint == f"actions/runs/{RUN_ID}":
                    calls["qualifier"] = calls.get("qualifier", 0) + 1
                    return qualified if calls["qualifier"] >= 2 else dict(qualified, status="in_progress", conclusion=None)
                if endpoint == "actions/runs/9001":
                    calls["publisher"] += 1
                    return dict(candidate_run(), id=9001, path=release_reuse.OWNER_WORKFLOW,
                                status="in_progress" if calls["publisher"] == 1 else "completed",
                                conclusion=None if calls["publisher"] == 1 else "success")
                if endpoint == "actions/runs/9001/attempts/1/jobs?per_page=100":
                    return [{"jobs": [{"name": "publish", "run_id": 9001, "status": "completed", "conclusion": "success"}]}]
                if endpoint == f"commits/v{BASE_VERSION}":
                    return {"sha": SOURCE_SHA}
                raise AssertionError(endpoint)
            args = argparse.Namespace(repository=REPOSITORY, plan=str(path), stage="watch", timeout=60)
            with patch.object(release_reuse, "_load_owner_authority", return_value=owner_fixture()), \
                 patch.object(release_reuse, "_run_rows", side_effect=rows), \
                 patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_published", return_value={f"v{BASE_VERSION}"}) as published, \
                 patch.object(release_reuse, "_native_dispatch", return_value="9001") as dispatch, \
                 patch.object(release_reuse.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release_reuse._drive(args), 0)
                dispatch.assert_called_once_with(REPOSITORY, "release-train.yml", "main", {"candidate_run_id": "67890"})
                self.assertEqual(calls["publisher"], 2)
                published.assert_called_once()

    def _watch_qualification(self, *, qualified_overrides: dict[str, Any] | None = None,
                             publisher_rows: list[dict[str, Any]] | None = None,
                             sign_rows: list[dict[str, Any]] | None = None) -> tuple[Any, Exception | None]:
        """Drive the real watch loop for a finished qualification; returns the dispatch mock and the terminal error."""
        with tempfile.TemporaryDirectory() as directory:
            plan = {"kind": "resume", "source_sha": SOURCE_SHA, "version": BASE_VERSION, "train_id": "810", "train_attempt": "1",
                    "qualification_run_id": RUN_ID, "rehearsal": "false", "publisher_floor": 0, "recovery_ids": []}
            path = Path(directory) / "plan.json"
            path.write_text(json.dumps(plan))
            qualified = dict(candidate_run("f" * 40), display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"),
                             **(qualified_overrides or {}))
            def rows(repository, workflow, event="workflow_dispatch", **kwargs):
                if workflow == "release.yml":
                    return list(sign_rows or [])
                return list(publisher_rows or [])
            def api(repository, endpoint, **kwargs):
                if endpoint == f"actions/runs/{RUN_ID}":
                    return qualified
                if endpoint == "actions/runs/9001":
                    return dict(candidate_run(), id=9001, path=release_reuse.OWNER_WORKFLOW, status="in_progress", conclusion=None)
                raise AssertionError(endpoint)
            clock = iter([0, 1, 2, 3, 10_000])
            args = argparse.Namespace(repository=REPOSITORY, plan=str(path), stage="watch", timeout=60)
            error: Exception | None = None
            with patch.object(release_reuse, "_load_owner_authority", return_value=owner_fixture()), \
                 patch.object(release_reuse, "_run_rows", side_effect=rows), \
                 patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_native_dispatch", return_value="9001") as dispatch, \
                 patch.object(release_reuse.time, "monotonic", side_effect=lambda: next(clock)), \
                 patch.object(release_reuse.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
                try:
                    release_reuse._drive(args)
                except ValueError as caught:
                    error = caught
            return dispatch, error

    def test_qualified_run_without_workflow_run_delivery_wakes_its_publisher_exactly_once(self) -> None:
        dispatch, error = self._watch_qualification()
        dispatch.assert_called_once_with(REPOSITORY, "release-train.yml", "main", {"candidate_run_id": RUN_ID})
        self.assertRegex(str(error), "deadline expired")

    def test_qualification_publisher_wake_refuses_failed_fresh_delivered_or_already_signing_runs(self) -> None:
        title = release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810")
        sign = dict(candidate_run(), id=67890, head_branch=f"v{BASE_VERSION}",
                    display_title=release_reuse.release_title("sign", BASE_VERSION, SOURCE_SHA, "810"), status="in_progress", conclusion=None,
                    run_started_at="2026-10-17T01:11:00Z")
        cases = {
            "failed qualification": dict(qualified_overrides={"conclusion": "failure"}),
            "delivery still inside its grace": dict(qualified_overrides={"updated_at": "2999-01-01T00:00:00Z"}),
            "completion time unknown": dict(qualified_overrides={"updated_at": None}),
            "natural workflow_run delivery exists": dict(publisher_rows=[
                dict(candidate_run(), id=9100, display_title=f"Publish {title}", status="in_progress", conclusion=None)]),
            "signing already requested": dict(sign_rows=[sign]),
        }
        for name, options in cases.items():
            with self.subTest(name):
                dispatch, error = self._watch_qualification(**options)
                dispatch.assert_not_called()
                self.assertIsNotNone(error)

    def test_completed_qualification_recovers_without_building_a_new_candidate(self) -> None:
        row = dict(candidate_run(), display_title=release_reuse.release_title("qualify", "0.2.21", SOURCE_SHA, "810"))
        self.assertIs(release_reuse.pending_candidate([row], {"v0.2.20"}, "0.2.20"), row)
        self.assertIsNone(release_reuse.pending_candidate([row], {"v0.2.21"}, "0.2.20"))
        self.assertIsNone(release_reuse.pending_candidate([dict(row, conclusion="failure")], set(), "0.2.20"))

    def test_existing_release_cannot_hide_a_failed_exact_publisher(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            plan = {"kind": "resume", "source_sha": SOURCE_SHA, "version": BASE_VERSION, "train_id": "810", "train_attempt": "1",
                    "qualification_run_id": RUN_ID, "rehearsal": "false", "publisher_floor": 0, "recovery_ids": [],
                    "publisher_runs": {"9001": "sign"}}
            path = Path(directory) / "plan.json"
            path.write_text(json.dumps(plan))
            failed = dict(candidate_run(), id=9001, path=release_reuse.OWNER_WORKFLOW, conclusion="failure")
            args = argparse.Namespace(repository=REPOSITORY, plan=str(path), stage="watch", timeout=60)
            with patch.object(release_reuse, "_load_owner_authority", return_value=owner_fixture()), \
                 patch.object(release_reuse, "_api", return_value=failed), \
                 patch.object(release_reuse, "_published", return_value={f"v{BASE_VERSION}"}) as published:
                with self.assertRaisesRegex(ValueError, "publisher failed"):
                    release_reuse._drive(args)
                published.assert_not_called()
            skipped = dict(failed, conclusion="success")
            def skipped_api(repository, endpoint, **kwargs):
                if endpoint == "actions/runs/9001":
                    return skipped
                return [{"jobs": [{"name": "publish", "run_id": 9001, "status": "completed", "conclusion": "skipped"}]}]
            with patch.object(release_reuse, "_load_owner_authority", return_value=owner_fixture()), \
                 patch.object(release_reuse, "_api", side_effect=skipped_api), \
                 patch.object(release_reuse, "_published", return_value={f"v{BASE_VERSION}"}) as published:
                with self.assertRaisesRegex(ValueError, "did not execute"):
                    release_reuse._drive(args)
                published.assert_not_called()

    def test_qualification_cannot_borrow_owner_for_different_source_version_base_or_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            allocation, bound, notes = owner_fixture()
            args = argparse.Namespace(repository=REPOSITORY, train_id="810", train_attempt="1", qualification_id=RUN_ID,
                                      qualification_attempt=1, source_sha=SOURCE_SHA, version=BASE_VERSION,
                                      base_tag="v0.2.19", output=directory, timeout=0)
            producer = dict(candidate_run("f" * 40), status="in_progress", conclusion=None)
            with patch.object(release_reuse, "_load_owner_authority", return_value=(allocation, bound, notes)), \
                 patch.object(release_reuse, "_api", return_value=producer), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release_reuse._require_allocation(args), 0)
                selected = Path(directory) / "selection.json"
                expected = selected.read_bytes()
                for key, changed in (("source_sha", "b" * 40), ("version", "0.2.19"), ("base_tag", "v0.2.18")):
                    original = getattr(args, key)
                    setattr(args, key, changed)
                    with self.assertRaisesRegex(ValueError, "does not own"):
                        release_reuse._require_allocation(args)
                    setattr(args, key, original)
                    self.assertEqual(selected.read_bytes(), expected)
                args.qualification_id = "99999"
                with patch.object(release_reuse, "_api", return_value=dict(producer, id=99999)):
                    with self.assertRaisesRegex(ValueError, "does not own"):
                        release_reuse._require_allocation(args)
                args.qualification_id = RUN_ID
                args.qualification_attempt = 2
                with patch.object(release_reuse, "_api", return_value=dict(producer, run_attempt=2)):
                    self.assertEqual(release_reuse._require_allocation(args), 0)
                self.assertEqual(json.loads(selected.read_text())["qualification_attempt"], 2)
                without_retry = dict(allocation)
                without_retry.pop("qualification_attempt_policy")
                with patch.object(release_reuse, "_load_owner_authority", return_value=(without_retry, bound, notes)), \
                     patch.object(release_reuse, "_api", return_value=dict(producer, run_attempt=2)):
                    with self.assertRaises(ValueError):
                        release_reuse._require_allocation(args)

    def test_real_git_promotion_cannot_displace_newer_source_or_rebind_a_tag(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git_env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            def git(*args: str) -> str:
                result = release_reuse.subprocess.run(["git", "-C", str(root), *args], text=True,
                                                     stdout=release_reuse.subprocess.PIPE, stderr=release_reuse.subprocess.PIPE, timeout=30, env=git_env)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()
            git("init", "-q")
            git("config", "user.name", "Promotion Fixture")
            git("config", "user.email", "promotion@example.invalid")
            git("config", "core.hooksPath", "/dev/null")
            git("config", "commit.gpgsign", "false")
            sources = []
            for number in range(3):
                (root / "source.txt").write_text(f"source {number}\n")
                git("add", "source.txt")
                git("commit", "-qm", f"fixture source {number}")
                sources.append(git("rev-parse", "HEAD"))
                if number < 2:
                    git("tag", f"v0.2.{19 + number}")
            git("update-ref", "refs/remotes/origin/main", sources[-1])
            with patch.dict(os.environ, {"GIT_DIR": str(root / ".git"), "GIT_WORK_TREE": str(root)}), \
                 patch.object(release_reuse, "_published", return_value={"v0.2.19", "v0.2.20"}), \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError):
                    release_reuse.main(["promotion", "--repository", REPOSITORY, "--source-sha", sources[0], "--version", "9.9.9"])
                with self.assertRaises(ValueError):
                    release_reuse.main(["promotion", "--repository", REPOSITORY, "--source-sha", sources[1], "--version", "0.2.21"])
                self.assertEqual(release_reuse.main(["promotion", "--repository", REPOSITORY, "--source-sha", sources[2], "--version", "0.2.21"]), 0)
                git("tag", "v0.2.21", sources[2])
                self.assertEqual(release_reuse.main(["promotion", "--repository", REPOSITORY, "--source-sha", sources[2], "--version", "0.2.21"]), 0)
                with self.assertRaises(ValueError):
                    release_reuse.main(["promotion", "--repository", REPOSITORY, "--source-sha", sources[1], "--version", "0.2.21"])
    def test_authorized_latest_rerun_requires_its_complete_fresh_artifact_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, values = self.final_fixture(root)
            values["run"].update(run_attempt=2, run_started_at="2026-10-17T02:00:00Z", updated_at="2026-10-17T02:10:00Z")
            values["binding"]["qualification_attempt"] = 2
            for row in values["artifacts"]["artifacts"]:
                row["name"] = row["name"].removesuffix("-attempt-1") + "-attempt-2"
                row["id"] += 2000
                row["created_at"] = "2026-10-17T02:05:00Z"
            for name, value in values.items():
                (root / f"{name}.json").write_text(json.dumps(value))
            with final_authority(values), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release_reuse.main(args), 0)
                mixed = copy.deepcopy(values["artifacts"])
                mixed["artifacts"][0]["created_at"] = "2026-10-17T01:05:00Z"
                (root / "artifacts.json").write_text(json.dumps(mixed))
                with self.assertRaisesRegex(ValueError, "attempt attribution"):
                    release_reuse.main(args)
                mixed["artifacts"][0].pop("created_at")
                (root / "artifacts.json").write_text(json.dumps(mixed))
                with self.assertRaises(ValueError):
                    release_reuse.main(args)
            (root / "artifacts.json").write_text(json.dumps(values["artifacts"]))
            for changed in (dict(values["run"], status="in_progress", conclusion=None),
                            dict(values["run"], conclusion="failure")):
                with final_authority(values, latest=changed):
                    with self.assertRaisesRegex(ValueError, "latest attempt"):
                        release_reuse.main(args)

    def test_signing_rerun_requires_fresh_sbom_snapshot_and_current_qualification_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args, values = self.signed_fixture(root)
            values["run"] = dict(candidate_run(), id=67890, head_branch=f"v{BASE_VERSION}", run_attempt=2,
                                 run_started_at="2026-10-17T02:00:00Z", updated_at="2026-10-17T02:10:00Z",
                                 display_title=release_reuse.release_title("sign", BASE_VERSION, SOURCE_SHA, "810"))
            names = release_reuse.required_candidate_artifacts(2)
            names -= {f"native-receipt-{platform}-{track}-attempt-2" for platform in release_reuse.SHIPPING_PLATFORMS for track in release_reuse.NATIVE_TRACKS}
            names |= {"release-selection-attempt-2", *(f"sbom-{platform}-attempt-2" for platform in release_reuse.SHIPPING_PLATFORMS),
                      *(f"signed-consumer-{platform}-attempt-2" for platform in release_reuse.SHIPPING_PLATFORMS)}
            values["artifacts"] = {"artifacts": [{"id": 3000 + index, "name": name, "expired": False,
                                                 "created_at": "2026-10-17T02:05:00Z",
                                                 "workflow_run": {"id": 67890, "head_sha": SOURCE_SHA}}
                                                for index, name in enumerate(sorted(names))]}
            for receipt in values["signed_consumers"].values():
                receipt["run_attempt"] = 2
            for name, value in values.items():
                (root / f"{name}.json").write_text(json.dumps(value))
            args[args.index("--run-id") + 1] = "67890"
            args[args.index("--phase") + 1] = "sign"
            qualified = dict(candidate_run("f" * 40), display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"))
            with final_authority(values, qualified=qualified), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(release_reuse.main(args), 0)
                mixed = copy.deepcopy(values["artifacts"])
                next(row for row in mixed["artifacts"] if row["name"].startswith("sbom-"))["created_at"] = "2026-10-17T01:05:00Z"
                (root / "artifacts.json").write_text(json.dumps(mixed))
                with self.assertRaises(ValueError):
                    release_reuse.main(args)
                mixed = copy.deepcopy(values["artifacts"])
                next(row for row in mixed["artifacts"] if row["name"].startswith("signed-consumer-"))["created_at"] = "2026-10-17T01:05:00Z"
                (root / "artifacts.json").write_text(json.dumps(mixed))
                with self.assertRaises(ValueError):
                    release_reuse.main(args)
            (root / "artifacts.json").write_text(json.dumps(values["artifacts"]))
            for changed in (dict(qualified, run_attempt=2, status="in_progress", conclusion=None),
                            dict(qualified, run_attempt=2, conclusion="failure"), dict(qualified, run_attempt=2)):
                with final_authority(values, qualified=changed):
                    with self.assertRaises(ValueError):
                        release_reuse.main(args)

    def test_native_dispatch_pins_api_version_and_refuses_missing_or_ambiguous_run_details(self) -> None:
        payload = {"workflow_run_id": 12345, "run_url": f"https://api.github.com/repos/{REPOSITORY}/actions/runs/12345",
                   "html_url": f"https://github.com/{REPOSITORY}/actions/runs/12345"}
        positive = "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n" + json.dumps(payload)
        response = release_reuse.subprocess.CompletedProcess([], 0, positive, "")
        with patch.object(release_reuse.subprocess, "run", return_value=response) as invoke:
            self.assertEqual(release_reuse._native_dispatch(REPOSITORY, "release.yml", "main", {"sha": SOURCE_SHA}), RUN_ID)
            self.assertIn("X-GitHub-Api-Version: 2026-03-10", invoke.call_args.args[0])
            self.assertEqual(json.loads(invoke.call_args.kwargs["input"]), {"ref": "main", "inputs": {"sha": SOURCE_SHA}})
        invalid = [
            "HTTP/2.0 204 No Content\r\n\r\n",
            "not-http 200\n\n" + json.dumps(payload),
            "HTTP/2.0 201 Created\n\n" + json.dumps(payload),
            "HTTP/2.0 200 OK\r\n\r\n{}",
            "HTTP/2.0 200 OK\r\n\r\n" + json.dumps(dict(payload, workflow_run_id=True)),
            "HTTP/2.0 200 OK\r\n\r\n" + json.dumps(dict(payload, workflow_run_id="12345")),
            "HTTP/2.0 200 OK\r\n\r\n" + json.dumps(dict(payload, workflow_run_id=0)),
            "HTTP/2.0 200 OK\r\n\r\n" + json.dumps(dict(payload, run_url="https://example.invalid/not-this-run")),
            "HTTP/2.0 200 OK\r\n\r\n" + json.dumps(payload)[:-1] + ',"workflow_run_id":999}',
            "HTTP/2.0 200 OK\r\n\r\nnot-json",
        ]
        for output in invalid:
            with patch.object(release_reuse.subprocess, "run", return_value=release_reuse.subprocess.CompletedProcess([], 0, output, "")):
                with self.assertRaises(ValueError):
                    release_reuse._native_dispatch(REPOSITORY, "release.yml", "main", {"sha": SOURCE_SHA})

    def test_owner_artifacts_preserve_authority_after_completion_but_reject_foreign_attempts(self) -> None:
        allocation, bound, notes = owner_fixture()
        owner = dict(candidate_run("e" * 40), id=810, path=release_reuse.OWNER_WORKFLOW,
                     event="workflow_run", created_at="2026-10-17T00:50:00Z", run_started_at="2026-10-17T00:50:00Z",
                     updated_at="2026-10-17T01:20:00Z")
        artifacts = [
            {"id": 900, "name": "release-allocation-1", "expired": False, "created_at": "2026-10-17T00:55:00Z",
             "workflow_run": {"id": 810, "head_sha": "e" * 40}},
            {"id": 901, "name": "release-qualification-1", "expired": False, "created_at": "2026-10-17T01:01:00Z",
             "workflow_run": {"id": 810, "head_sha": "e" * 40}},
        ]
        def api(repository, endpoint, **kwargs):
            if endpoint == "actions/runs/810/attempts/1":
                return owner
            if endpoint == f"actions/runs/{RUN_ID}":
                return candidate_run("f" * 40)
            return [{"artifacts": artifacts}]
        def download(repository, artifact, expected):
            if artifact["id"] == 900:
                return {"allocation.json": (json.dumps(allocation, sort_keys=True) + "\n").encode(), "release-notes.md": notes}
            return {"qualification.json": json.dumps(bound).encode()}
        with patch.object(release_reuse, "_api", side_effect=api), patch.object(release_reuse, "_artifact_files", side_effect=download), \
             patch.object(release_reuse, "_assert_main_execution"):
            self.assertEqual(release_reuse._load_owner_authority(REPOSITORY, "810", "1"), (allocation, bound, notes))
            for changed in (dict(owner, run_attempt=2), dict(owner, path=release_reuse.RELEASE_WORKFLOW),
                            dict(owner, repository={"full_name": "foreign/repository"})):
                with patch.object(release_reuse, "_api", return_value=changed):
                    with self.assertRaises(ValueError):
                        release_reuse._load_owner_authority(REPOSITORY, "810", "1")
            for field, value in (("expired", True), ("created_at", "2026-10-16T00:00:00Z"), ("created_at", None)):
                original = artifacts[0][field]
                artifacts[0][field] = value
                with self.assertRaises(ValueError):
                    release_reuse._load_owner_authority(REPOSITORY, "810", "1")
                artifacts[0][field] = original
            bound["allocation_artifact_id"] = "999"
            with self.assertRaises(ValueError):
                release_reuse._load_owner_authority(REPOSITORY, "810", "1")

    def test_intel_probe_uses_bound_q_not_workflow_h_and_rejects_wrong_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, values = self.final_fixture(root)
            values["artifacts"]["artifacts"].append({"id": 1500, "name": "candidate-darwin-x64-none-attempt-1",
                                                      "expired": False, "created_at": "2026-10-17T01:05:00Z",
                                                      "workflow_run": {"id": int(RUN_ID), "head_sha": "f" * 40}})
            (root / "artifacts.json").write_text(json.dumps(values["artifacts"]))
            args = argparse.Namespace(repository=REPOSITORY, event_run_id=RUN_ID, event_sha="f" * 40, event_attempt=1,
                                      run=str(root / "run.json"), proof=str(root / "proof.json"), index=str(root / "index.json"),
                                      artifacts=str(root / "artifacts.json"), omp_config=str(root / "omp-config.json"))
            with final_authority(values), patch.object(release_reuse, "_is_ancestor", return_value=True), \
                 contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(release_reuse._probe_source(args), 0)
                self.assertIn(f"source_sha={SOURCE_SHA}", output.getvalue())
                self.assertIn("has_probe=true", output.getvalue())
                args.event_sha = SOURCE_SHA
                with self.assertRaises(ValueError):
                    release_reuse._probe_source(args)





    def test_replayed_rehearsal_without_intel_is_an_explicit_nonshipping_skip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, values = self.final_fixture(root)
            values["proof"], values["index"] = candidate_proof_and_index()
            values["run"]["display_title"] = release_reuse.release_title("rehearse", BASE_VERSION, SOURCE_SHA, "810")
            values["artifacts"]["artifacts"] = [row for row in values["artifacts"]["artifacts"] if row["name"].startswith("unpublished-candidate-index")]
            for name, value in values.items():
                (root / f"{name}.json").write_text(json.dumps(value))
            args = argparse.Namespace(repository=REPOSITORY, event_run_id=RUN_ID, event_sha="f" * 40, event_attempt=1,
                                      run=str(root / "run.json"), proof=str(root / "proof.json"), index=str(root / "index.json"),
                                      artifacts=str(root / "artifacts.json"), omp_config=str(root / "omp-config.json"))
            with final_authority(values), patch.object(release_reuse, "_is_ancestor", return_value=True), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(release_reuse._probe_source(args), 0)
                self.assertIn("has_probe=false", output.getvalue())

    def test_dispatch_records_the_native_qualification_once_after_immutable_intent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            allocation, expected, notes = owner_fixture()
            plan = {"kind": "allocate", "source_sha": SOURCE_SHA, "version": BASE_VERSION, "base_tag": "v0.2.19",
                    "train_id": "810", "train_attempt": "1", "rehearsal": "false"}
            (root / "plan.json").write_text(json.dumps(plan))
            owner = dict(candidate_run("e" * 40), id=810, path=release_reuse.OWNER_WORKFLOW,
                         event="workflow_run", status="in_progress", created_at="2026-10-17T00:50:00Z", run_started_at="2026-10-17T00:50:00Z")
            artifact = {"id": 900, "name": "release-allocation-1", "expired": False, "created_at": "2026-10-17T00:55:00Z",
                        "workflow_run": {"id": 810, "head_sha": "e" * 40}}
            def api(repository, endpoint, **kwargs):
                if endpoint == "actions/artifacts/900":
                    return artifact
                if endpoint == "actions/runs/810/attempts/1":
                    return owner
                if endpoint == f"actions/runs/{RUN_ID}":
                    return dict(candidate_run("f" * 40), status="queued", conclusion=None)
                raise AssertionError(endpoint)
            native = {"workflow_run_id": int(RUN_ID), "run_url": f"https://api.github.com/repos/{REPOSITORY}/actions/runs/{RUN_ID}",
                      "html_url": f"https://github.com/{REPOSITORY}/actions/runs/{RUN_ID}"}
            response = release_reuse.subprocess.CompletedProcess([], 0, "HTTP/2.0 200 OK\n\n" + json.dumps(native), "")
            files = {"allocation.json": (json.dumps(allocation, sort_keys=True) + "\n").encode(), "release-notes.md": notes}
            args = argparse.Namespace(repository=REPOSITORY, plan=str(root / "plan.json"), allocation_artifact_id="900")
            with patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_artifact_files", return_value=files), \
                 patch.object(release_reuse.subprocess, "run", return_value=response) as invoke, \
                 patch.dict(os.environ, {"GITHUB_OUTPUT": str(root / "outputs")}):
                self.assertEqual(release_reuse._dispatch_allocation(args), 0)
                actual = json.loads((root / "release-qualification/qualification.json").read_text())
                expected_raw = dict(expected)
                expected_raw.pop("qualification_head_sha")
                self.assertEqual(actual, expected_raw)
                with self.assertRaisesRegex(ValueError, "second qualification"):
                    release_reuse._dispatch_allocation(args)
                self.assertEqual(invoke.call_count, 1)

    def test_native_artifact_zip_reader_refuses_unexpected_or_oversized_members(self) -> None:
        for members, accepted in (({"allocation.json": b"{}", "release-notes.md": b"notes"}, True),
                                  ({"../allocation.json": b"{}", "release-notes.md": b"notes"}, False),
                                  ({"allocation.json": b"x" * (1024 * 1024 + 1), "release-notes.md": b"notes"}, False)):
            zipped = io.BytesIO()
            with zipfile.ZipFile(zipped, "w") as archive:
                for name, content in members.items():
                    archive.writestr(name, content)
            response = release_reuse.subprocess.CompletedProcess([], 0, zipped.getvalue(), b"")
            with patch.object(release_reuse.subprocess, "run", return_value=response):
                if accepted:
                    self.assertEqual(release_reuse._artifact_files(REPOSITORY, {"id": 900}, set(members)), members)
                else:
                    with self.assertRaises(ValueError):
                        release_reuse._artifact_files(REPOSITORY, {"id": 900}, {"allocation.json", "release-notes.md"})


    def test_failed_unowned_dispatch_cannot_poison_a_qualified_source(self) -> None:
        failed = dict(candidate_run("f" * 40), conclusion="failure")
        with patch.object(release_reuse, "_api", return_value=[{"artifacts": []}]):
            self.assertFalse(release_reuse._owned_failure(REPOSITORY, failed, SOURCE_SHA))
        artifact = {"id": 999, "name": "release-selection-attempt-1", "expired": False,
                    "created_at": "2026-10-17T01:05:00Z", "workflow_run": {"id": int(RUN_ID), "head_sha": "f" * 40}}
        def api(repository, endpoint, **kwargs):
            return failed if "/attempts/" in endpoint else [{"artifacts": [artifact]}]
        _, _, notes = owner_fixture()
        files = {"selection.json": json.dumps(selected_owner()).encode(), "release-notes.md": notes}
        with patch.object(release_reuse, "_api", side_effect=api), \
             patch.object(release_reuse, "_artifact_files", return_value=files), \
             patch.object(release_reuse, "_load_owner_authority", return_value=owner_fixture()):
            self.assertTrue(release_reuse._owned_failure(REPOSITORY, failed, SOURCE_SHA))

    def test_signer_retry_order_uses_actual_attempt_start_not_old_creation_id(self) -> None:
        old_id_retry = dict(candidate_run(), id=100, run_attempt=2, run_started_at="2026-10-17T02:00:00Z")
        later_id_old_attempt = dict(candidate_run(), id=200, run_started_at="2026-10-17T01:30:00Z")
        self.assertIs(max([later_id_old_attempt, old_id_retry], key=release_reuse._attempt_order), old_id_retry)
        latest_failed = dict(later_id_old_attempt, run_attempt=2, run_started_at="2026-10-17T03:00:00Z", conclusion="failure")
        self.assertIs(max([old_id_retry, latest_failed], key=release_reuse._attempt_order), latest_failed)


    def test_allocation_version_floor_reads_immutable_admission_main_not_stale_tools_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            def git(*args):
                result = release_reuse.subprocess.run(["git", "-C", str(root), *args], text=True,
                                                     stdout=release_reuse.subprocess.PIPE, stderr=release_reuse.subprocess.PIPE,
                                                     timeout=30, env=environment)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()
            git("init", "-q")
            git("config", "user.name", "Admission Fixture")
            git("config", "user.email", "admission@example.invalid")
            git("config", "core.hooksPath", "/dev/null")
            git("config", "commit.gpgsign", "false")
            old = "## [Unreleased]\n\n## [0.2.31] - 2026-10-10\n"
            (root / "CHANGELOG.md").write_text(old)
            git("add", "CHANGELOG.md")
            git("commit", "-qm", "old control checkout")
            git("tag", "v0.2.39")
            (root / "CHANGELOG.md").write_text("## [Unreleased]\n\n## [0.2.40] - 2026-10-17\n")
            git("commit", "-qam", "new admission metadata")
            admission = git("rev-parse", "HEAD")
            (root / "CHANGELOG.md").write_text(old)
            command = ["sh", str(ROOT / "scripts/release-train.sh"), "next-version", "--changelog-ref", admission]
            result = release_reuse.subprocess.run(command, cwd=root, input="v0.2.39\n", text=True,
                                                 stdout=release_reuse.subprocess.PIPE, stderr=release_reuse.subprocess.PIPE,
                                                 timeout=30, env=environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "0.2.41")
            self.assertIn("max_changelog=0.2.40", result.stderr)
            self.assertEqual((root / "CHANGELOG.md").read_text(), old)


    def test_acknowledged_child_metadata_read_retries_only_with_a_bounded_unknown_window(self) -> None:
        producer = candidate_run("f" * 40)
        with patch.object(release_reuse, "_api", side_effect=[ValueError("HTTP 404"), {"id": int(RUN_ID), "head_sha": None}, producer]) as lookup, \
             patch.object(release_reuse.time, "sleep"):
            self.assertEqual(release_reuse._read_qualification_run(REPOSITORY, RUN_ID), producer)
            self.assertEqual(lookup.call_count, 3)
        with patch.object(release_reuse, "_api", side_effect=ValueError("HTTP 404")), \
             patch.object(release_reuse.time, "monotonic", side_effect=[0, 31]), \
             patch.object(release_reuse.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "unavailable native metadata"):
                release_reuse._read_qualification_run(REPOSITORY, RUN_ID)
            sleep.assert_not_called()

    def test_post_identity_is_persisted_even_when_immediate_child_metadata_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            allocation, canonical, notes = owner_fixture()
            plan = {"kind": "allocate", "source_sha": SOURCE_SHA, "version": BASE_VERSION, "base_tag": "v0.2.19",
                    "train_id": "810", "train_attempt": "1", "rehearsal": "false"}
            owner = dict(candidate_run("e" * 40), id=810, path=release_reuse.OWNER_WORKFLOW,
                         event="workflow_run", status="in_progress", run_started_at="2026-10-17T00:50:00Z")
            artifact = {"id": 900, "name": "release-allocation-1", "expired": False, "created_at": "2026-10-17T00:55:00Z",
                        "workflow_run": {"id": 810, "head_sha": "e" * 40}}
            reads = []
            def api(repository, endpoint, **kwargs):
                reads.append(endpoint)
                if endpoint == "actions/artifacts/900":
                    return artifact
                if endpoint == "actions/runs/810/attempts/1":
                    return owner
                raise ValueError("HTTP 404: newly dispatched run is not visible yet")
            files = {"allocation.json": (json.dumps(allocation, sort_keys=True) + "\n").encode(), "release-notes.md": notes}
            args = argparse.Namespace(repository=REPOSITORY, plan=str(root / "plan.json"), allocation_artifact_id="900")
            for fail_after_binding in (False, True):
                (root / "plan.json").write_text(json.dumps(plan))
                with patch.object(release_reuse, "_api", side_effect=api), \
                     patch.object(release_reuse, "_artifact_files", return_value=files), \
                     patch.object(release_reuse, "_native_dispatch", return_value=RUN_ID):
                    try:
                        if fail_after_binding:
                            with patch.object(release_reuse, "_store_plan", side_effect=OSError("observer state write failed")):
                                release_reuse._dispatch_allocation(args)
                        else:
                            release_reuse._dispatch_allocation(args)
                    except (ValueError, OSError):
                        pass
                bound_path = root / "release-qualification/qualification.json"
                self.assertTrue(bound_path.is_file(), "the acknowledged POST identity was lost before owner binding")
                bound = json.loads(bound_path.read_text())
                self.assertEqual(bound["qualification_run_id"], RUN_ID)
                self.assertEqual(bound["allocation_artifact_id"], canonical["allocation_artifact_id"])
            self.assertNotIn(f"actions/runs/{RUN_ID}", reads)

    def test_terminal_unbound_candidate_cannot_poison_recovery_but_inflight_binding_stays_conservative(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unbound = dict(candidate_run(), id=50000, status="in_progress", conclusion=None,
                           display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "888"))
            actual_unbound = dict(unbound, status="completed", conclusion="failure")
            bound = dict(candidate_run(), status="in_progress", conclusion=None,
                         display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"))
            binding_artifact = {"id": 901, "name": "release-qualification-1", "expired": False}
            def api(repository, endpoint, **kwargs):
                if endpoint == "actions/runs/50000":
                    return actual_unbound
                return [{"artifacts": [] if "/888/" in endpoint else [binding_artifact]}]
            def command(argv, **kwargs):
                if argv[:3] == ["git", "rev-parse", "--show-toplevel"]:
                    return str(root)
                if argv[:3] == ["git", "tag", "--list"]:
                    return "v0.2.19"
                if argv == ["git", "rev-parse", "origin/main"]:
                    return SOURCE_SHA
                raise AssertionError(argv)
            _, canonical, _ = owner_fixture()
            args = argparse.Namespace(repository=REPOSITORY, train_id="900", train_attempt="1", stage="prepare",
                                      requested="", version="", rehearsal="false", plan=str(root / "plan.json"), timeout=60)
            with patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_command", side_effect=command), \
                 patch.object(release_reuse, "_published", return_value={"v0.2.19"}), \
                 patch.object(release_reuse, "_is_ancestor", return_value=True), \
                 patch.object(release_reuse, "_run_rows", return_value=[unbound, bound]), \
                 patch.object(release_reuse, "_artifact_files", return_value={"qualification.json": json.dumps(canonical).encode()}), \
                 patch.object(release_reuse, "_load_owner_authority", return_value=owner_fixture()), \
                 patch.dict(os.environ, {"GITHUB_OUTPUT": str(root / "outputs")}):
                self.assertEqual(release_reuse._drive(args), 0)
                recorded = Path(args.plan).read_bytes()
                self.assertEqual(json.loads(recorded)["qualification_run_id"], RUN_ID)
                for status, conclusion in (("in_progress", None), ("completed", None), ("completed", "success")):
                    actual_unbound.update(status=status, conclusion=conclusion)
                    with self.assertRaises(ValueError):
                        release_reuse._drive(args)
                    self.assertEqual(Path(args.plan).read_bytes(), recorded)

    def test_terminal_failed_or_canceled_unbound_selection_is_not_failure_authority(self) -> None:
        owner = dict(candidate_run("e" * 40), id=810, path=release_reuse.OWNER_WORKFLOW, event="workflow_run",
                     run_started_at="2026-10-17T00:50:00Z", updated_at="2026-10-17T01:20:00Z")
        selected_artifact = {"id": 999, "name": "release-selection-attempt-1", "expired": False,
                             "created_at": "2026-10-17T01:05:00Z", "workflow_run": {"id": int(RUN_ID), "head_sha": "f" * 40}}
        intent = {"id": 900, "name": "release-allocation-1", "expired": False,
                  "created_at": "2026-10-17T00:55:00Z", "workflow_run": {"id": 810, "head_sha": "e" * 40}}
        _, _, notes = owner_fixture()
        for conclusion in ("failure", "cancelled"):
            failed = dict(candidate_run("f" * 40), conclusion=conclusion)
            def api(repository, endpoint, **kwargs):
                if endpoint == f"actions/runs/{RUN_ID}/artifacts?per_page=100":
                    return [{"artifacts": [selected_artifact]}]
                if endpoint == f"actions/runs/{RUN_ID}/attempts/1":
                    return failed
                if endpoint == f"actions/runs/{RUN_ID}":
                    return failed
                if endpoint == "actions/runs/810/attempts/1":
                    return owner
                return [{"artifacts": [intent]}]
            with patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_artifact_files", return_value={"selection.json": json.dumps(selected_owner()).encode(), "release-notes.md": notes}):
                self.assertFalse(release_reuse._owned_failure(REPOSITORY, failed, SOURCE_SHA))


    @contextlib.contextmanager
    def published_floor_case(self, *, orphan=False, with_published_tag=False,
                             unpublished_tag: str | None = None, tag_on_source=False, published_off_main=False,
                             signer_drift: str | None = None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native_run = release_reuse.subprocess.run
            environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            environment.update(RUNNER_TEMP=str(root), GITHUB_OUTPUT=str(root / "outputs"), GIT_NO_LAZY_FETCH="1",
                               GIT_DIR=str(root / ".git"), GIT_WORK_TREE=str(root), PWD=str(root))
            def git(*args):
                result = native_run(["git", "-C", str(root), *args], env=environment, text=True,
                                    stdout=release_reuse.subprocess.PIPE, stderr=release_reuse.subprocess.PIPE, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()
            git("init", "-q", "--initial-branch=main")
            git("config", "user.name", "Published Floor Fixture")
            git("config", "user.email", "published-floor@example.invalid")
            git("config", "core.hooksPath", "/dev/null")
            git("config", "commit.gpgsign", "false")
            (root / ".github/workflows").mkdir(parents=True)
            for name in (".github/workflows/release.yml", ".github/workflows/ci.yml",
                         "scripts/release_reuse.py", "scripts/native-candidate.py",
                         "tests/e2e/real-home-journey.sh"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("# ROLLING-RELEASE-V3: fixture protocol\n")
            (root / "package.json").write_text(json.dumps({"name": "admission-fixture", "version": "0.2.19", "omp": {"version": "0.2.19"}}))
            (root / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n\n## [0.2.19] - 2026-10-17\n\n- Earlier note.\n")
            git("add", ".")
            git("commit", "-qm", "published baseline")
            git("tag", "v0.2.19")
            if with_published_tag:
                if published_off_main:
                    tree = git("rev-parse", "HEAD^{tree}")
                    detached = git("commit-tree", tree, "-m", "off-main published fixture")
                    git("tag", "v0.2.22", detached)
                else:
                    git("tag", "v0.2.22")
            if unpublished_tag and not tag_on_source:
                git("tag", unpublished_tag)
            (root / "changelog.d").mkdir()
            (root / "changelog.d/floor.md").write_text("- A new qualified source note.\n")
            git("add", ".")
            git("commit", "-qm", "eligible source")
            source = git("rev-parse", "HEAD")
            if signer_drift is not None:
                (root / signer_drift).write_text("# ROLLING-RELEASE-V3: changed signer, unchanged label\n")
                git("add", signer_drift)
                git("commit", "-qm", "signing implementation advanced beyond green source")
            owner = git("rev-parse", "HEAD")
            if unpublished_tag and tag_on_source:
                git("tag", unpublished_tag)
            git("update-ref", "refs/remotes/origin/main", owner)
            environment["GITHUB_SHA"] = owner
            stable = [{"tag_name": "v0.2.19", "draft": False, "prerelease": False}]
            if orphan or with_published_tag:
                stable.append({"tag_name": "v0.2.22", "draft": False, "prerelease": False})
            stable += [{"tag_name": "v0.2.99", "draft": True, "prerelease": False},
                       {"tag_name": "v0.2.98", "draft": False, "prerelease": True}]
            def api(repository, endpoint, **kwargs):
                if endpoint == "releases?per_page=100":
                    return [stable]
                if endpoint.startswith("actions/workflows/ci.yml/runs?"):
                    return [green_ci_runs(source)]
                if endpoint.startswith("actions/workflows/release.yml/runs?"):
                    return [{"workflow_runs": []}]
                raise AssertionError(endpoint)
            original_command = release_reuse._command
            def command(argv, **kwargs):
                return original_command(argv, cwd=str(root))
            def process(argv, **kwargs):
                if argv[0] == "git":
                    kwargs["cwd"] = str(root)
                return native_run(argv, **kwargs)
            args = argparse.Namespace(repository=REPOSITORY, train_id="900", train_attempt="1", stage="prepare",
                                      requested="", version="", rehearsal="false", plan=str(root / "plan.json"), timeout=60)
            with patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_command", side_effect=command), \
                 patch.object(release_reuse.subprocess, "run", side_effect=process), \
                 patch.object(release_reuse, "_native_dispatch") as dispatch, \
                 patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(io.StringIO()):
                yield args, root, source, dispatch

    def test_green_source_with_stale_signer_bytes_cannot_allocate_despite_unchanged_label(self) -> None:
        for path in (".github/workflows/release.yml", ".github/workflows/ci.yml",
                     "scripts/release_reuse.py", "scripts/native-candidate.py",
                     "tests/e2e/real-home-journey.sh"):
            with self.subTest(path=path), self.published_floor_case(signer_drift=path) as (args, root, _, dispatch):
                self.assertEqual(release_reuse._drive(args), 0)
                self.assertEqual(json.loads((root / "plan.json").read_text()), {"kind": "skip"})
                dispatch.assert_not_called()

    def test_unrelated_new_main_bytes_do_not_starve_the_latest_green_source(self) -> None:
        with self.published_floor_case(signer_drift="application.ts") as (args, root, source, dispatch):
            self.assertEqual(release_reuse._drive(args), 0)
            plan = json.loads((root / "plan.json").read_text())
            self.assertEqual(plan["kind"], "allocate")
            self.assertEqual(plan["source_sha"], source)
            dispatch.assert_not_called()

    def test_missing_published_tag_reserves_its_version_without_blocking_allocation(self) -> None:
        with self.published_floor_case(orphan=True) as (args, root, source, dispatch):
            self.assertEqual(release_reuse._drive(args), 0)
            plan = json.loads((root / "plan.json").read_text())
            self.assertEqual(plan["kind"], "allocate")
            self.assertEqual(plan["version"], "0.2.23")
            self.assertEqual(plan["source_sha"], source)
            self.assertEqual(plan["base_tag"], "v0.2.19")
            self.assertNotIn("v0.2.22", release_reuse._command(["git", "tag", "--list"]).splitlines())
            dispatch.assert_not_called()

    def test_published_version_floor_allows_new_allocation_once_its_tag_is_present(self) -> None:
        for tagged, expected in ((False, "0.2.20"), (True, "0.2.23")):
            with self.published_floor_case(with_published_tag=tagged) as (args, root, source, dispatch):
                self.assertEqual(release_reuse._drive(args), 0)
                plan = json.loads((root / "plan.json").read_text())
                self.assertEqual(plan["version"], expected)
                self.assertEqual(plan["source_sha"], source)
                self.assertEqual(plan["kind"], "allocate")
                dispatch.assert_not_called()

    def test_notes_floor_stays_bound_to_ci_source_after_main_publishes_a_descendant(self) -> None:
        with self.published_floor_case(with_published_tag=True, unpublished_tag="v0.2.47",
                                       tag_on_source=True) as (_, _, source, dispatch):
            tree = release_reuse._command(["git", "rev-parse", f"{source}^{{tree}}"])
            later = release_reuse._command(["git", "commit-tree", tree, "-p", source, "-m", "later publication"])
            release_reuse._command(["git", "update-ref", "refs/tags/v0.2.22", later])
            release_reuse._command(["git", "update-ref", "refs/remotes/origin/main", later])
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(release_reuse.main(["notes-floor", "--repository", REPOSITORY,
                                                    "--source-sha", source]), 0)
            self.assertEqual(output.getvalue().strip(), "v0.2.19")
            self.assertEqual(release_reuse._command(["git", "rev-parse", "HEAD"]), source)
            self.assertEqual(release_reuse._command(["git", "rev-parse", "v0.2.22"]), later)
            dispatch.assert_not_called()

    def test_unpublished_tags_reserve_versions_without_starving_qualified_source(self) -> None:
        for patch_number in (22, 47):
            for tag_on_source in (False, True):
                reserved = f"v0.2.{patch_number}"
                with self.subTest(tag=reserved, tag_on_source=tag_on_source), \
                     self.published_floor_case(unpublished_tag=reserved, tag_on_source=tag_on_source) as (args, root, source, dispatch):
                    before = release_reuse._command(["git", "rev-parse", reserved])
                    self.assertEqual(release_reuse._drive(args), 0)
                    plan = json.loads((root / "plan.json").read_text())
                    self.assertEqual(plan["kind"], "allocate")
                    self.assertEqual(plan["version"], f"0.2.{patch_number + 1}")
                    self.assertEqual(plan["source_sha"], source)
                    self.assertEqual(plan["base_tag"], "v0.2.19")
                    self.assertEqual(release_reuse._command(["git", "rev-parse", reserved]), before)
                    self.assertEqual(release_reuse._command(["git", "rev-parse", "HEAD"]), source)
                    dispatch.assert_not_called()

    def test_unpublished_high_tag_cannot_hide_authenticated_inflight_candidate(self) -> None:
        with self.published_floor_case(unpublished_tag="v0.2.47") as (args, root, _, dispatch):
            pending = dict(candidate_run(), status="in_progress", conclusion=None,
                           display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"))
            with patch.object(release_reuse, "_run_rows", return_value=[pending]), \
                 patch.object(release_reuse, "_find_owner_for_qualification", return_value=owner_fixture()):
                self.assertEqual(release_reuse._drive(args), 0)
            plan = json.loads((root / "plan.json").read_text())
            self.assertEqual(plan["kind"], "resume")
            self.assertEqual(plan["qualification_run_id"], RUN_ID)
            self.assertEqual(plan["version"], BASE_VERSION)
            dispatch.assert_not_called()

    def test_native_running_release_blocks_allocation_not_its_tag(self) -> None:
        for status in ("queued", "in_progress", "waiting", None):
            with self.subTest(status=status), \
                 self.published_floor_case(unpublished_tag="v0.2.22") as (args, root, _, dispatch):
                active = dict(candidate_run(), status=status, conclusion=None,
                              display_title="Unrecognized active release")
                with patch.object(release_reuse, "_run_rows", return_value=[active]):
                    with self.assertRaises(ValueError):
                        release_reuse._drive(args)
                self.assertFalse((root / "plan.json").exists())
                dispatch.assert_not_called()

    def test_unpublished_tag_with_no_qualified_source_skips_without_allocating(self) -> None:
        with self.published_floor_case(unpublished_tag="v0.2.22") as (args, root, _, dispatch), \
             patch.object(release_reuse, "select_source", return_value=None):
            self.assertEqual(release_reuse._drive(args), 0)
            self.assertEqual(json.loads((root / "plan.json").read_text()), {"kind": "skip"})
            dispatch.assert_not_called()

    def test_terminal_unbound_failures_do_not_lock_future_qualified_allocation(self) -> None:
        for conclusion in ("failure", "cancelled", "timed_out"):
            with self.subTest(conclusion=conclusion), \
                 self.published_floor_case(unpublished_tag="v0.2.22") as (args, root, source, dispatch):
                terminal = dict(candidate_run(source), conclusion=conclusion,
                                display_title="Unrecognized terminal release")
                with patch.object(release_reuse, "_run_rows", return_value=[terminal]):
                    self.assertEqual(release_reuse._drive(args), 0)
                plan = json.loads((root / "plan.json").read_text())
                self.assertEqual(plan["kind"], "allocate")
                self.assertEqual(plan["version"], "0.2.23")
                self.assertEqual(plan["source_sha"], source)
                dispatch.assert_not_called()

    def test_off_main_published_tag_does_not_hide_or_block_authenticated_recovery(self) -> None:
        for status in ("in_progress", "completed"):
            with self.subTest(status=status), \
                 self.published_floor_case(with_published_tag=True, published_off_main=True) as (args, root, source, dispatch):
                allocation, binding, notes = owner_fixture()
                allocation["source_sha"] = source
                binding["allocation_sha256"] = hashlib.sha256((json.dumps(allocation, sort_keys=True) + "\n").encode()).hexdigest()
                pending = dict(candidate_run(source), status=status, conclusion="success" if status == "completed" else None,
                               display_title=release_reuse.release_title("qualify", BASE_VERSION, source, "810"))
                dispatch.return_value = "67890"
                def runs(repository, workflow, event="workflow_dispatch"):
                    return [pending] if workflow == "release.yml" else []
                with patch.object(release_reuse, "_run_rows", side_effect=runs), \
                     patch.object(release_reuse, "_find_owner_for_qualification", return_value=(allocation, binding, notes)):
                    self.assertEqual(release_reuse._drive(args), 0)
                plan = json.loads((root / "plan.json").read_text())
                self.assertEqual(plan["kind"], "resume")
                self.assertEqual(plan["qualification_run_id"], RUN_ID)
                self.assertEqual(plan["version"], BASE_VERSION)
                self.assertEqual(release_reuse._promotion(argparse.Namespace(repository=REPOSITORY, source_sha=source, version=BASE_VERSION)), 0)

    def test_unpublished_reservation_cannot_block_qualified_promotion_or_latest(self) -> None:
        with self.published_floor_case(unpublished_tag="v0.2.47", tag_on_source=True) as (_, _, source, dispatch):
            args = argparse.Namespace(repository=REPOSITORY, source_sha=source, version=BASE_VERSION)
            self.assertEqual(release_reuse._promotion(args), 0)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(release_reuse._latest_flag(args), 0)
            self.assertEqual(output.getvalue().strip(), "--latest")
            dispatch.assert_not_called()

    def test_actual_newer_publication_still_prevents_version_and_latest_regression(self) -> None:
        with self.published_floor_case(with_published_tag=True) as (_, _, source, dispatch):
            args = argparse.Namespace(repository=REPOSITORY, source_sha=source, version=BASE_VERSION)
            with self.assertRaises(ValueError):
                release_reuse._promotion(args)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(release_reuse._latest_flag(args), 0)
            self.assertEqual(output.getvalue().strip(), "--latest=false")
            dispatch.assert_not_called()


class ExecutionCodeTrustTest(unittest.TestCase):
    @contextlib.contextmanager
    def authority_case(self, *, owner_off=False, qualification_off=False, source_later=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            native_run = release_reuse.subprocess.run
            def git(repo, *args):
                result = native_run(["git", "-C", str(repo), *args], text=True, stdout=release_reuse.subprocess.PIPE,
                                    stderr=release_reuse.subprocess.PIPE, timeout=30, env=environment)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()
            writer = root / "writer"
            writer.mkdir()
            git(writer, "init", "-q", "--initial-branch=main")
            git(writer, "config", "user.name", "Execution Trust Fixture")
            git(writer, "config", "user.email", "execution@example.invalid")
            git(writer, "config", "core.hooksPath", "/dev/null")
            git(writer, "config", "commit.gpgsign", "false")
            history = []
            for number in range(4):
                (writer / "code.txt").write_text(f"main code {number}\n")
                git(writer, "add", "code.txt")
                git(writer, "commit", "-qm", f"main {number}")
                history.append(git(writer, "rev-parse", "HEAD"))
            source, historical_owner, historical_qualification, tip = history
            base = source
            if source_later:
                source, historical_qualification = historical_qualification, tip
            git(writer, "checkout", "-q", "--detach", base)
            (writer / "code.txt").write_text("off-main malicious execution\n")
            git(writer, "commit", "-qam", "off-main code")
            off_main = git(writer, "rev-parse", "HEAD")
            git(writer, "checkout", "-q", "--detach", tip)
            git(writer, "tag", "main", off_main)
            remote, evil = root / "trusted.git", root / "evil.git"
            git(root, "clone", "-q", "--bare", str(writer), str(remote))
            git(root, "clone", "-q", "--bare", str(remote), str(evil))
            git(evil, "update-ref", "refs/heads/main", off_main)
            checkout = root / "checkout"
            checkout.mkdir()
            git(checkout, "init", "-q")
            if source_later:
                git(checkout, "fetch", "-q", "--depth=1", remote.as_uri(), source)
                git(checkout, "checkout", "-q", "--detach", source)
            else:
                git(checkout, "fetch", "-q", "--depth=1", remote.as_uri(), "refs/heads/main:refs/remotes/origin/main")
                git(checkout, "checkout", "-q", "--detach", tip)
            git(checkout, "fetch", "-q", "--no-tags", remote.as_uri(), "refs/tags/main:refs/tags/main")
            git(checkout, "remote", "add", "origin", evil.as_uri())
            self.assertEqual(git(checkout, "rev-parse", "--is-shallow-repository"), "true")
            self.assertEqual(git(checkout, "rev-parse", "refs/tags/main^{commit}"), off_main)
            self.assertEqual(git(remote, "rev-parse", "refs/heads/main^{commit}"), tip)
            owner_head = off_main if owner_off else historical_owner
            qualification_head = off_main if qualification_off else historical_qualification
            allocation, canonical, notes = owner_fixture()
            allocation.update(source_sha=source, owner_sha=owner_head)
            allocation_bytes = (json.dumps(allocation, sort_keys=True) + "\n").encode()
            canonical.update(allocation_sha256=hashlib.sha256(allocation_bytes).hexdigest(), qualification_head_sha=qualification_head)
            selected = dict(allocation, qualification_run_id=RUN_ID, qualification_attempt=1,
                            allocation_artifact_id="900", allocation_sha256=canonical["allocation_sha256"])
            owner = dict(candidate_run(owner_head), id=810, path=release_reuse.OWNER_WORKFLOW, event="workflow_run",
                         created_at="2026-10-17T00:50:00Z", run_started_at="2026-10-17T00:50:00Z",
                         updated_at="2026-10-17T01:20:00Z", conclusion="failure")
            producer = dict(candidate_run(qualification_head),
                            display_title=release_reuse.release_title("qualify", BASE_VERSION, source, "810"))
            artifacts = [{"id": 900, "name": "release-allocation-1", "expired": False, "created_at": "2026-10-17T00:55:00Z",
                          "workflow_run": {"id": 810, "head_sha": owner_head}},
                         {"id": 901, "name": "release-qualification-1", "expired": False, "created_at": "2026-10-17T01:01:00Z",
                          "workflow_run": {"id": 810, "head_sha": owner_head}}]
            def api(repository, endpoint, **kwargs):
                if endpoint == "actions/runs/810/attempts/1":
                    return owner
                if endpoint == f"actions/runs/{RUN_ID}":
                    return producer
                if endpoint == "actions/runs/810/artifacts?per_page=100":
                    return [{"artifacts": artifacts}]
                raise AssertionError(endpoint)
            def artifact_files(repository, artifact, expected):
                if artifact["id"] == 900:
                    return {"allocation.json": allocation_bytes, "release-notes.md": notes}
                return {"qualification.json": json.dumps(canonical).encode()}
            fetches = []
            def transport(argv, **kwargs):
                self.assertEqual(argv[0], "git", "No live service calls belong in this fixture")
                actual = list(argv)
                if "fetch" in actual:
                    fetches.append(list(actual))
                    canonical_url = f"https://github.com/{REPOSITORY}.git"
                    self.assertIn(canonical_url, actual, "Caller-controlled origin is not execution-code authority")
                    actual = [remote.as_uri() if value == canonical_url else value for value in actual]
                kwargs.update(cwd=str(checkout), env=environment)
                return native_run(actual, **kwargs)
            args = argparse.Namespace(repository=REPOSITORY, train_id="810", train_attempt="1", qualification_id=RUN_ID,
                                      qualification_attempt=1, source_sha=source, version=BASE_VERSION, base_tag="v0.2.19",
                                      output=str(root / "selection"), timeout=0)
            with patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_artifact_files", side_effect=artifact_files), \
                 patch.object(release_reuse.subprocess, "run", side_effect=transport), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                yield args, selected, notes, producer, checkout, tip, off_main, fetches

    def test_off_main_owner_with_main_label_and_legitimate_q_is_refused(self) -> None:
        with self.authority_case(owner_off=True) as (args, selected, notes, _, _, _, _, _):
            with self.assertRaisesRegex(ValueError, "refs/heads/main"):
                release_reuse._require_allocation(args)
            with self.assertRaisesRegex(ValueError, "refs/heads/main"):
                release_reuse._authorize_selection(REPOSITORY, selected, notes, args.source_sha, BASE_VERSION, "810")

    def test_off_main_qualification_with_main_label_and_legitimate_q_is_refused(self) -> None:
        with self.authority_case(qualification_off=True) as (args, selected, notes, _, _, _, _, _):
            with self.assertRaisesRegex(ValueError, "refs/heads/main"):
                release_reuse._require_allocation(args)
            with self.assertRaisesRegex(ValueError, "refs/heads/main"):
                release_reuse._authorize_selection(REPOSITORY, selected, notes, args.source_sha, BASE_VERSION, "810")

    def test_historical_main_execution_remains_authorized_after_owner_end_and_shallow_checkout(self) -> None:
        with self.authority_case(source_later=True) as (args, selected, notes, producer, checkout, tip, off_main, fetches):
            self.assertEqual(release_reuse._require_allocation(args), 0)
            self.assertEqual(release_reuse._authorize_selection(REPOSITORY, selected, notes, args.source_sha, BASE_VERSION, "810"), producer)
            result = release_reuse._command(["git", "rev-parse", "--is-shallow-repository"])
            self.assertEqual(result, "false")
            self.assertTrue(fetches)
            self.assertTrue(all(any(value.startswith("refs/heads/main:") for value in call) for call in fetches))
            self.assertNotEqual(tip, off_main)


class PublishedAssetsTest(unittest.TestCase):
    @contextlib.contextmanager
    def release_fixture(self, *, only_index=False, corrupt=None, race=None, deny_signature=False, consumer_failure=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = {}
            files = {}
            for platform in release_reuse.SHIPPING_PLATFORMS:
                archive_dir, sbom_dir = root / "archives" / platform, root / "sboms" / platform
                archive_dir.mkdir(parents=True)
                sbom_dir.mkdir(parents=True)
                name = f"omp-kit-v{BASE_VERSION}-{platform}.tar"
                content = f"certified fixture bytes for {platform}".encode()
                (archive_dir / name).write_bytes(content)
                files[name] = content
                assets[platform] = {"filename": name, "sha256": hashlib.sha256(content).hexdigest(),
                                    "manifest_sha256": "a" * 64}
                sbom = f"sbom-{platform}.spdx.json"
                files[sbom] = json.dumps({"fixture": platform}).encode()
                (sbom_dir / sbom).write_bytes(files[sbom])
            index = {"schema_version": 1, "version": BASE_VERSION, "source_tag": f"v{BASE_VERSION}", "assets": assets}
            files["release-index.json"] = json.dumps(index).encode()
            (root / "release-index.json").write_bytes(files["release-index.json"])
            _, _, owner_notes = owner_fixture()
            (root / "notes.md").write_bytes(owner_notes)
            (root / "binding.json").write_text(json.dumps(selected_owner()))
            qualified = dict(candidate_run("f" * 40), display_title=release_reuse.release_title("qualify", BASE_VERSION, SOURCE_SHA, "810"))
            producer = dict(candidate_run(), id=67890, head_branch=f"v{BASE_VERSION}",
                            display_title=release_reuse.release_title("sign", BASE_VERSION, SOURCE_SHA, "810"))
            (root / "producer.json").write_text(json.dumps(producer))
            remote = {name: {"id": 1000 + number, "name": name, "bytes": content}
                      for number, (name, content) in enumerate(files.items()) if not only_index or name == "release-index.json"}
            if corrupt:
                remote[corrupt]["bytes"] = b"!" * len(remote[corrupt]["bytes"])
            uploads = []
            attestations = []
            consumer_rows = []
            consumer_files = {}
            for number, platform in enumerate(release_reuse.SHIPPING_PLATFORMS):
                name = f"signed-consumer-{platform}-attempt-1"
                consumer_rows.append({"id": 3000 + number, "name": name, "expired": False,
                                      "created_at": "2026-10-17T01:05:00Z",
                                      "workflow_run": {"id": 67890, "head_sha": SOURCE_SHA}})
                receipt = {
                    "schema_version": 1, "kind": "signed-native-consumer", "platform": platform,
                    "version": BASE_VERSION, "source_sha": SOURCE_SHA,
                    "archive_sha256": assets[platform]["sha256"],
                    "index_sha256": hashlib.sha256(files["release-index.json"]).hexdigest(),
                    "run_id": "67890", "run_attempt": 1, "previous_version": "0.2.19",
                    "installed_version": BASE_VERSION, "checks": {"public_installer": True, "compiled_upgrade": True},
                }
                if consumer_failure == "noop":
                    receipt["checks"]["compiled_upgrade"] = False
                if consumer_failure == "foreign":
                    receipt["run_id"] = RUN_ID
                consumer_files[name] = {"receipt.json": json.dumps(receipt).encode()}
            if consumer_failure == "missing":
                consumer_rows.pop()
            def artifact_files(repository: str, artifact: dict[str, Any], expected: set[str]) -> dict[str, bytes]:
                self.assertEqual(expected, {"receipt.json"})
                return consumer_files[artifact["name"]]
            def api(repository, endpoint, **kwargs):
                if endpoint == "actions/runs/67890":
                    return producer
                if endpoint == "actions/runs/67890/artifacts?per_page=100":
                    return [{"artifacts": consumer_rows}]
                if endpoint == f"actions/runs/{RUN_ID}":
                    return qualified
                if endpoint == "releases?per_page=100":
                    return [[{"id": 55, "tag_name": f"v{BASE_VERSION}", "draft": False, "prerelease": False,
                              "body": owner_notes.decode()},
                             {"id": 54, "tag_name": "v0.2.19", "draft": False, "prerelease": False, "body": "previous"}]]
                if endpoint == f"commits/v{BASE_VERSION}":
                    return {"sha": SOURCE_SHA}
                if endpoint == "releases/55/assets?per_page=100":
                    return [[{"id": row["id"], "name": row["name"], "size": len(row["bytes"])} for row in remote.values()]]
                raise AssertionError(endpoint)
            def process(argv, **kwargs):
                if argv[:3] == ["gh", "attestation", "verify"]:
                    attestations.append(argv)
                    return release_reuse.subprocess.CompletedProcess(argv, 1 if deny_signature else 0, "", "invalid authority" if deny_signature else "")
                if argv[:3] == ["gh", "release", "upload"]:
                    self.assertNotIn("--clobber", argv)
                    path = Path(argv[4])
                    uploads.append(path.name)
                    content = path.read_bytes()
                    if race == "mismatch":
                        content = b"!" * len(content)
                    remote[path.name] = {"id": 2000 + len(uploads), "name": path.name, "bytes": content}
                    return release_reuse.subprocess.CompletedProcess(argv, 1 if race else 0, "", "upload race" if race else "")
                if argv[:2] == ["gh", "api"]:
                    asset_id = int(argv[-1].rsplit("/", 1)[1])
                    row = next(row for row in remote.values() if row["id"] == asset_id)
                    kwargs["stdout"].write(row["bytes"])
                    return release_reuse.subprocess.CompletedProcess(argv, 0, None, b"")
                raise AssertionError(argv)
            args = argparse.Namespace(repository=REPOSITORY, version=BASE_VERSION, source_sha=SOURCE_SHA,
                                      index=str(root / "release-index.json"), archives=str(root / "archives"),
                                      sboms=str(root / "sboms"), notes=str(root / "notes.md"), producer_run=str(root / "producer.json"),
                                      binding=str(root / "binding.json"))
            with patch.object(release_reuse, "_api", side_effect=api), \
                 patch.object(release_reuse, "_load_owner_authority", return_value=owner_fixture()), \
                 patch.object(release_reuse, "_artifact_files", side_effect=artifact_files), \
                 patch.object(release_reuse.subprocess, "run", side_effect=process), contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(io.StringIO()):
                yield args, files, remote, uploads, attestations

    def test_missing_failed_or_foreign_signed_consumer_refuses_even_complete_release_assets(self) -> None:
        for failure in ("missing", "noop", "foreign"):
            with self.subTest(failure=failure), self.release_fixture(consumer_failure=failure) as (args, _, _, uploads, _):
                with self.assertRaises(ValueError):
                    release_reuse._repair_release(args)
                self.assertEqual(uploads, [])

    def test_matching_index_alone_repairs_all_missing_certified_assets(self) -> None:
        with self.release_fixture(only_index=True) as (args, files, remote, uploads, attestations):
            self.assertEqual(release_reuse._repair_release(args), 0)
            self.assertEqual(set(uploads), set(files) - {"release-index.json"})
            self.assertEqual({name: row["bytes"] for name, row in remote.items()}, files)
            self.assertEqual(len(attestations), 4)
            for command in attestations:
                self.assertIn("--source-digest", command)
                self.assertIn(SOURCE_SHA, command)
                self.assertIn("https://token.actions.githubusercontent.com", command)

    def test_complete_release_rechecks_assets_and_authority_without_overwriting(self) -> None:
        with self.release_fixture() as (args, _, _, uploads, attestations):
            self.assertEqual(release_reuse._repair_release(args), 0)
            self.assertEqual(uploads, [])
            self.assertEqual(len(attestations), 4)

    def test_mismatched_existing_archive_index_or_sbom_refuses_before_repair(self) -> None:
        for corrupt in ("release-index.json", f"omp-kit-v{BASE_VERSION}-linux-arm64-gnu.tar", "sbom-linux-x64-gnu.spdx.json"):
            with self.release_fixture(corrupt=corrupt) as (args, _, _, uploads, _):
                with self.assertRaisesRegex(ValueError, "mismatches certified hash"):
                    release_reuse._repair_release(args)
                self.assertEqual(uploads, [])
        with self.release_fixture(only_index=True, deny_signature=True) as (args, _, _, uploads, _):
            with self.assertRaises(ValueError):
                release_reuse._repair_release(args)
            self.assertEqual(uploads, [])

    def test_no_clobber_upload_race_is_accepted_only_after_exact_reread(self) -> None:
        with self.release_fixture(only_index=True, race="matching") as (args, _, _, uploads, _):
            self.assertEqual(release_reuse._repair_release(args), 0)
            self.assertEqual(len(uploads), 6)
        with self.release_fixture(only_index=True, race="mismatch") as (args, _, _, uploads, _):
            with self.assertRaises(ValueError):
                release_reuse._repair_release(args)
            self.assertEqual(len(uploads), 1)
if __name__ == "__main__":
    unittest.main()
