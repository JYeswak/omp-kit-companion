#!/usr/bin/env python3
"""Select exact-SHA CI and candidate evidence for release rehearsals."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

SHIPPING_PLATFORMS = (
    "darwin-arm64-none",
    "linux-arm64-gnu",
    "linux-x64-gnu",
)
NATIVE_TRACKS = ("minimum", "certified")
RELEASE_WORKFLOW = ".github/workflows/release.yml"
CI_WORKFLOW = ".github/workflows/ci.yml"


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
    if (
        not _git_sha(source_sha)
        or not isinstance(runs, dict)
        or not isinstance(runs.get("workflow_runs"), list)
    ):
        return False
    return any(
        isinstance(run, dict)
        and run.get("path") == CI_WORKFLOW
        and run.get("event") == "push"
        and run.get("head_branch") == "main"
        and run.get("head_sha") == source_sha
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        for run in runs["workflow_runs"]
    )


def required_candidate_artifacts() -> set[str]:
    names = {"unpublished-candidate-index"}
    names.update(f"candidate-{platform}" for platform in SHIPPING_PLATFORMS)
    names.update(
        f"native-receipt-{platform}-{track}"
        for platform in SHIPPING_PLATFORMS
        for track in NATIVE_TRACKS
    )
    return names


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
    return f"{base_version}-rehearsal.{run_id}.1"


def select_reuse(
    ci_runs: Any,
    candidate_run: Any,
    artifacts: Any,
    *,
    source_sha: str,
    base_version: str,
    requested_run_id: str,
    repository: str,
) -> dict[str, str]:
    reuse_fast_ci = has_green_main_ci(ci_runs, source_sha)
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
    expected_version = f"{base_version}-rehearsal.{run_id}.1"
    platforms = set(SHIPPING_PLATFORMS)
    if (
        proof.get("schema_version") != 1
        or proof.get("source_sha") != source_sha
        or proof.get("version") != expected_version
        or set(certified) != platforms
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

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
