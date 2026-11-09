#!/usr/bin/env python3
"""KITGATE1: judge a repository's declared affected Python selftests on an exact export."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import runpy
import sys
import time

from kitlib_run import run
from kitlib_tmp import owned_tmp
import pysafe

MAP = ".omp-kit/affected-tests.json"
HERE = Path(__file__).resolve().parent
# cc_selftest normally takes 4–7 minutes under load; allow a full hour, never defer it.
SELFTEST_DEADLINE_S = 3600
CODE_SUFFIXES = {".py", ".sh", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs"}


def checked(argv: list[str], *, cwd: Path, deadline: int = 30) -> bytes:
    result = run(argv, cwd=str(cwd), deadline_s=deadline, max_output_bytes=16 << 20)
    if result.rc != 0 or result.timed_out or result.killed or result.truncated:
        raise ValueError("command failed or incomplete: " + repr(argv) + " " + result.stderr.decode(errors="replace"))
    return result.stdout


def git(repo: Path, *args: str) -> bytes:
    return checked(["git", "-C", str(repo), *args], cwd=repo)


def relative(value: object) -> str:
    if (not isinstance(value, str) or not value or any(c.isspace() for c in value)
            or "\\" in value or value.startswith("-") or PurePosixPath(value).is_absolute()
            or any(part in (".", "..") for part in value.split("/"))):
        raise ValueError("affected map requires safe repository-relative paths")
    return value


def selection(archive: Path, changed: list[str]) -> list[str]:
    declaration = json.loads((archive / MAP).read_text())
    if (not isinstance(declaration, dict) or set(declaration) != {"version", "rules", "sibling_selftests"}
            or type(declaration["version"]) is not int or declaration["version"] != 1
            or declaration["sibling_selftests"] is not True
            or not isinstance(declaration["rules"], list) or not declaration["rules"]):
        raise ValueError("invalid affected-tests map version 1")
    rules = []
    for rule in declaration["rules"]:
        if not isinstance(rule, dict) or set(rule) != {"prefix", "tests"}:
            raise ValueError("invalid affected rule")
        prefix = relative(rule["prefix"].rstrip("/")) + "/"
        if not isinstance(rule["tests"], list) or not rule["tests"]:
            raise ValueError("affected rule has no tests")
        tests = [relative(path) for path in rule["tests"]]
        if any(not path.endswith("_selftest.py") for path in tests):
            raise ValueError("declared suites must be Python *_selftest.py files")
        rules.append((prefix, tests))
    selected: set[str] = set()
    uncovered = []
    for path in changed:
        if PurePosixPath(path).suffix.lower() in {".md", ".rst", ".txt"}:
            continue
        matched = False
        for prefix, tests in rules:
            if path.startswith(prefix):
                selected.update(tests)
                matched = True
        candidate = PurePosixPath(path)
        sibling = str(candidate.with_name(candidate.stem + "_selftest.py"))
        if path.endswith("_selftest.py") and (archive / path).is_file():
            selected.add(path)
            matched = True
        elif (archive / sibling).is_file():
            selected.add(sibling)
            matched = True
        if path == MAP:
            selected.update(test for _, tests in rules for test in tests)
        if not matched and candidate.suffix in CODE_SUFFIXES:
            uncovered.append(path)
    if uncovered:
        raise ValueError("NO_AFFECTED_TESTS: " + ", ".join(uncovered))
    for path in selected:
        suite = archive / path
        if not suite.is_file() or suite.is_symlink() or not suite.resolve().is_relative_to(archive):
            raise ValueError("declared selftest missing or outside export: " + path)
    return sorted(selected)


def judge(repo: Path, tip: str, base: str | None) -> None:
    commit = git(repo, "rev-parse", "--verify", tip + "^{commit}").decode().strip()
    base = git(repo, "rev-parse", "--verify", base + "^{commit}").decode().strip() if base else ""
    declared = git(repo, "ls-tree", "--name-only", commit, "--", MAP).decode().strip()
    if not declared:
        if base and git(repo, "ls-tree", "--name-only", base, "--", MAP).strip():
            raise ValueError("affected-tests declaration removed")
        return
    diff = (["diff", "--name-only", "-z", base, commit] if base else
            ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit])
    changed = [relative(path) for path in git(repo, *diff).decode().split("\0") if path]
    gitdir = Path(git(repo, "rev-parse", "--absolute-git-dir").decode().strip())
    scratch_root = repo / "var" / "agent-tmp"
    scratch_root.mkdir(parents=True, exist_ok=True)
    with owned_tmp("declared-gate", root=str(scratch_root)) as directory:
        work = Path(directory)
        archive = work / "archive"
        archive.mkdir()
        checked(["git", "-C", str(repo), "archive", "--format=tar", "--output=" + str(work / "source.tar"), commit], cwd=repo)
        checked(["tar", "-xf", str(work / "source.tar"), "-C", str(archive)], cwd=repo)
        tests = selection(archive, changed)
        if not tests:
            print("FRESH-GATE: DOCS_ONLY: no affected selftests; no observation recorded", flush=True)
            return
        # A fixture must never discover the source checkout's Git/tracker authority.
        checked(["git", "init", "-q", str(archive)], cwd=archive)
        tmp = archive / "var" / "agent-tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        metrics = runpy.run_path(str(HERE / "suite-metrics.py"))
        rows = []
        started = time.time_ns() // 1_000_000
        load = list(os.getloadavg())
        tree = git(repo, "rev-parse", commit + "^{tree}").decode().strip()
        previous_tmp = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = str(tmp)
        try:
            for index, path in enumerate(tests):
                record = work / (str(index) + ".json")
                print("affected selftest: " + path + " commit=" + commit, flush=True)
                rc = metrics["execute"](argparse.Namespace(
                    command=["nice", "-n", "10", "python3", "-B", path], record=str(record),
                    path=path, runner="python3", tree=tree, cwd=str(archive),
                    deadline=SELFTEST_DEADLINE_S, workers=1, wait_ms=0, loopback_port=None))
                if rc != 0:
                    raise ValueError("RED selftest: " + path + " producer_rc=" + str(rc))
                rows.append(json.loads(record.read_text()))
        finally:
            if previous_tmp is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = previous_tmp
        if not metrics["complete_records"](rows, tests):
            raise ValueError("incomplete selftest evidence")
        (work / "files.json").write_text(json.dumps(rows))
        (work / "declared").write_text("\n".join(tests) + "\n")
        digest = hashlib.sha256()
        for name in ("declared-affected-gate.py", "fresh-gate-ledger.py", "suite-metrics.py",
                     "suite-hermetic-env.sh", "fixed-env.sh", "kitlib_run.py", "kitlib_tmp.py", "pysafe.py"):
            digest.update(name.encode() + b"\0" + (HERE / name).read_bytes())
        environment = dict(os.environ, METRICS=str(work / "files.json"), DECLARED=str(work / "declared"),
                           START_MS=str(started), LOAD_START=json.dumps(load), WORKER_COUNT="0",
                           LEDGER=str(gitdir / "omp-kit" / "fresh-gate-runs.jsonl"), RUN_COMMIT=commit,
                           RUN_BASE=base, RUN_CHANGED="\n".join(changed), RUN_TESTS=str(len(tests)),
                           RUN_FILES=str(len(tests)), RUN_RC="0", JUDGE=str(HERE / "declared-affected-gate.py"),
                           JUDGE_ID=digest.hexdigest(), GATE_PHASES=str(work / "phases.jsonl"), WORKDIR=str(work))
        result = run([sys.executable, "-B", str(HERE / "fresh-gate-ledger.py")], env=environment,
                     cwd=str(repo), deadline_s=30)
        sys.stdout.buffer.write(result.stdout)
        sys.stderr.buffer.write(result.stderr)
        if result.rc != 0 or result.timed_out or result.killed or result.truncated:
            raise ValueError("cannot record complete gate observation")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--commit")
    parser.add_argument("--base")
    args = parser.parse_args()
    try:
        # GIT_DIR/GIT_WORK_TREE would redirect the `git -C` reads below, so a
        # caller setting them is refused. BEADS_DB is deliberately unchecked:
        # this judge never consults a tracker (git objects and the committed
        # map only), and the repo's own harness exports BEADS_DB for its stub
        # br; refusing on it would refuse every harnessed real push (KITGATE1).
        for name in ("GIT_DIR", "GIT_WORK_TREE"):
            if name in os.environ:
                raise ValueError("caller authority is set: " + name)
        repo = Path(args.repo).resolve(strict=True)
        if args.commit:
            judge(repo, args.commit, args.base)
        else:
            outcome, protocol, truncated = pysafe.read_stdin(timeout=30, cap_bytes=1 << 20)
            if outcome != "OK" or truncated:
                raise ValueError("incomplete pre-push input")
            for line in protocol.decode().splitlines():
                fields = line.split()
                if len(fields) != 4:
                    raise ValueError("invalid pre-push input")
                _, tip, _, base = fields
                if set(tip) == {"0"}:
                    continue
                judge(repo, tip, None if set(base) == {"0"} else base)
        return 0
    except (OSError, ValueError, TypeError, KeyError) as error:
        print("FRESH-GATE: RED: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
