#!/usr/bin/env python3
"""Prove that sharded `bun test --shard=K/N` legs together ran every core test file exactly once.

CI shards the core CLI suite across N parallel jobs; the single cli-contracts summary stays the required
check. A shard leg that is dropped from the matrix, a shard count that disagrees with the legs, or a bun
discovery change would otherwise let a test file silently stop running while every leg is green.

Each shard writes `junit-<K>.attempt-<A>.xml` (bun's junit reporter). The expected set is every tracked file
under the given roots whose name matches bun's test-file convention, minus the --ignore globs, which must match
the core `bun test` invocation in .github/workflows/ci.yml. For each shard the newest attempt's report counts,
so a re-run of only the failed shard is judged with the other shards' reports.

Exit 0 prints CORE_SHARD_COVERAGE=ok; exit 1 names every missing shard report, duplicated, missing and
unexpected file.
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from pysafe import run_bounded  # noqa: E402  (cancel-safe spawn: own process group, stdin DEVNULL, hard deadline)

# bun test discovery: *.test.*, *_test.*, *.spec.*, *_spec.* for js, jsx, ts and tsx.
TEST_SUFFIXES = tuple(f"{sep}{kind}.{ext}" for sep in (".", "_") for kind in ("test", "spec")
                      for ext in ("ts", "tsx", "js", "jsx"))


def expected_files(repo: Path, roots: list[str], ignores: list[str]) -> set[str]:
    result = run_bounded(["git", "ls-files", "-z", "--", *roots], cwd=repo, timeout=60)
    if result.outcome != "OK":
        raise RuntimeError("git ls-files timed out after 60s; process group killed")
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, ["git", "ls-files", "-z", "--", *roots])
    listed = result.text("stdout").split("\0")
    return {path for path in listed
            if path.endswith(TEST_SUFFIXES) and not any(fnmatch.fnmatchcase(path, glob) for glob in ignores)}


def shard_reports(junit_dir: Path) -> dict[int, tuple[int, Path]]:
    """Newest attempt's report per shard index."""
    newest: dict[int, tuple[int, Path]] = {}
    for path in junit_dir.rglob("junit-*.xml"):
        stem = path.name.removeprefix("junit-").removesuffix(".xml")
        shard, sep, attempt = stem.partition(".attempt-")
        if not sep or not shard.isdigit() or not attempt.isdigit():
            raise ValueError(f"unrecognized shard report name: {path.name}")
        key, rank = int(shard), int(attempt)
        if key not in newest or rank > newest[key][0]:
            newest[key] = (rank, path)
    return newest


def report_files(path: Path) -> list[str]:
    root = ET.parse(path).getroot()
    suites = root.findall("testsuite") if root.tag == "testsuites" else [root]
    files = []
    for suite in suites:
        name = suite.get("file") or suite.get("name")
        if not name:
            raise ValueError(f"{path.name}: testsuite without a file attribute")
        files.append(name)
    return files


def check(repo: Path, junit_dir: Path, shards: int, roots: list[str], ignores: list[str]) -> list[str]:
    problems: list[str] = []
    reports = shard_reports(junit_dir)
    for index in range(1, shards + 1):
        if index not in reports:
            problems.append(f"MISSING_SHARD_REPORT shard={index}/{shards}")
    for index in sorted(set(reports) - set(range(1, shards + 1))):
        problems.append(f"UNEXPECTED_SHARD_REPORT shard={index} (planned {shards})")
    seen: dict[str, int] = {}
    for index in sorted(reports):
        for name in report_files(reports[index][1]):
            if name in seen:
                problems.append(f"DUPLICATE_FILE {name} shards={seen[name]},{index}")
            else:
                seen[name] = index
    expected = expected_files(repo, roots, ignores)
    problems += [f"NOT_RUN {name}" for name in sorted(expected - set(seen))]
    problems += [f"UNEXPECTED_FILE {name}" for name in sorted(set(seen) - expected)]
    if not problems:
        print(f"CORE_SHARD_COVERAGE=ok shards={shards} files={len(seen)}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--junit-dir", type=Path, required=True)
    parser.add_argument("--root", dest="roots", action="append", required=True, help="bun test path (repeatable)")
    parser.add_argument("--ignore", dest="ignores", action="append", default=[], help="--path-ignore-patterns glob")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    if args.shards < 2:
        parser.error("--shards must be at least 2")
    try:
        problems = check(args.repo, args.junit_dir, args.shards, args.roots, args.ignores)
    except (ValueError, ET.ParseError) as error:
        problems = [f"UNREADABLE_REPORT {error}"]
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(f"CORE_SHARD_COVERAGE=fail problems={len(problems)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
