#!/usr/bin/env python3
"""SKIPTEST1: audit the candidate index, never unstaged test or policy bytes.

Repositories opt in with .github/test-selection.json. A policy removed from an
already opted-in index is a refusal, not a way to turn the check off. All Git
reads respect the caller's GIT_INDEX_FILE (including commit --only indexes).
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

from kitlib_run import RunResult, run
from kitlib_tmp import owned_tmp

POLICY = ".github/test-selection.json"


class SelectionFailure(Exception):
    """A staged snapshot or checker could not be judged completely."""


def checked(argv: list[str], repo: Path) -> RunResult:
    result = run(argv, cwd=repo, deadline_s=120, max_output_bytes=1024 * 1024)
    if result.timed_out or result.killed or result.truncated or result.total_truncated:
        raise SelectionFailure("incomplete output or deadline while preparing the staged snapshot")
    return result


def git(repo: Path, *args: str) -> RunResult:
    return checked(["git", "-C", str(repo), *args], repo)


def require_success(result: RunResult, operation: str) -> None:
    if result.rc != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise SelectionFailure(f"{operation} failed (rc {result.rc}): {detail}")


def audit_staged(repo: Path) -> int:
    staged_policy = git(repo, "ls-files", "--error-unmatch", "--", POLICY)
    identity = git(repo, "rev-parse", "--show-toplevel")
    require_success(identity, "resolving the candidate repository")
    if Path(identity.stdout.decode("utf-8").strip()).resolve() != repo:
        raise SelectionFailure("the candidate path is not its own repository root")
    if staged_policy.rc not in (0, 1):
        require_success(staged_policy, "reading the staged policy entry")
    if staged_policy.rc != 0:
        previous_policy = git(repo, "cat-file", "-e", f"HEAD:{POLICY}")
        if previous_policy.rc == 0:
            raise SelectionFailure("the candidate deletes its required test-selection policy")
        return 0

    here = Path(__file__).resolve().parent
    checker = here / "selection-coverage.ts"
    if not checker.is_file() or not (here / "affected-tests.ts").is_file():
        raise SelectionFailure("installed selection sidecars are missing; reinstall the commit hooks")
    tree = git(repo, "write-tree")
    require_success(tree, "reading the candidate index")
    tree_id = tree.stdout.decode("ascii").strip()
    with owned_tmp("staged-selection") as directory:
        temporary = Path(directory)
        archive = temporary / "candidate.tar"
        candidate = temporary / "tree"
        candidate.mkdir()
        packed = git(repo, "archive", "--format=tar", f"--output={archive}", tree_id)
        require_success(packed, "archiving the candidate index")
        extracted = checked(["tar", "-xf", str(archive), "-C", str(candidate)], repo)
        require_success(extracted, "extracting the candidate index")
        # The graph scanner needs neither a repository nor the parent's private index.
        scanner_env = {key: value for key, value in os.environ.items()
                       if key not in ("GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "BEADS_DB")}
        result = run(["bun", "run", "--no-env-file", "--config=/dev/null", str(checker),
                      "--root", str(candidate), "--all"],
                     cwd=candidate, env=scanner_env, deadline_s=120,
                     max_output_bytes=1024 * 1024)
        if result.timed_out or result.killed or result.truncated or result.total_truncated:
            raise SelectionFailure("staged coverage checker did not return complete evidence")
        sys.stdout.buffer.write(result.stdout)
        sys.stderr.buffer.write(result.stderr)
        if result.rc != 0:
            raise SelectionFailure(f"staged coverage checker refused (rc {result.rc})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    args = parser.parse_args()
    try:
        return audit_staged(args.repo.resolve())
    except (OSError, ValueError, SelectionFailure) as error:
        print(f"SELECTION_GAP {POLICY}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
