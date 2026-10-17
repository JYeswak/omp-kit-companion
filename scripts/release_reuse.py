#!/usr/bin/env python3
"""Select qualified main sources and preserve exact release evidence through promotion."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import subprocess
import time
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote
import zipfile
import tempfile
from datetime import datetime

SHIPPING_PLATFORMS = (
    "darwin-arm64-none",
    "linux-arm64-gnu",
    "linux-x64-gnu",
)
NATIVE_TRACKS = ("minimum", "certified")
RELEASE_WORKFLOW = ".github/workflows/release.yml"
CI_WORKFLOW = ".github/workflows/ci.yml"
OWNER_WORKFLOW = ".github/workflows/release-train.yml"
ALLOCATION_PROTOCOL = "rolling-release-allocation-v1"


class UnboundQualification(ValueError):
    """No immutable native owner binding exists; this is never signing authority."""


def _git_sha(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 40 and all(
        char in "0123456789abcdef" for char in value
    )



def stable_version(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parts = value.split(".")
    return len(parts) == 3 and all(
        part.isascii() and part.isdigit() and (part == "0" or not part.startswith("0"))
        for part in parts
    )


def _sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        char in "0123456789abcdef" for char in value
    )


def has_green_main_ci(runs: Any, source_sha: str) -> bool:
    if not _git_sha(source_sha) or not isinstance(runs, dict):
        return False
    rows = runs.get("workflow_runs")
    if not isinstance(rows, list):
        return False
    exact = [
        row for row in rows if isinstance(row, dict)
        and row.get("path") == CI_WORKFLOW and row.get("event") == "push"
        and row.get("head_branch") == "main" and row.get("head_sha") == source_sha
    ]
    if not exact:
        return False
    # A later attempt supersedes an earlier green, never the other way around.
    latest = max(exact, key=lambda row: (int(row.get("run_number", 0)), int(row.get("id", 0)), int(row.get("run_attempt", 1))))
    return latest.get("status") == "completed" and latest.get("conclusion") == "success"


def required_candidate_artifacts(attempt: int = 1) -> set[str]:
    names = {"unpublished-candidate-index"}
    names.update(f"candidate-{platform}" for platform in SHIPPING_PLATFORMS)
    names.update(
        f"native-receipt-{platform}-{track}"
        for platform in SHIPPING_PLATFORMS
        for track in NATIVE_TRACKS
    )
    return {f"{name}-attempt-{attempt}" for name in names}


def _candidate_run_version(
    run: Any,
    artifacts: Any,
    *,
    requested_run_id: str,
    source_sha: str,
    base_version: str,
    repository: str,
) -> str | None:
    if (
        not _git_sha(source_sha)
        or not stable_version(base_version)
        or not requested_run_id.isascii()
        or not requested_run_id.isdigit()
    ):
        return None
    if not isinstance(run, dict):
        return None
    run_id = str(run.get("id", ""))
    if (
        run_id != requested_run_id
        or run.get("path") != RELEASE_WORKFLOW
        or run.get("event") != "workflow_dispatch"
        or run.get("head_branch") != "main"
        or run.get("head_sha") != source_sha
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("run_attempt") != 1
        or not isinstance(run.get("repository"), dict)
        or run["repository"].get("full_name") != repository
    ):
        return None
    if not isinstance(artifacts, dict) or not isinstance(artifacts.get("artifacts"), list):
        return None

    required = required_candidate_artifacts()
    found: set[str] = set()
    for artifact in artifacts["artifacts"]:
        if not isinstance(artifact, dict) or artifact.get("expired") is not False:
            continue
        metadata = artifact.get("workflow_run")
        if (
            not isinstance(metadata, dict)
            or str(metadata.get("id", "")) != run_id
            or metadata.get("head_sha") != source_sha
        ):
            continue
        name = artifact.get("name")
        if isinstance(name, str):
            found.add(name)
    if not required.issubset(found):
        return None
    try:
        _require_snapshot(run, artifacts, required)
    except ValueError:
        return None
    return f"{base_version}-rehearsal.{run_id}.1"


def _timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("native attempt/artifact timestamp is missing")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    if parsed.tzinfo is None:
        raise ValueError("native attempt timestamp has no timezone")
    return parsed


QUALIFICATION_DELIVERY_GRACE_SECONDS = 120


def _delivery_overdue(run: dict[str, Any]) -> bool:
    """True only when a completed run's own timestamp proves its workflow_run delivery had its grace. Unknown is not overdue."""
    try:
        finished = _timestamp(run.get("updated_at"))
    except ValueError:
        return False
    return (datetime.now(finished.tzinfo) - finished).total_seconds() >= QUALIFICATION_DELIVERY_GRACE_SECONDS


def _attempt_order(run: dict[str, Any]) -> tuple[datetime, int]:
    started = run.get("run_started_at")
    if run.get("status") == "completed" and not started:
        raise ValueError("completed signer has unknown native attempt attribution")
    return _timestamp(started or run.get("created_at")), int(run["id"])


def _artifact_in_attempt(artifact: dict[str, Any], run: dict[str, Any]) -> bool:
    try:
        created = _timestamp(artifact.get("created_at"))
        started = _timestamp(run.get("run_started_at"))
        return created >= started and (run.get("status") != "completed" or created <= _timestamp(run.get("updated_at")))
    except ValueError:
        return False


def _require_snapshot(run: dict[str, Any], artifacts: Any, required: set[str]) -> None:
    identities: set[int] = set()
    for name in required:
        rows = [row for row in artifacts.get("artifacts", []) if row.get("name") == name]
        if len(rows) != 1:
            raise ValueError("native artifact snapshot is missing or ambiguous")
        row = rows[0]
        if (type(row.get("id")) is not int or row["id"] in identities or row.get("expired") is not False
                or row.get("workflow_run", {}).get("id") != run.get("id")
                or row.get("workflow_run", {}).get("head_sha") != run.get("head_sha")
                or not _artifact_in_attempt(row, run)):
            raise ValueError("artifact snapshot has stale, mixed, unknown or foreign native attempt attribution")
        identities.add(row["id"])


def _current_attempt(repository: str, expected: dict[str, Any]) -> dict[str, Any]:
    current = _api(repository, f"actions/runs/{expected['id']}")
    keys = ("id", "path", "head_sha", "run_attempt", "run_started_at", "updated_at", "status", "conclusion")
    if (any(current.get(key) != expected.get(key) for key in keys)
            or current.get("status") != "completed" or current.get("conclusion") != "success"):
        raise ValueError("native producer now has a different/running/failed latest attempt")
    return current


def select_reuse(
    ci_runs: Any,
    candidate_run: Any,
    artifacts: Any,
    *,
    source_sha: str,
    base_version: str,
    requested_run_id: str,
    repository: str,
    ci_sha: str | None = None,
) -> dict[str, str]:
    # ci_sha is the parent of a pure release bump commit (scripts/release-train.sh
    # evidence-sha); the bump itself never has a push CI run.
    reuse_fast_ci = has_green_main_ci(ci_runs, ci_sha or source_sha)
    candidate_version = ""
    candidate_run_id = ""
    if reuse_fast_ci and requested_run_id:
        version = _candidate_run_version(
            candidate_run,
            artifacts,
            requested_run_id=requested_run_id,
            source_sha=source_sha,
            base_version=base_version,
            repository=repository,
        )
        if version is not None:
            candidate_run_id = requested_run_id
            candidate_version = version
    return {
        "reuse_fast_ci": str(reuse_fast_ci).lower(),
        "candidate_run_id": candidate_run_id,
        "candidate_version": candidate_version,
    }


def candidate_index_matches(
    proof: Any,
    index: Any,
    *,
    source_sha: str,
    base_version: str,
    run_id: str,
    omp_versions: Any,
    final_version: str | None = None,
) -> bool:
    if not isinstance(proof, dict) or not isinstance(index, dict):
        return False
    if (
        not _git_sha(source_sha)
        or not stable_version(base_version)
        or not run_id.isascii()
        or not run_id.isdigit()
    ):
        return False
    if not isinstance(omp_versions, dict) or set(omp_versions) != set(NATIVE_TRACKS):
        return False
    certified = proof.get("certified_platforms")
    assets = index.get("assets")
    if (
        not isinstance(certified, list)
        or any(not isinstance(platform, str) for platform in certified)
        or not isinstance(assets, dict)
    ):
        return False
    expected_version = final_version or f"{base_version}-rehearsal.{run_id}.1"
    platforms = set(SHIPPING_PLATFORMS)
    if (
        proof.get("schema_version") != 1
        or proof.get("source_sha") != source_sha
        or proof.get("version") != expected_version
        or len(certified) != len(SHIPPING_PLATFORMS) or set(certified) != platforms
        or proof.get("omp_versions") != omp_versions
        or proof.get("platform_omp_versions")
        != {platform: omp_versions for platform in SHIPPING_PLATFORMS}
        or proof.get("publication") != "NOT_AUTHORIZED"
        or index.get("schema_version") != 1
        or index.get("version") != expected_version
        or index.get("source_tag") != f"v{expected_version}"
        or set(assets) != platforms
    ):
        return False
    for platform in SHIPPING_PLATFORMS:
        asset = assets.get(platform)
        if (
            not isinstance(asset, dict)
            or not isinstance(asset.get("filename"), str)
            or not asset["filename"]
            or Path(asset["filename"]).name != asset["filename"]
            or not _sha256(asset.get("sha256"))
            or not _sha256(asset.get("manifest_sha256"))
        ):
            return False
    return True


def archive_matches_index(index: Any, platform: str, archive_dir: Path) -> bool:
    if platform not in SHIPPING_PLATFORMS or not isinstance(index, dict):
        return False
    assets = index.get("assets")
    asset = assets.get(platform) if isinstance(assets, dict) else None
    if not isinstance(asset, dict):
        return False
    filename = asset.get("filename")
    expected = asset.get("sha256")
    if (
        not isinstance(filename, str)
        or not filename
        or Path(filename).name != filename
        or not _sha256(expected)
    ):
        return False
    archive = archive_dir / filename
    if not archive.is_file():
        return False
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == expected


def _read_json(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write_outputs(values: dict[str, str]) -> None:
    for key, value in values.items():
        if "\n" in value or "\r" in value:
            raise ValueError(f"unsafe workflow output for {key}")
        print(f"{key}={value}")


def _preflight(args: argparse.Namespace) -> int:
    ci_runs = _read_json(args.ci_runs)
    candidate_run = _read_json(args.candidate_run) if args.candidate_run else None
    artifacts = _read_json(args.artifacts) if args.artifacts else None
    values = select_reuse(
        ci_runs,
        candidate_run,
        artifacts,
        source_sha=args.source_sha,
        base_version=args.base_version,
        requested_run_id=args.requested_run_id,
        repository=args.repository,
        ci_sha=args.ci_sha or None,
    )
    if values["reuse_fast_ci"] != "true":
        print("No successful main push CI exists for this exact SHA; running the full candidate matrix.", file=sys.stderr)
    elif args.requested_run_id and not values["candidate_run_id"]:
        print("Prior candidate is not reusable; running a fresh full candidate.", file=sys.stderr)
    _write_outputs(values)
    return 0


def _validate_index(args: argparse.Namespace) -> int:
    run_id = args.run_id
    values = {"run_id": "", "version": ""}
    if run_id:
        try:
            valid = candidate_index_matches(
                _read_json(args.proof),
                _read_json(args.index),
                source_sha=args.source_sha,
                base_version=args.base_version,
                run_id=run_id,
                omp_versions=_read_json(args.omp_config),
            )
        except (OSError, json.JSONDecodeError):
            valid = False
        if not valid:
            print("Prior candidate proof does not match the current SHA/version/tracks; use a fresh candidate.", file=sys.stderr)
            _write_outputs(values)
            return 1
        values = {
            "run_id": run_id,
            "version": f"{args.base_version}-rehearsal.{run_id}.1",
        }
    _write_outputs(values)
    return 0


def _verify_archive(args: argparse.Namespace) -> int:
    index = _read_json(args.index)
    if not archive_matches_index(index, args.platform, Path(args.archive_dir)):
        print(f"candidate archive hash mismatch for {args.platform}", file=sys.stderr)
        return 1
    print(f"verified candidate archive hash for {args.platform}")
    return 0


def select_source(runs: Any, history: list[str], requested: str = "") -> str:
    """History is newest-first main ancestry above the already-promoted floor."""
    if any(not _git_sha(sha) for sha in history):
        raise ValueError("invalid main history")
    if requested and (not _git_sha(requested) or requested not in history):
        raise ValueError("requested source is outside unreleased main history")
    for sha in history:
        if has_green_main_ci(runs, sha):
            if requested and sha != requested:
                raise ValueError("requested source is superseded by a newer qualified source")
            return sha
    return ""


def release_title(phase: str, version: str, sha: str, train_id: str) -> str:
    if phase not in ("qualify", "sign", "rehearse") or not stable_version(version) or not _git_sha(sha) or not train_id.isascii() or not train_id.isdigit():
        raise ValueError("invalid rolling candidate identity")
    return f"{phase} {version} {sha} train-{train_id}"


def final_run_matches(run: Any, *, repository: str, source_sha: str, version: str, train_id: str, phase: str) -> bool:
    return (
        isinstance(run, dict)
        and run.get("path") == RELEASE_WORKFLOW
        and run.get("event") == "workflow_dispatch"
        and run.get("repository", {}).get("full_name") == repository
        and run.get("status") == "completed" and run.get("conclusion") == "success"
        and type(run.get("run_attempt")) is int and run["run_attempt"] >= 1
        and run.get("display_title") == release_title(phase, version, source_sha, train_id)
        and (run.get("head_branch") == "main" if phase == "qualify"
             else run.get("head_branch") == f"v{version}" and run.get("head_sha") == source_sha)
    )


def selection_matches(binding: Any, notes: bytes, *, source_sha: str, version: str, train_id: str) -> bool:
    return (
        isinstance(binding, dict) and binding.get("schema_version") == 1
        and binding.get("source_sha") == source_sha and binding.get("version") == version
        and binding.get("train_run_id") == train_id
        and isinstance(binding.get("base_tag"), str) and binding["base_tag"].startswith("v")
        and stable_version(binding["base_tag"][1:])
        and bool(notes.strip()) and binding.get("notes_sha256") == hashlib.sha256(notes).hexdigest()
    )

def _artifact_files(repository: str, artifact: dict[str, Any], expected: set[str]) -> dict[str, bytes]:
    result = subprocess.run(["gh", "api", f"repos/{repository}/actions/artifacts/{artifact['id']}/zip"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if result.stderr:
        print(result.stderr.decode(errors="replace"), end="", file=sys.stderr)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        raise ValueError("owner artifact download failed or exceeded its bounded envelope")
    with zipfile.ZipFile(io.BytesIO(result.stdout)) as archive:
        entries = archive.infolist()
        if (len(entries) != len(expected) or {entry.filename for entry in entries} != expected
                or any(entry.file_size > 1024 * 1024 for entry in entries)):
            raise ValueError("owner artifact has an unexpected, duplicate or oversized member")
        return {entry.filename: archive.read(entry) for entry in entries}


def _owner_artifact(artifacts: list[dict[str, Any]], name: str, owner: dict[str, Any]) -> dict[str, Any] | None:
    matches = [row for row in artifacts if row.get("name") == name]
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError("owner authority artifact name is ambiguous")
    row = matches[0]
    if (row.get("expired") is not False
            or row.get("workflow_run", {}).get("id") != owner.get("id")
            or row.get("workflow_run", {}).get("head_sha") != owner.get("head_sha")
            or not _artifact_in_attempt(row, owner)):
        raise ValueError("owner authority artifact is expired or has different native run provenance")
    return row


def owner_allocation_matches(allocation: Any, qualification: Any, selection: Any, notes: bytes,
                             *, qualification_id: str, qualification_attempt: int) -> bool:
    if not isinstance(allocation, dict) or not isinstance(qualification, dict) or not isinstance(selection, dict):
        return False
    expected = dict(allocation, qualification_run_id=qualification.get("qualification_run_id"),
                    allocation_artifact_id=qualification.get("allocation_artifact_id"),
                    allocation_sha256=qualification.get("allocation_sha256"), qualification_attempt=qualification_attempt)
    return (
        allocation.get("protocol") == ALLOCATION_PROTOCOL
        and allocation.get("rehearsal") is False
        and allocation.get("qualification_attempt_policy") == "same-native-run"
        and selection == expected
        and qualification.get("schema_version") == 1
        and qualification.get("train_run_id") == allocation.get("train_run_id")
        and qualification.get("train_attempt") == allocation.get("train_attempt")
        and qualification.get("qualification_run_id") == qualification_id
        and qualification.get("qualification_minimum_attempt") == 1
        and type(qualification_attempt) is int and qualification_attempt >= 1
        and selection_matches(allocation, notes, source_sha=str(selection.get("source_sha", "")),
                              version=str(selection.get("version", "")), train_id=str(selection.get("train_run_id", "")))
    )


def _assert_main_execution(repository: str, *executions: str) -> None:
    """Trust code by real main history, never by ambiguous run/ref labels."""
    ref = "refs/remotes/release-train/authority-main"
    git = ["git", "--no-replace-objects"]
    shallow = _command([*git, "rev-parse", "--is-shallow-repository"])
    if shallow not in ("true", "false"):
        raise ValueError("cannot determine whether actual main history is complete")
    fetch = [*git, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
             "fetch", "--no-tags"]
    if shallow == "true":
        fetch.append("--unshallow")
    # Use the expected repository, not caller-controlled origin, and an exact
    # branch ref; a tag called main is neither branch identity nor code trust.
    _command([*fetch, "--", f"https://github.com/{repository}.git", f"refs/heads/main:{ref}"])
    if _command([*git, "rev-parse", "--is-shallow-repository"]) != "false":
        raise ValueError("actual refs/heads/main history remains incomplete after fetch")
    tip = _command([*git, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"])
    if not _git_sha(tip):
        raise ValueError("actual refs/heads/main did not resolve to a full commit SHA")
    for execution in executions:
        if not _git_sha(execution) or not _is_ancestor(execution, tip):
            raise ValueError(f"execution code {execution} is outside actual refs/heads/main")


def _read_qualification_run(repository: str, run_id: str, timeout: int = 30) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    failure: Exception | None = None
    while True:
        try:
            producer = _api(repository, f"actions/runs/{run_id}")
            if isinstance(producer, dict) and str(producer.get("id")) == run_id and _git_sha(producer.get("head_sha")):
                return producer
            failure = ValueError("native qualification metadata is incomplete")
        except (ValueError, subprocess.SubprocessError) as error:
            failure = error
        if time.monotonic() >= deadline:
            raise ValueError(f"acknowledged qualification {run_id} has unavailable native metadata") from failure
        time.sleep(2)


def _load_owner_authority(repository: str, train_id: str, attempt: str, *, timeout: int = 0) -> tuple[dict[str, Any], dict[str, Any], bytes]:
    if not train_id.isascii() or not train_id.isdigit() or not attempt.isascii() or not attempt.isdigit() or int(attempt) < 1:
        raise ValueError("owner run and attempt must be explicit native identities")
    owner = _api(repository, f"actions/runs/{train_id}/attempts/{attempt}")
    if (str(owner.get("id")) != train_id or owner.get("run_attempt") != int(attempt)
            or owner.get("repository", {}).get("full_name") != repository
            or owner.get("path") != OWNER_WORKFLOW or owner.get("head_branch") != "main"
            or owner.get("event") not in ("workflow_run", "workflow_dispatch")):
        raise ValueError("allocation issuer is not this repository's exact main train run/attempt")
    deadline = time.monotonic() + timeout
    while True:
        pages = _api(repository, f"actions/runs/{train_id}/artifacts?per_page=100", paginate=True)
        rows = [row for page in pages for row in page["artifacts"]]
        intent = _owner_artifact(rows, f"release-allocation-{attempt}", owner)
        bound = _owner_artifact(rows, f"release-qualification-{attempt}", owner)
        if intent is not None and bound is not None:
            break
        if time.monotonic() >= deadline:
            raise UnboundQualification("immutable owner allocation/qualification binding is missing; do not infer authority from a candidate title")
        time.sleep(3)
    intent_files = _artifact_files(repository, intent, {"allocation.json", "release-notes.md"})
    bound_files = _artifact_files(repository, bound, {"qualification.json"})
    allocation = json.loads(intent_files["allocation.json"])
    qualification = json.loads(bound_files["qualification.json"])
    if (not isinstance(allocation, dict) or not isinstance(qualification, dict)
            or not isinstance(qualification.get("qualification_run_id"), str)
            or not qualification["qualification_run_id"].isascii() or not qualification["qualification_run_id"].isdigit()
            or int(qualification["qualification_run_id"]) < 1):
        raise ValueError("owner authority has unknown native qualification identity")
    if (allocation.get("schema_version") != 1 or allocation.get("protocol") != ALLOCATION_PROTOCOL
            or allocation.get("repository") != repository or allocation.get("owner_sha") != owner.get("head_sha")
            or allocation.get("train_run_id") != train_id or allocation.get("train_attempt") != attempt
            or qualification.get("allocation_artifact_id") != str(intent["id"])
            or qualification.get("allocation_sha256") != hashlib.sha256(intent_files["allocation.json"]).hexdigest()):
        raise ValueError("owner allocation or canonical dispatch binding differs from native artifact provenance")
    producer = _read_qualification_run(repository, qualification["qualification_run_id"])
    if (producer.get("path") != RELEASE_WORKFLOW or producer.get("event") != "workflow_dispatch"
            or producer.get("repository", {}).get("full_name") != repository or producer.get("head_branch") != "main"):
        raise ValueError("canonical qualification has different native repository/workflow/ref identity")
    if qualification.get("qualification_head_sha") not in (None, producer["head_sha"]):
        raise ValueError("canonical qualification execution head differs from its native run")
    # The POST ID is immutable authority. Code identity is independently read
    # from that native run after binding delivery, not needed to persist it.
    qualification = dict(qualification, qualification_head_sha=producer["head_sha"])
    _assert_main_execution(repository, owner["head_sha"], qualification["qualification_head_sha"], allocation["source_sha"])
    return allocation, qualification, intent_files["release-notes.md"]


def _require_allocation(args: argparse.Namespace) -> int:
    allocation, qualification, notes = _load_owner_authority(args.repository, args.train_id, args.train_attempt, timeout=args.timeout)
    producer = _api(args.repository, f"actions/runs/{args.qualification_id}")
    if (producer.get("id") != int(args.qualification_id) or producer.get("run_attempt") != args.qualification_attempt
            or producer.get("path") != RELEASE_WORKFLOW or producer.get("event") != "workflow_dispatch"
            or producer.get("repository", {}).get("full_name") != args.repository
            or producer.get("head_branch") != "main" or producer.get("head_sha") != qualification.get("qualification_head_sha")):
        raise ValueError("qualification's native producer attempt/head differs from the owner's canonical dispatch")
    selection = dict(allocation, qualification_run_id=qualification.get("qualification_run_id"),
                     allocation_artifact_id=qualification.get("allocation_artifact_id"),
                     allocation_sha256=qualification.get("allocation_sha256"), qualification_attempt=args.qualification_attempt)
    if (allocation.get("source_sha") != args.source_sha or allocation.get("version") != args.version
            or allocation.get("base_tag") != args.base_tag
            or not owner_allocation_matches(allocation, qualification, selection, notes,
                                             qualification_id=args.qualification_id, qualification_attempt=args.qualification_attempt)):
        raise ValueError("qualification does not own this allocated source/version/notes floor/native run")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "selection.json").write_text(json.dumps(selection, sort_keys=True) + "\n")
    (output / "release-notes.md").write_bytes(notes)
    print(f"ALLOCATION=authorized owner={args.train_id}/{args.train_attempt} qualification={args.qualification_id}")
    return 0



def _authorize_selection(repository: str, binding: dict[str, Any], notes: bytes, source: str, version: str,
                         train_id: str, qualified_snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    if not selection_matches(binding, notes, source_sha=source, version=version, train_id=train_id):
        raise ValueError("release notes do not bind the exact selected source/version")
    allocation, canonical, owner_notes = _load_owner_authority(repository, train_id, str(binding.get("train_attempt", "")))
    qualified = (_current_attempt(repository, qualified_snapshot) if qualified_snapshot is not None
                 else _api(repository, f"actions/runs/{canonical['qualification_run_id']}"))
    if (not final_run_matches(qualified, repository=repository, source_sha=source, version=version, train_id=train_id, phase="qualify")
            or str(qualified.get("id")) != canonical["qualification_run_id"]
            or qualified.get("head_sha") != canonical.get("qualification_head_sha")
            or notes != owner_notes
            or not owner_allocation_matches(allocation, canonical, binding, owner_notes,
                                             qualification_id=canonical["qualification_run_id"],
                                             qualification_attempt=qualified.get("run_attempt", 0))):
        raise ValueError("candidate selection is not the owner-authorized latest successful native qualification attempt")
    return qualified


def _require_native_staging(repository: str, run: dict[str, Any], artifacts: dict[str, Any],
                            index: dict[str, Any], source_sha: str, omp_versions: dict[str, str]) -> None:
    producer = {"repository": repository,
                "workflow_ref": f"{repository}/{RELEASE_WORKFLOW}@refs/heads/main",
                "run_id": str(run["id"]), "run_attempt": str(run["run_attempt"])}
    for platform in SHIPPING_PLATFORMS:
        for track in NATIVE_TRACKS:
            name = f"native-receipt-{platform}-{track}-attempt-{run['run_attempt']}"
            artifact = next(row for row in artifacts["artifacts"] if row.get("name") == name)
            receipt = json.loads(_artifact_files(repository, artifact, {"receipt.json"})["receipt.json"])
            expected_native = {"source_sha": source_sha, "version": index["version"], "platform": platform,
                               "omp_track": track, "requested_omp_version": omp_versions[track],
                               "omp_version": omp_versions[track]}
            if (not isinstance(receipt, dict) or receipt.get("certified") is not True
                    or any(receipt.get(key) != value for key, value in expected_native.items())):
                raise ValueError(f"native candidate source/platform/OMP outcome differs: {platform}/{track}")
            staging = receipt.get("archive_staging")
            expected = {
                "schema_version": 1, "scope": "source-workflow-integrity", "source_sha": source_sha,
                "archive_sha256": index["assets"][platform]["sha256"],
                "manifest_sha256": index["assets"][platform]["manifest_sha256"],
                "producer": producer, "public_installation": "NOT_VERIFIED",
            }
            if (not isinstance(staging, dict) or staging != expected
                    or type(staging.get("schema_version")) is not int
                    or not isinstance(staging.get("producer"), dict)
                    or type(staging["producer"].get("run_attempt")) is not str):
                raise ValueError(f"candidate staging is not bound to the authorized native producer: {platform}/{track}")
    _current_attempt(repository, run)


def _require_signed_consumers(repository: str, run: dict[str, Any], artifacts: dict[str, Any],
                              index: dict[str, Any], index_bytes: bytes, source_sha: str) -> None:
    attempt = run["run_attempt"]
    names = {f"signed-consumer-{platform}-attempt-{attempt}" for platform in SHIPPING_PLATFORMS}
    _require_snapshot(run, artifacts, names)
    published = _published(repository)
    version = index["version"]
    index_hash = hashlib.sha256(index_bytes).hexdigest()
    for platform in SHIPPING_PLATFORMS:
        name = f"signed-consumer-{platform}-attempt-{attempt}"
        artifact = next(row for row in artifacts["artifacts"] if row.get("name") == name)
        receipt = json.loads(_artifact_files(repository, artifact, {"receipt.json"})["receipt.json"])
        expected = {
            "schema_version": 1, "kind": "signed-native-consumer", "platform": platform,
            "version": version, "source_sha": source_sha,
            "archive_sha256": index["assets"][platform]["sha256"], "index_sha256": index_hash,
            "run_id": str(run["id"]), "run_attempt": attempt, "installed_version": version,
        }
        if (not isinstance(receipt, dict) or set(receipt) != set(expected) | {"previous_version", "checks"}
                or any(receipt.get(key) != value for key, value in expected.items())
                or type(receipt.get("schema_version")) is not int or type(receipt.get("run_attempt")) is not int):
            raise ValueError(f"signed native consumer identity or installed bytes differ: {platform}")
        checks = receipt.get("checks")
        if (not isinstance(checks, dict) or set(checks) != {"public_installer", "compiled_upgrade"}
                or any(value is not True for value in checks.values())):
            raise ValueError(f"signed native public installer and compiled upgrade did not both pass: {platform}")
        previous = receipt.get("previous_version")
        if (not isinstance(previous, str) or not stable_version(previous) or f"v{previous}" not in published
                or tuple(map(int, previous.split("."))) >= tuple(map(int, version.split(".")))):
            raise ValueError(f"signed native consumer did not upgrade a genuine older published release: {platform}")
    _current_attempt(repository, run)


def _verify_final(args: argparse.Namespace) -> int:
    proof, index = _read_json(args.proof), _read_json(args.index)
    run, artifacts = _read_json(args.run), _read_json(args.artifacts)
    binding = _read_json(args.binding)
    if not final_run_matches(run, repository=args.repository, source_sha=args.source_sha,
                             version=args.version, train_id=args.train_id, phase=args.phase):
        raise ValueError("candidate producer repository/workflow/ref/attempt/phase is not authorized")
    if str(run.get("id")) != args.run_id:
        raise ValueError("candidate producer run ID differs")
    _current_attempt(args.repository, run)
    attempt = run["run_attempt"]
    required = required_candidate_artifacts(attempt) | {f"release-selection-attempt-{attempt}"}
    if args.phase == "qualify":
        if binding.get("qualification_run_id") != args.run_id:
            raise ValueError("selection names another qualification run")
    else:
        required -= {f"native-receipt-{platform}-{track}-attempt-{attempt}" for platform in SHIPPING_PLATFORMS for track in NATIVE_TRACKS}
        required |= {f"sbom-{platform}-attempt-{attempt}" for platform in SHIPPING_PLATFORMS}
        if not str(binding.get("qualification_run_id", "")).isdigit():
            raise ValueError("signed candidate has no qualification lineage")
    _require_snapshot(run, artifacts, required)
    index_artifact = next(row for row in artifacts["artifacts"] if row.get("name") == f"unpublished-candidate-index-attempt-{attempt}")
    index_files = _artifact_files(args.repository, index_artifact, {"candidate-proof.json", "release-index.json"})
    selected_artifact = next(row for row in artifacts["artifacts"] if row.get("name") == f"release-selection-attempt-{attempt}")
    selected_files = _artifact_files(args.repository, selected_artifact, {"selection.json", "release-notes.md"})
    if (index_files["candidate-proof.json"] != Path(args.proof).read_bytes()
            or index_files["release-index.json"] != Path(args.index).read_bytes()
            or selected_files["selection.json"] != Path(args.binding).read_bytes()
            or selected_files["release-notes.md"] != Path(args.notes).read_bytes()):
        raise ValueError("downloaded proof/index/selection is not the exact native attempt snapshot")
    omp_versions = _read_json(args.omp_config)
    if not candidate_index_matches(proof, index, source_sha=args.source_sha, base_version=args.version,
                                   run_id=args.run_id, omp_versions=omp_versions,
                                   final_version=args.version):
        raise ValueError("final source/version/platforms/both pinned OMP tracks do not match")
    _authorize_selection(args.repository, binding, Path(args.notes).read_bytes(), args.source_sha, args.version,
                         args.train_id, run if args.phase == "qualify" else None)
    if args.phase == "qualify":
        _require_native_staging(args.repository, run, artifacts, index, args.source_sha, omp_versions)
    if args.phase == "sign":
        _require_signed_consumers(args.repository, run, artifacts, index, Path(args.index).read_bytes(), args.source_sha)
    print(f"FINAL=verified source_sha={args.source_sha} version={args.version} phase={args.phase}")
    return 0


def _command(argv: list[str], *, cwd: str | None = None) -> str:
    result = subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode:
        raise ValueError(f"command failed ({result.returncode}): {argv!r}\n{result.stdout}")
    return result.stdout.strip()


def _api(repository: str, endpoint: str, *, paginate: bool = False) -> Any:
    argv = ["gh", "api", f"repos/{repository}/{endpoint}"]
    if paginate:
        argv += ["--paginate", "--slurp"]
    return json.loads(_command(argv))


def _run_rows(repository: str, workflow: str, event: str = "workflow_dispatch", since: str = "") -> list[dict[str, Any]]:
    query = f"actions/workflows/{workflow}/runs?event={event}&per_page=100"
    if since:
        _timestamp(since)
        query += f"&created=%3E%3D{quote(since, safe='')}"
    pages = _api(repository, query, paginate=True)
    return [row for page in pages for row in page["workflow_runs"]]


def _published(repository: str) -> set[str]:
    pages = _api(repository, "releases?per_page=100", paginate=True)
    return {row["tag_name"] for page in pages for row in page if not row["draft"] and not row["prerelease"]}


AUTHORITY_JOB_GROUPS = ("attest", "attest-index", "signed-consumers")


def _sign_authority_state(repository: str, sign_run: dict[str, Any]) -> str:
    """Positively classify a canonical, terminal-green signing run's mandatory authority groups from its own attempt.

    Returns "executed" (every job of every group succeeded), "unexecuted" (every group present and terminal, none failed
    or cancelled, at least one skipped) or "unknown" (absent group, incomplete or foreign snapshot, failure, cancellation,
    or a changed attempt). Only "unexecuted" is a proved skipped DAG; "unknown" never classifies anything.
    Matrix jobs are named "<group> (<leg>)"."""
    attempt = sign_run.get("run_attempt")
    if type(attempt) is not int or attempt < 1:
        return "unknown"
    pages = _api(repository, f"actions/runs/{sign_run['id']}/attempts/{attempt}/jobs?per_page=100", paginate=True)
    jobs = [job for page in pages for job in page["jobs"]]
    totals = {page["total_count"] for page in pages if "total_count" in page}
    if not jobs or (totals and totals != {len(jobs)}) or any(job.get("run_id") != sign_run["id"] for job in jobs):
        return "unknown"
    # Fence the attempt: the run must still be the same completed native attempt after the snapshot was read.
    after = _api(repository, f"actions/runs/{sign_run['id']}")
    if (not isinstance(after, dict) or after.get("id") != sign_run["id"] or after.get("run_attempt") != attempt
            or after.get("status") != "completed" or after.get("conclusion") != "success"):
        return "unknown"
    skipped = False
    for group in AUTHORITY_JOB_GROUPS:
        members = [job for job in jobs if job.get("name") == group or str(job.get("name", "")).startswith(f"{group} (")]
        if not members or any(job.get("status") != "completed" or job.get("conclusion") not in ("success", "skipped") for job in members):
            return "unknown"
        skipped = skipped or any(job["conclusion"] == "skipped" for job in members)
    return "unexecuted" if skipped else "executed"


def _signing_cannot_complete(repository: str, rows: list[dict[str, Any]], allocation: dict[str, Any]) -> bool:
    """True only for an owner-authorized cut whose canonical tag-ref signing run is terminal-green with mandatory
    authority groups positively established as skipped.

    The identity comes from the immutable owner allocation, never from a title. The signing run is fetched natively and
    must satisfy final_run_matches (repository, tag-ref workflow, dispatch event, tag/source, version, train, phase,
    terminal success). The tag-ref workflow is immutable, so re-dispatching its publisher can only refuse again. In-flight,
    failed-signing (existing diagnose path), fully executed and unknown/transient snapshots are never classified."""
    version, sha, train_id = allocation["version"], allocation["source_sha"], allocation["train_run_id"]
    signs = [row for row in rows if row.get("display_title") == release_title("sign", version, sha, train_id)]
    if not signs:
        return False
    latest = max(signs, key=_attempt_order)
    run = _api(repository, f"actions/runs/{latest['id']}")
    if not final_run_matches(run, repository=repository, source_sha=sha, version=version, train_id=train_id, phase="sign"):
        return False
    return _sign_authority_state(repository, run) == "unexecuted"


def pending_candidate(rows: list[dict[str, Any]], published: set[str], published_floor: str | None) -> dict[str, Any] | None:
    """Resume native qualification independently of unrelated tag reservations."""
    floor = tuple(map(int, published_floor.split("."))) if published_floor is not None else None
    for row in sorted(rows, key=lambda row: int(row["id"]), reverse=True):
        fields = row.get("display_title", "").split()
        if len(fields) != 4 or fields[0] != "qualify" or not stable_version(fields[1]) or not _git_sha(fields[2]) or not fields[3].startswith("train-"):
            continue
        if (not fields[3][6:].isdigit() or f"v{fields[1]}" in published
                or (floor is not None and tuple(map(int, fields[1].split("."))) < floor)):
            continue
        if row.get("status") != "completed" or row.get("conclusion") in (None, "success"):
            return row
    return None


def _store_plan(args: argparse.Namespace, plan: dict[str, Any]) -> int:
    Path(args.plan).write_text(json.dumps(plan, sort_keys=True) + "\n")
    if getattr(args, "stage", "") == "prepare" and "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"go={'true' if plan['kind'] != 'skip' else 'false'}\nallocate={'true' if plan['kind'] == 'allocate' else 'false'}\n")
    return 0


def _terminal_unbound_failure(repository: str, run_id: str) -> bool:
    producer = _api(repository, f"actions/runs/{run_id}")
    return (
        isinstance(producer, dict) and str(producer.get("id")) == run_id
        and producer.get("repository", {}).get("full_name") == repository
        and producer.get("path") == RELEASE_WORKFLOW and producer.get("event") == "workflow_dispatch"
        and producer.get("status") == "completed"
        and producer.get("conclusion") in ("failure", "cancelled", "timed_out", "action_required", "neutral", "skipped")
    )


def _find_owner_for_qualification(repository: str, train_id: str, run_id: str) -> tuple[dict[str, Any], dict[str, Any], bytes]:
    pages = _api(repository, f"actions/runs/{train_id}/artifacts?per_page=100", paginate=True)
    for row in [row for page in pages for row in page["artifacts"]]:
        name = row.get("name", "")
        attempt = name.removeprefix("release-qualification-")
        if name == attempt or not attempt.isascii() or not attempt.isdigit():
            continue
        files = _artifact_files(repository, row, {"qualification.json"})
        if json.loads(files["qualification.json"]).get("qualification_run_id") != run_id:
            continue
        return _load_owner_authority(repository, train_id, attempt)
    raise UnboundQualification("pending candidate has no owner-authenticated native qualification binding")


def _owned_failure(repository: str, run: dict[str, Any], source: str) -> bool:
    # A caller-authored failed title must not poison an eligible source. Only
    # a selection emitted AFTER native owner authorization blocks an automatic
    # repeat. Historical attempts here prove authorization, never a green gate.
    pages = _api(repository, f"actions/runs/{run['id']}/artifacts?per_page=100", paginate=True)
    for artifact in [row for page in pages for row in page["artifacts"]]:
        name = artifact.get("name", "")
        attempt = name.removeprefix("release-selection-attempt-")
        if name == attempt or not attempt.isascii() or not attempt.isdigit():
            continue
        original = _api(repository, f"actions/runs/{run['id']}/attempts/{attempt}")
        if _owner_artifact([artifact], name, original) is None:
            continue
        files = _artifact_files(repository, artifact, {"selection.json", "release-notes.md"})
        selection = json.loads(files["selection.json"])
        if selection.get("source_sha") != source:
            continue
        try:
            allocation, canonical, notes = _load_owner_authority(repository, selection["train_run_id"], selection["train_attempt"])
        except UnboundQualification:
            if not _terminal_unbound_failure(repository, str(run["id"])):
                raise
            # Terminal unauthorised/lost-binding failures cannot veto a fresh
            # allocation. This creates no recovery or publication authority.
            continue
        if (str(run["id"]) == canonical["qualification_run_id"]
                and owner_allocation_matches(allocation, canonical, selection, notes,
                                             qualification_id=str(run["id"]), qualification_attempt=int(attempt))):
            return True
    return False


def _native_dispatch(repository: str, workflow: str, ref: str, inputs: dict[str, str | bool]) -> str:
    response = subprocess.run(["gh", "api", "--include", "--method", "POST", "-H", "X-GitHub-Api-Version: 2026-03-10",
                               f"repos/{repository}/actions/workflows/{workflow}/dispatches", "--input", "-"],
                              input=json.dumps({"ref": ref, "inputs": inputs}), text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if response.stderr:
        print(response.stderr, end="", file=sys.stderr)
    headers, separator, body = response.stdout.replace("\r\n", "\n").partition("\n\n")
    status = headers.splitlines()[0].split() if headers else []
    if response.returncode or not separator or len(status) < 2 or not status[0].startswith("HTTP/") or status[1] != "200":
        raise ValueError("native dispatch did not return HTTP 200 run details; do not retry an ambiguous allocation")
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("native dispatch response contains duplicate fields")
            result[key] = value
        return result
    dispatched = json.loads(body, object_pairs_hook=unique)
    run_id = dispatched.get("workflow_run_id") if isinstance(dispatched, dict) else None
    if (type(run_id) is not int or run_id < 1
            or dispatched.get("run_url") != f"https://api.github.com/repos/{repository}/actions/runs/{run_id}"
            or dispatched.get("html_url") != f"https://github.com/{repository}/actions/runs/{run_id}"):
        raise ValueError("native dispatch returned missing, malformed or ambiguous native run identity")
    return str(run_id)




def _dispatch_allocation(args: argparse.Namespace) -> int:
    plan = _read_json(args.plan)
    if plan.get("kind") != "allocate" or plan.get("qualification_run_id"):
        raise ValueError("this plan cannot allocate a second qualification")
    artifact = _api(args.repository, f"actions/artifacts/{args.allocation_artifact_id}")
    owner = _api(args.repository, f"actions/runs/{plan['train_id']}/attempts/{plan['train_attempt']}")
    if (str(owner.get("id")) != plan["train_id"] or owner.get("path") != OWNER_WORKFLOW or owner.get("repository", {}).get("full_name") != args.repository
            or owner.get("head_branch") != "main" or owner.get("run_attempt") != int(plan["train_attempt"])):
        raise ValueError("allocation does not come from the exact native owner attempt")
    if _owner_artifact([artifact], f"release-allocation-{plan['train_attempt']}", owner) is None:
        raise ValueError("dispatch does not name this owner's immutable allocation artifact")
    files = _artifact_files(args.repository, artifact, {"allocation.json", "release-notes.md"})
    allocation = json.loads(files["allocation.json"])
    if (allocation.get("owner_sha") != owner.get("head_sha") or allocation.get("train_run_id") != plan["train_id"]
            or allocation.get("train_attempt") != plan["train_attempt"] or allocation.get("repository") != args.repository
            or any(allocation.get(key) != plan.get(key) for key in ("source_sha", "version", "base_tag"))
            or hashlib.sha256(files["release-notes.md"]).hexdigest() != allocation.get("notes_sha256")):
        raise ValueError("local dispatch plan differs from immutable owner allocation")
    if type(allocation.get("rehearsal")) is not bool or plan["rehearsal"] != str(allocation["rehearsal"]).lower():
        raise ValueError("dispatch mode differs from immutable owner allocation")
    inputs = {"version": allocation["version"], "sha": allocation["source_sha"], "base_tag": allocation["base_tag"],
              "train_run_id": allocation["train_run_id"], "train_attempt": allocation["train_attempt"],
              "rehearsal": allocation["rehearsal"]}
    run_id = _native_dispatch(args.repository, "release.yml", "main", inputs)
    qualification = {"schema_version": 1, "train_run_id": plan["train_id"], "train_attempt": plan["train_attempt"],
                     "allocation_artifact_id": str(artifact["id"]), "allocation_sha256": hashlib.sha256(files["allocation.json"]).hexdigest(),
                     "qualification_run_id": str(run_id), "qualification_minimum_attempt": 1}
    directory = Path(args.plan).parent / "release-qualification"
    directory.mkdir(parents=True, exist_ok=True)
    pending_path = directory / "qualification.json.pending"
    with pending_path.open("w", encoding="utf-8") as output:
        output.write(json.dumps(qualification, sort_keys=True) + "\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(pending_path, directory / "qualification.json")
    plan["qualification_run_id"] = str(run_id)
    return _store_plan(args, plan)


def _published_ancestor_tags(tags: list[str], published: set[str], head: str) -> list[str]:
    return [tag for tag in tags if tag.startswith("v") and stable_version(tag[1:])
            and tag in published and _is_ancestor(tag, head)]


def _notes_floor(args: argparse.Namespace) -> int:
    if not _git_sha(args.source_sha):
        raise ValueError("notes-floor requires a full source commit SHA")
    tags = _command(["git", "tag", "--list", "v*"]).splitlines()
    floors = _published_ancestor_tags(tags, _published(args.repository), args.source_sha)
    if not floors:
        raise ValueError("no published ancestor notes floor exists for the selected source")
    print(max(floors, key=lambda tag: tuple(map(int, tag[1:].split(".")))))
    return 0


def _drive(args: argparse.Namespace) -> int:
    if args.stage == "dispatch":
        return _dispatch_allocation(args)
    if args.stage == "watch":
        return _watch_plan(args)
    repository = args.repository
    root = _command(["git", "rev-parse", "--show-toplevel"])
    tools = Path(__file__).resolve().parent
    published = _published(repository)
    tags = [tag for tag in _command(["git", "tag", "--list", "v*"]).splitlines() if tag.startswith("v") and stable_version(tag[1:])]
    released = [tag for tag in published if tag.startswith("v") and stable_version(tag[1:])]
    head = _command(["git", "rev-parse", "origin/main"])
    published_floors = _published_ancestor_tags(tags, published, head)
    recovery_floor = max(published_floors, key=lambda tag: tuple(map(int, tag[1:].split("."))))[1:] if published_floors else None
    rows = _run_rows(repository, "release.yml")
    # A stable release left by a failed publisher is not a completed outcome.
    # Drafts already stay out of `published`; this also recovers pre-existing
    # stable partial releases rather than skipping their successful candidate.
    unfinished = pending_candidate(rows, set(), recovery_floor)
    if unfinished:
        _, prior_version, prior_sha, prior_train = unfinished["display_title"].split()
        if f"v{prior_version}" in published:
            signed = [row for row in rows if row.get("display_title") == release_title("sign", prior_version, prior_sha, prior_train[6:])]
            targets = {f"Promote run {row['id']}" for row in signed}
            targets.add(f"Publish {release_title('sign', prior_version, prior_sha, prior_train[6:])}")
            completed = _run_rows(repository, "release-train.yml", "workflow_dispatch") + _run_rows(repository, "release-train.yml", "workflow_run")
            if not any(row.get("display_title") in targets and row.get("status") == "completed"
                       and row.get("conclusion") == "success" for row in completed):
                try:
                    _find_owner_for_qualification(repository, prior_train[6:], str(unfinished["id"]))
                except UnboundQualification:
                    if not _terminal_unbound_failure(repository, str(unfinished["id"])):
                        raise
                else:
                    published.discard(f"v{prior_version}")
    remaining = list(rows)
    authority: tuple[dict[str, Any], dict[str, Any], bytes] | None = None
    # Cuts whose immutable tag-ref signing is canonical, terminal-green and positively shows the mandatory authority
    # groups skipped. Their tag and bytes are retained as evidence; they are neither resumed nor re-signed, and the
    # source is never selected again. Classification needs established owner authority, never a title alone.
    unsignable_shas: set[str] = set()
    while True:
        pending = pending_candidate(remaining, published, recovery_floor)
        if pending is None:
            break
        _, _, _, train = pending["display_title"].split()
        try:
            authority = _find_owner_for_qualification(repository, train[6:], str(pending["id"]))
        except UnboundQualification:
            if not _terminal_unbound_failure(repository, str(pending["id"])):
                raise
            remaining = [row for row in remaining if row["id"] != pending["id"]]
            continue
        if pending.get("status") == "completed" and pending.get("conclusion") == "success":
            allocation, canonical, owner_notes = authority
            selection = dict(allocation, qualification_run_id=canonical.get("qualification_run_id"),
                             allocation_artifact_id=canonical.get("allocation_artifact_id"),
                             allocation_sha256=canonical.get("allocation_sha256"), qualification_attempt=pending.get("run_attempt"))
            if (owner_allocation_matches(allocation, canonical, selection, owner_notes, qualification_id=str(pending["id"]),
                                         qualification_attempt=int(pending.get("run_attempt", 0)))
                    and _signing_cannot_complete(repository, rows, allocation)):
                unsignable_shas.add(allocation["source_sha"])
                remaining = [row for row in remaining if row["id"] != pending["id"]]
                authority = None
                continue
        break
    publisher_floor = 0
    recovery_ids: set[str] = set()
    publisher_runs: dict[str, str] = {}
    if pending:
        if authority is None:
            raise ValueError("pending qualification has no native owner authority")
        allocation, canonical, owner_notes = authority
        selection = dict(allocation, qualification_run_id=canonical.get("qualification_run_id"),
                         allocation_artifact_id=canonical.get("allocation_artifact_id"), allocation_sha256=canonical.get("allocation_sha256"),
                         qualification_attempt=pending.get("run_attempt"))
        if not owner_allocation_matches(allocation, canonical, selection, owner_notes,
                                         qualification_id=str(pending["id"]), qualification_attempt=int(pending.get("run_attempt", 0))):
            raise ValueError("pending candidate does not own its claimed allocation")
        version, sha, train_id = allocation["version"], allocation["source_sha"], allocation["train_run_id"]
        if args.rehearsal == "true":
            raise ValueError("an unfinished production candidate must finish before a rehearsal")
        if pending["status"] == "completed":
            signs = [row for row in rows if row.get("display_title") == release_title("sign", version, sha, train_id)]
            latest_sign = max(signs, key=_attempt_order) if signs else None
            if latest_sign and latest_sign.get("status") == "completed" and latest_sign.get("conclusion") != "success":
                raise ValueError(f"tag-ref signing {latest_sign['id']} failed; diagnose the post-certification issue, never recertify")
            if not latest_sign or latest_sign.get("status") == "completed":
                previous = (_run_rows(repository, "release-train.yml", "workflow_run")
                            + _run_rows(repository, "release-train.yml", "workflow_dispatch"))
                publisher_floor = max((int(row["id"]) for row in previous), default=0)
                target = latest_sign or pending
                recovery_ids.add(str(target["id"]))
                publisher_id = _native_dispatch(repository, "release-train.yml", "main", {"candidate_run_id": str(target["id"])})
                publisher_runs[publisher_id] = target["display_title"].split()[0]
        return _store_plan(args, {"kind": "resume", "source_sha": sha, "version": version, "train_id": train_id,
                                 "train_attempt": allocation["train_attempt"], "qualification_run_id": canonical["qualification_run_id"],
                                 "rehearsal": "false", "publisher_floor": publisher_floor, "recovery_ids": sorted(recovery_ids),
                                 "publisher_runs": publisher_runs})
    else:
        # Native work owns the lane; a tag only reserves a version number.
        # Unknown active runs still require reconciliation, never a competing allocation.
        if any(row.get("status") != "completed" for row in rows):
            raise ValueError("native release work is still active or unresolved; wait before allocation")
        if not published_floors:
            raise ValueError("no authenticated published ancestor release floor exists")
        published_tag = max(published_floors, key=lambda tag: tuple(map(int, tag[1:].split("."))))
        floor = _command(["git", "rev-parse", f"{published_tag}^{{commit}}"])
        history = _command(["git", "rev-list", "--topo-order", head, f"^{floor}"]).splitlines()
        # Query only commits after the promoted floor; GitHub pagination is complete.
        since = _command(["git", "show", "-s", "--format=%cI", floor])
        pages = _api(repository, f"actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&created=%3E%3D{quote(since, safe='')}", paginate=True)
        ci_runs = {"workflow_runs": [row for page in pages for row in page["workflow_runs"]]}
        sha = select_source(ci_runs, history, args.requested)
        if not sha:
            print("TRAIN=skip REASON=no-qualified-unreleased-source")
            return _store_plan(args, {"kind": "skip"})
        if sha in unsignable_shas:
            # Its immutable tag-ref workflow cannot gain the fix; only a newer source carrying it can release.
            print(f"TRAIN=skip REASON=selected-source-signing-unrepairable source_sha={sha}")
            return _store_plan(args, {"kind": "skip"})
        # Signing runs from the eventual source tag, not this owner's main
        # checkout. Compare its implementation, never a manually bumped label.
        signer_inputs = [RELEASE_WORKFLOW, ".github/workflows/ci.yml", "scripts/release_reuse.py",
                         "scripts/native-candidate.py", "tests/e2e/real-home-journey.sh"]
        source_signer = _command(["git", "ls-tree", sha, "--", *signer_inputs])
        owner_signer = _command(["git", "ls-tree", head, "--", *signer_inputs])
        if len(source_signer.splitlines()) != len(signer_inputs) or source_signer != owner_signer:
            print(f"TRAIN=skip REASON=source-signer-inputs-differ source_sha={sha}")
            return _store_plan(args, {"kind": "skip"})
        # Do not automatically repeat a failed qualification with identical inputs.
        if any(row.get("status") == "completed" and row.get("conclusion") != "success"
               and row.get("display_title", "").startswith("qualify ") and row.get("display_title", "").split()[2:3] == [sha]
               and _owned_failure(repository, row, sha) for row in rows):
            raise ValueError("selected source already failed qualification; diagnose forward, do not rerun it")
        # Published versions remain spent even if their tag was removed or not fetched.
        tag_input = "\n".join(sorted(set(tags).union(released))) + "\n"
        result = subprocess.run(["sh", str(tools / "release-train.sh"), "next-version", "--changelog-ref", head], input=tag_input, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=root, timeout=30)
        print(result.stderr, end="", file=sys.stderr)
        if result.returncode:
            raise ValueError("next-version refused")
        version = result.stdout.strip()
        if args.version:
            if not stable_version(args.version) or tuple(map(int, args.version.split("."))) < tuple(map(int, version.split("."))):
                raise ValueError("version override is below the tag/changelog allocation floor")
            version = args.version
        train_id = args.train_id
        base_tags = _published_ancestor_tags(tags, published, sha)
        if not base_tags:
            raise ValueError("selected source has no published ancestor notes floor")
        base_tag = max(base_tags, key=lambda tag: tuple(map(int, tag[1:].split("."))))
        # Empty ranges are a skip before any candidate allocation/dispatch, not
        # a failed certification or an excuse to manufacture an empty release.
        preview = Path(os.environ["RUNNER_TEMP"]) / f"release-notes-{args.train_id}.md"
        note_result = subprocess.run(["sh", str(tools / "release-notes.sh"), "source", "--base-tag", base_tag,
                                     "--head", sha, "--version", version, "--output", str(preview)],
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        print(note_result.stdout, end="")
        print(note_result.stderr, end="", file=sys.stderr)
        if note_result.returncode == 4:
            print("TRAIN=skip REASON=nothing-to-release")
            return _store_plan(args, {"kind": "skip"})
        if note_result.returncode:
            raise ValueError("source notes validation failed")
        directory = Path(args.plan).parent / "release-allocation"
        directory.mkdir(parents=True, exist_ok=True)
        notes = preview.read_bytes()
        allocation = {"schema_version": 1, "protocol": ALLOCATION_PROTOCOL, "repository": repository,
                      "owner_sha": os.environ["GITHUB_SHA"], "train_run_id": train_id, "train_attempt": args.train_attempt,
                      "source_sha": sha, "version": version, "base_tag": base_tag, "notes_sha256": hashlib.sha256(notes).hexdigest(),
                      "rehearsal": args.rehearsal == "true", "qualification_attempt_policy": "same-native-run"}
        (directory / "allocation.json").write_text(json.dumps(allocation, sort_keys=True) + "\n")
        (directory / "release-notes.md").write_bytes(notes)
        return _store_plan(args, {"kind": "allocate", "source_sha": sha, "version": version, "base_tag": base_tag,
                                 "train_id": train_id, "train_attempt": args.train_attempt, "rehearsal": args.rehearsal,
                                 "publisher_floor": 0, "recovery_ids": []})


def _watch_plan(args: argparse.Namespace) -> int:
    plan = _read_json(args.plan)
    repository = args.repository
    version, sha, train_id = plan["version"], plan["source_sha"], plan["train_id"]
    rehearsal = plan["rehearsal"]
    qualification_id = plan["qualification_run_id"]
    publisher_floor = plan["publisher_floor"]
    recovery_ids = set(plan["recovery_ids"])
    publisher_runs = dict(plan.get("publisher_runs", {}))
    if rehearsal != "true":
        allocation, canonical, _ = _load_owner_authority(repository, train_id, plan["train_attempt"])
        if (canonical.get("qualification_run_id") != qualification_id
                or allocation.get("source_sha") != sha or allocation.get("version") != version):
            raise ValueError("observer plan differs from immutable owner allocation")
    deadline = time.monotonic() + args.timeout
    qualify_title = release_title("rehearse" if rehearsal == "true" else "qualify", version, sha, train_id)
    sign_title = release_title("sign", version, sha, train_id)
    forwarded_signs = set(recovery_ids)
    while time.monotonic() < deadline:
        # Release existence or an index-only match is never publication proof.
        # Observe the exact publisher returned by native dispatch, including
        # its latest attempt; its sign-phase job verifies every required byte.
        for publisher_id, phase in publisher_runs.items():
            outcome = _api(repository, f"actions/runs/{publisher_id}")
            if (outcome.get("path") != OWNER_WORKFLOW or outcome.get("event") != "workflow_dispatch"
                    or outcome.get("head_branch") != "main" or outcome.get("repository", {}).get("full_name") != repository):
                raise ValueError("publication outcome came from a different native producer")
            if outcome.get("status") != "completed":
                continue
            if outcome.get("conclusion") != "success":
                raise ValueError("exact native publisher failed; preserve artifacts for bounded recovery")
            if phase == "sign":
                if type(outcome.get("run_attempt")) is not int or outcome["run_attempt"] < 1:
                    raise ValueError("publisher has no authoritative native attempt")
                pages = _api(repository, f"actions/runs/{publisher_id}/attempts/{outcome['run_attempt']}/jobs?per_page=100", paginate=True)
                jobs = [job for page in pages for job in page["jobs"] if job.get("name") == "publish"]
                if (len(jobs) != 1 or jobs[0].get("run_id") != int(publisher_id)
                        or jobs[0].get("status") != "completed" or jobs[0].get("conclusion") != "success"):
                    raise ValueError("native publisher did not execute its promotion job successfully")
                if f"v{version}" not in _published(repository) or _api(repository, f"commits/v{version}").get("sha") != sha:
                    raise ValueError("publisher succeeded without the exact stable release")
                print(f"TRAIN=published source_sha={sha} version={version} publisher_run_id={publisher_id}")
                return 0
        # The native POST response, not a candidate-authored title, identifies
        # qualification. Titles only discover a signer, which is independently
        # checked against the same owner authority before any publication.
        qualified = _api(repository, f"actions/runs/{qualification_id}")
        if qualified.get("status") != "completed":
            time.sleep(15)
            continue
        if qualified.get("conclusion") != "success":
            raise ValueError("canonical qualification's latest native attempt failed")
        if rehearsal == "true":
            print(f"TRAIN=rehearsed source_sha={sha} version={version}")
            return 0
        since = qualified.get("created_at")
        _timestamp(since)
        attempt_started = _timestamp(qualified.get("run_started_at"))
        observed = _run_rows(repository, "release.yml", since=since)
        signs = [row for row in observed if row.get("display_title") == sign_title and _attempt_order(row)[0] >= attempt_started]
        current = [qualified, max(signs, key=_attempt_order, default={})]
        for row in current:
            if row.get("display_title") not in (qualify_title, sign_title):
                continue
            if row.get("status") == "completed" and row.get("conclusion") != "success":
                raise ValueError(f"candidate {row['id']} failed: {row.get('conclusion')}")
            if row.get("display_title") == sign_title and row.get("status") == "completed" and str(row["id"]) not in forwarded_signs:
                # Tag-head workflow_run delivery is not guaranteed (dj7d).
                # Wake the SAME independent publisher with a verified run ID;
                # no second build/signing run and no raw promotion here.
                publisher_id = _native_dispatch(repository, "release-train.yml", "main", {"candidate_run_id": str(row["id"])})
                publisher_runs[publisher_id] = "sign"
                plan["publisher_runs"] = publisher_runs
                _store_plan(args, plan)
                forwarded_signs.add(str(row["id"]))
                recovery_ids.add(str(row["id"]))
        publishers = _run_rows(repository, "release-train.yml", "workflow_run", since=since)
        if any(row.get("display_title") in (f"Publish {qualify_title}", f"Publish {sign_title}")
               and int(row["id"]) > publisher_floor and row.get("status") == "completed" and row.get("conclusion") != "success" for row in publishers):
            raise ValueError("independent candidate publisher failed; preserve its artifacts for recovery")
        if (not signs and "qualify" not in publisher_runs.values() and _delivery_overdue(qualified)
                and not any(row.get("display_title") == f"Publish {qualify_title}" for row in publishers)):
            # A dispatch made with the workflow token produces no workflow_run delivery (fp72.25, dj7d), so the
            # publisher that tags and requests tag-ref signing never starts. Wake the same publisher with the
            # verified successful qualification once, only after delivery had its grace and no signing run or
            # Publish row exists; it neither rebuilds the candidate nor skips any publisher check.
            publisher_id = _native_dispatch(repository, "release-train.yml", "main", {"candidate_run_id": str(qualification_id)})
            publisher_runs[publisher_id] = "qualify"
            plan["publisher_runs"] = publisher_runs
            _store_plan(args, plan)
        time.sleep(15)
    raise ValueError("publication outcome deadline expired; no next version allocated")


def _require_green(args: argparse.Namespace) -> int:
    if not has_green_main_ci(_read_json(args.ci_runs), args.source_sha):
        raise ValueError("selected source does not have completed successful main push CI")
    print(f"CI=qualified source_sha={args.source_sha}")
    return 0




def _verify_index(args: argparse.Namespace) -> int:
    if not candidate_index_matches(_read_json(args.proof), _read_json(args.index),
                                   source_sha=args.source_sha, base_version=args.version.split("-")[0],
                                   run_id="0", omp_versions=_read_json(args.omp_config), final_version=args.version):
        raise ValueError("candidate source/version/ship set/both pinned OMP tracks differ")
    print(f"INDEX=verified source_sha={args.source_sha} version={args.version}")
    return 0


def _is_ancestor(base: str, head: str) -> bool:
    result = subprocess.run(["git", "--no-replace-objects", "merge-base", "--is-ancestor", base, head],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode not in (0, 1):
        raise ValueError(f"cannot establish main ancestry for {base}..{head}")
    return result.returncode == 0


def _promotion(args: argparse.Namespace) -> int:
    if not _git_sha(args.source_sha) or not stable_version(args.version):
        raise ValueError("invalid promotion identity")
    tags = _command(["git", "tag", "--list", "v*"]).splitlines()
    published = _published(args.repository)
    head = _command(["git", "rev-parse", "origin/main"])
    selected_tag = f"v{args.version}"
    if selected_tag in tags:
        if _command(["git", "rev-parse", f"{selected_tag}^{{commit}}"]) != args.source_sha:
            raise ValueError("allocated version is already bound to another source")
        print(f"PROMOTION=recover-matching-tag source_sha={args.source_sha} version={args.version}")
        return 0
    for tag in tags:
        if tag not in published or not tag.startswith("v") or not stable_version(tag[1:]):
            continue
        tagged = _command(["git", "rev-parse", f"{tag}^{{commit}}"])
        if not _is_ancestor(tagged, head):
            continue
        # A newer/equal promoted source is never displaced by an older
        # snapshot, even when someone supplies a larger version override.
        if not _is_ancestor(tagged, args.source_sha) or tagged == args.source_sha:
            raise ValueError(f"source is not newer than already-promoted {tag}")
        if tuple(map(int, tag[1:].split("."))) >= tuple(map(int, args.version.split("."))):
            raise ValueError("version would regress an already-promoted version")
    print(f"PROMOTION=allowed source_sha={args.source_sha} version={args.version}")
    return 0

def _latest_flag(args: argparse.Namespace) -> int:
    if not stable_version(args.version):
        raise ValueError("invalid publication version")
    selected = tuple(map(int, args.version.split(".")))
    newer_published = any(
        tag.startswith("v") and stable_version(tag[1:]) and tuple(map(int, tag[1:].split("."))) > selected
        for tag in _published(args.repository)
    )
    print("--latest=false" if newer_published else "--latest")
    return 0



def _release_asset_rows(repository: str, release_id: int) -> list[dict[str, Any]]:
    pages = _api(repository, f"releases/{release_id}/assets?per_page=100", paginate=True)
    return [row for page in pages for row in page]


def _remote_asset_hash(repository: str, asset: dict[str, Any], directory: str) -> str:
    with tempfile.TemporaryFile(dir=directory) as target:
        result = subprocess.run(["gh", "api", "-H", "Accept: application/octet-stream",
                                 f"repos/{repository}/releases/assets/{asset['id']}"],
                                stdout=target, stderr=subprocess.PIPE, timeout=180)
        if result.stderr:
            print(result.stderr.decode(errors="replace"), end="", file=sys.stderr)
        if result.returncode:
            raise ValueError("published asset could not be verified")
        target.seek(0)
        digest = hashlib.sha256()
        for chunk in iter(lambda: target.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def _repair_release(args: argparse.Namespace) -> int:
    producer = _read_json(args.producer_run)
    _current_attempt(args.repository, producer)
    binding, notes = _read_json(args.binding), Path(args.notes).read_bytes()
    _authorize_selection(args.repository, binding, notes, args.source_sha, args.version, binding["train_run_id"])
    index = _read_json(args.index)
    if (not stable_version(args.version) or not _git_sha(args.source_sha)
            or index.get("schema_version") != 1 or index.get("version") != args.version
            or index.get("source_tag") != f"v{args.version}"):
        raise ValueError("repair index does not bind the exact certified release identity")
    expected: dict[str, Path] = {"release-index.json": Path(args.index)}
    if set(index.get("assets", {})) != set(SHIPPING_PLATFORMS):
        raise ValueError("repair requires the exact certified ship set")
    if not final_run_matches(producer, repository=args.repository, source_sha=args.source_sha,
                             version=args.version, train_id=binding["train_run_id"], phase="sign"):
        raise ValueError("repair requires the successful exact tag-ref signing producer")
    pages = _api(args.repository, f"actions/runs/{producer['id']}/artifacts?per_page=100", paginate=True)
    _require_signed_consumers(args.repository, producer,
                              {"artifacts": [row for page in pages for row in page["artifacts"]]},
                              index, Path(args.index).read_bytes(), args.source_sha)
    for platform in SHIPPING_PLATFORMS:
        archive_dir = Path(args.archives) / platform
        if not archive_matches_index(index, platform, archive_dir):
            raise ValueError("repair source archive differs from the certified index")
        filename = index["assets"][platform]["filename"]
        if filename in expected:
            raise ValueError("certified release assets do not have unique filenames")
        expected[filename] = archive_dir / filename
        sbom = f"sbom-{platform}.spdx.json"
        if sbom in expected:
            raise ValueError("certified SBOM filename collides with another required asset")
        expected[sbom] = Path(args.sboms) / platform / sbom
        if not expected[sbom].is_file() or expected[sbom].stat().st_size == 0:
            raise ValueError("repair source lacks a required nonempty platform SBOM")
    # Hash equality binds remote assets to these same certified, signed bytes.
    # No idempotent-success or missing-asset repair path skips native authority.
    for target in [Path(args.index), *(expected[index["assets"][platform]["filename"]] for platform in SHIPPING_PLATFORMS)]:
        _command(["gh", "attestation", "verify", str(target), "--repo", args.repository,
                  "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
                  "--signer-workflow", f"{args.repository}/{RELEASE_WORKFLOW}",
                  "--source-digest", args.source_sha, "--predicate-type", "https://slsa.dev/provenance/v1"])
    pages = _api(args.repository, "releases?per_page=100", paginate=True)
    releases = [row for page in pages for row in page if row.get("tag_name") == f"v{args.version}"]
    if len(releases) != 1 or releases[0].get("prerelease") is not False:
        raise ValueError("repair requires one exact stable or draft release")
    release = releases[0]
    if not notes.strip() or not isinstance(release.get("body"), str) or release["body"].strip() != notes.decode().strip():
        raise ValueError("existing release notes differ from the immutable source-bound notes")
    if _api(args.repository, f"commits/v{args.version}").get("sha") != args.source_sha:
        raise ValueError("published tag does not name the certified source")
    verified: dict[str, int] = {}
    def verify(rows: list[dict[str, Any]], name: str) -> bool:
        matches = [row for row in rows if row.get("name") == name]
        if not matches:
            return False
        if len(matches) != 1:
            raise ValueError("published asset name is ambiguous")
        row, local = matches[0], expected[name]
        if type(row.get("id")) is not int or row["id"] < 1 or type(row.get("size")) is not int or row["size"] != local.stat().st_size:
            raise ValueError(f"published asset mismatches certified bytes: {name}")
        if verified.get(name) != row["id"]:
            digest = hashlib.sha256()
            with local.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            if _remote_asset_hash(args.repository, row, args.archives) != digest.hexdigest():
                raise ValueError(f"published asset mismatches certified hash: {name}")
            verified[name] = row["id"]
        return True
    rows = _release_asset_rows(args.repository, release["id"])
    # Verify every existing mandatory asset BEFORE uploading anything. A
    # mismatching archive/index/SBOM is never replaced or silently blessed.
    missing = [name for name in expected if not verify(rows, name)]
    _current_attempt(args.repository, producer)
    _authorize_selection(args.repository, binding, notes, args.source_sha, args.version, binding["train_run_id"])
    for name in missing:
        result = subprocess.run(["gh", "release", "upload", f"v{args.version}", str(expected[name]),
                                 "--repo", args.repository], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        rows = _release_asset_rows(args.repository, release["id"])
        if not verify(rows, name):
            raise ValueError(f"missing certified asset was not uploaded: {name} (exit {result.returncode})")
        # A failed no-clobber upload is acceptable only when the racing native
        # asset now verifies byte-for-byte. No --clobber or replacement path.
    rows = _release_asset_rows(args.repository, release["id"])
    if not all(verify(rows, name) for name in expected):
        raise ValueError("release remains incomplete after bounded exact-asset repair")
    _current_attempt(args.repository, producer)
    _authorize_selection(args.repository, binding, notes, args.source_sha, args.version, binding["train_run_id"])
    print(f"RELEASE_ASSETS=complete source_sha={args.source_sha} version={args.version}")
    return 0


def _require_attempt(args: argparse.Namespace) -> int:
    _current_attempt(args.repository, _read_json(args.run))
    return 0


def _probe_source(args: argparse.Namespace) -> int:
    run, proof, index = _read_json(args.run), _read_json(args.proof), _read_json(args.index)
    artifacts = _read_json(args.artifacts)
    source, version = proof.get("source_sha"), proof.get("version")
    if (run.get("id") != int(args.event_run_id) or run.get("head_sha") != args.event_sha
            or run.get("run_attempt") != args.event_attempt
            or run.get("repository", {}).get("full_name") != args.repository or run.get("path") != RELEASE_WORKFLOW
            or run.get("event") != "workflow_dispatch" or run.get("status") != "completed" or run.get("conclusion") != "success"
            or not _git_sha(source) or not isinstance(version, str)):
        raise ValueError("Intel probe producer does not match the authoritative completed event")
    _current_attempt(args.repository, run)
    if not _is_ancestor(source, "origin/main") or not _is_ancestor(source, args.event_sha):
        raise ValueError("Intel probe source is not the selected main-history ancestor")
    if stable_version(version):
        attempt = run["run_attempt"]
        selected = _owner_artifact(artifacts["artifacts"], f"release-selection-attempt-{attempt}", run)
        if selected is None:
            raise ValueError("Intel probe has no source-bound production selection")
        directory = Path(args.proof).parent / "probe-selection"
        directory.mkdir(exist_ok=True)
        for name, content in _artifact_files(args.repository, selected, {"selection.json", "release-notes.md"}).items():
            (directory / name).write_bytes(content)
        binding = _read_json(str(directory / "selection.json"))
        final = argparse.Namespace(**vars(args), source_sha=source, version=version,
                                   binding=str(directory / "selection.json"), notes=str(directory / "release-notes.md"),
                                   train_id=binding["train_run_id"], run_id=args.event_run_id,
                                   phase=run["display_title"].split()[0])
        with contextlib.redirect_stdout(sys.stderr):
            _verify_final(final)
    else:
        # A replay may intentionally have no Intel artifact or native receipts
        # in this run. Bind the files actually consumed; this is report-only.
        name = f"unpublished-candidate-index-attempt-{run['run_attempt']}"
        _require_snapshot(run, artifacts, {name})
        row = next(row for row in artifacts["artifacts"] if row["name"] == name)
        files = _artifact_files(args.repository, row, {"candidate-proof.json", "release-index.json"})
        if files["candidate-proof.json"] != Path(args.proof).read_bytes() or files["release-index.json"] != Path(args.index).read_bytes():
            raise ValueError("Intel rehearsal index is not the exact producer attempt snapshot")
        if not candidate_index_matches(proof, index, source_sha=source, base_version=version.split("-")[0],
                                       run_id=args.event_run_id, omp_versions=_read_json(args.omp_config), final_version=version):
            raise ValueError("Intel rehearsal source/version/ship proof differs")
    name = f"candidate-darwin-x64-none-attempt-{run['run_attempt']}"
    probes = [row for row in artifacts["artifacts"] if row.get("name") == name]
    if probes:
        _require_snapshot(run, artifacts, {name})
    _write_outputs({"source_sha": source, "version": version, "has_probe": str(bool(probes)).lower(),
                    "producer_attempt": str(run["run_attempt"])})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    preflight = commands.add_parser("preflight")
    preflight.add_argument("--ci-runs", required=True)
    preflight.add_argument("--candidate-run", default="")
    preflight.add_argument("--artifacts", default="")
    preflight.add_argument("--source-sha", required=True)
    preflight.add_argument("--base-version", required=True)
    preflight.add_argument("--requested-run-id", default="")
    preflight.add_argument("--repository", required=True)
    preflight.add_argument("--ci-sha", default="")
    preflight.set_defaults(func=_preflight)

    validate = commands.add_parser("validate-index")
    validate.add_argument("--proof", required=True)
    validate.add_argument("--index", required=True)
    validate.add_argument("--omp-config", required=True)
    validate.add_argument("--source-sha", required=True)
    validate.add_argument("--base-version", required=True)
    validate.add_argument("--run-id", default="")
    validate.set_defaults(func=_validate_index)

    verify = commands.add_parser("verify-archive")
    verify.add_argument("--index", required=True)
    verify.add_argument("--platform", required=True)
    verify.add_argument("--archive-dir", required=True)
    verify.set_defaults(func=_verify_archive)
    green = commands.add_parser("require-green")
    green.add_argument("--ci-runs", required=True)
    green.add_argument("--source-sha", required=True)
    green.set_defaults(func=_require_green)
    allocation = commands.add_parser("require-allocation")
    for flag in ("repository", "train-id", "train-attempt", "qualification-id", "source-sha", "version", "base-tag", "output"):
        allocation.add_argument(f"--{flag}", required=True)
    allocation.add_argument("--qualification-attempt", type=int, required=True)
    allocation.add_argument("--timeout", type=int, default=180)
    allocation.set_defaults(func=_require_allocation)


    promotion = commands.add_parser("promotion")
    promotion.add_argument("--repository", required=True)
    promotion.add_argument("--source-sha", required=True)
    promotion.add_argument("--version", required=True)
    promotion.set_defaults(func=_promotion)
    latest = commands.add_parser("latest-flag")
    latest.add_argument("--repository", required=True)
    latest.add_argument("--version", required=True)
    latest.set_defaults(func=_latest_flag)


    index = commands.add_parser("verify-index")
    for flag in ("proof", "index", "omp-config", "source-sha", "version"):
        index.add_argument(f"--{flag}", required=True)
    index.set_defaults(func=_verify_index)
    final = commands.add_parser("verify-final")
    for flag in ("proof", "index", "omp-config", "source-sha", "version", "run", "artifacts", "binding", "notes", "repository", "train-id", "run-id"):
        final.add_argument(f"--{flag}", required=True)
    final.add_argument("--phase", choices=("qualify", "sign"), required=True)
    final.set_defaults(func=_verify_final)

    repair = commands.add_parser("repair-release")
    for flag in ("repository", "version", "source-sha", "index", "archives", "sboms", "notes", "producer-run", "binding"):
        repair.add_argument(f"--{flag}", required=True)
    repair.set_defaults(func=_repair_release)

    current = commands.add_parser("require-attempt")
    current.add_argument("--repository", required=True)
    current.add_argument("--run", required=True)
    current.set_defaults(func=_require_attempt)

    probe = commands.add_parser("probe-source")
    for flag in ("repository", "run", "proof", "index", "omp-config", "artifacts", "event-run-id", "event-sha"):
        probe.add_argument(f"--{flag}", required=True)
    probe.add_argument("--event-attempt", type=int, required=True)
    probe.set_defaults(func=_probe_source)

    notes_floor = commands.add_parser("notes-floor")
    notes_floor.add_argument("--repository", required=True)
    notes_floor.add_argument("--source-sha", required=True)
    notes_floor.set_defaults(func=_notes_floor)

    drive = commands.add_parser("drive")
    drive.add_argument("--repository", required=True)
    drive.add_argument("--train-id", required=True)
    drive.add_argument("--stage", choices=("prepare", "dispatch", "watch"), required=True)
    drive.add_argument("--plan", required=True)
    drive.add_argument("--train-attempt", required=True)
    drive.add_argument("--allocation-artifact-id", default="")
    drive.add_argument("--requested", default="")
    drive.add_argument("--version", default="")
    drive.add_argument("--rehearsal", choices=("true", "false"), default="false")
    drive.add_argument("--timeout", type=int, default=7200)
    drive.set_defaults(func=_drive)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"release_reuse: REFUSED: {error}", file=sys.stderr)
        raise SystemExit(4) from error
