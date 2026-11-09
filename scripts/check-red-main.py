#!/usr/bin/env python3
"""REDMAINLAND1: report a recorded red release on origin/main at every commit; never block the save.

SAVEALONGSIDE1 (J-2026-11-08-11): saving and building run alongside a red release. The red verdict stops the
release it judged (release-local requires a PASS for its exact source), not unrelated commits, so the line keeps
moving while the failing files are fixed.

Read-only: reuse the verdict store's validators and CULPRIT1 flake attribution;
never rerun a suite or fetch. Missing, incomplete or unreadable evidence is UNKNOWN.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parent


def load_store():
    spec = importlib.util.spec_from_file_location("red_main_store", SCRIPTS / "full-suite-verdict-store.py")
    if spec is None or spec.loader is None:
        raise ValueError("verdict reader unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def message_bead(store, message: str, label: str) -> str | None:
    for line in message.splitlines():
        key, separator, value = line.partition(":")
        if separator and key == label and store.BEAD_ID.fullmatch(value.strip()):
            return value.strip()
    return None


def git(store, repo: Path, *args: str) -> str:
    # Retain GIT_INDEX_FILE: commit --only supplies its real prospective index.
    result = store.run(["git", "-C", str(repo), *args], deadline_s=10, max_output_bytes=4 << 20)
    if result.rc != 0 or result.timed_out or result.truncated:
        raise ValueError("git evidence unavailable")
    return result.stdout.decode("utf-8", errors="strict").strip()


def latest(store, directory: Path, tree: str) -> dict | None:
    rows = []
    for path in directory.glob(f"{tree}.main.*.json"):
        entry, _reason = store.validate_record(path, judge_root=SCRIPTS.parent, tree=tree,
                                              role="main", exact_filename=True, historical=True)
        stamp = entry.get("timing", {}).get("started_ms", 0) if entry else 0
        if entry is not None:
            rows.append((stamp, path.name, entry))
    return max(rows, key=lambda row: row[:2])[2] if rows else None


def red_files(entry: dict | None) -> set[str]:
    if entry is None or entry["verdict"] != "FAIL":
        return set()
    rows = entry["evidence"]["files"]
    failures = {row["path"] for row in rows if row["rc"] != 0}
    culprit = entry.get("culprit", {})
    if culprit.get("method") == "flake-rerun":
        # CULPRIT1 reruns only a bounded subset. It does not clear untested failures.
        failures.difference_update(culprit["failing_files"])
    return failures


def is_red(entry: dict | None) -> bool:
    if entry is None or entry["verdict"] != "FAIL":
        return False
    return entry["exit_code"] != 0 and (
        bool(red_files(entry)) or bool(entry.get("minimum_run", {}).get("shortfalls"))
        or entry.get("culprit", {}).get("method") != "flake-rerun")


def first_red(store, repo: Path, directory: Path, base: str, entry: dict | None) -> tuple[str, str | None]:
    culprit = (entry or {}).get("culprit", {})
    if culprit.get("method") == "bisect":
        return culprit["sha"], culprit["bead"]
    # With no causal attribution, name the first observed red since the last
    # recorded green. Background verdicts may skip intermediate published heads.
    first = base
    for row in git(store, repo, "log", "--first-parent", "--max-count=128", "--format=%H:%T", base).splitlines():
        sha, tree = row.split(":", 1)
        prior = latest(store, directory, tree)
        if prior is None:
            continue
        if not is_red(prior):
            break
        first = sha
    message = git(store, repo, "log", "-1", "--format=%B", first)
    return first, message_bead(store, message, "Bead")


def check(store, repo: Path, base: str, message: Path) -> int:
    directory = store.cache_directory(repo, None)
    tree = git(store, repo, "rev-parse", base + "^{tree}")
    full = latest(store, directory, tree)
    if not is_red(full):
        if full is None:
            print(f"commit-gate: UNKNOWN release verdict for origin/main {base[:12]} (absent, pending or unreadable)", file=sys.stderr)
        return 0
    files = red_files(full)
    first, bead = first_red(store, repo, directory, base, full)
    detail = f"origin/main {base[:12]} is RED; first recorded red commit {first}; bead {bead or 'none'}; failing tests: {', '.join(sorted(files)) or '(no failing file recorded)'}"
    trailer = message_bead(store, message.read_text(encoding="utf-8"), "Fixes-Red")
    changed = set(git(store, repo, "diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD").rstrip("\0").split("\0"))
    culprit = (full or {}).get("culprit", {})
    culprit_files = set(culprit.get("failing_files", [])) if culprit.get("method") == "bisect" else set()
    if trailer or changed.intersection(files | culprit_files):
        print(f"commit-gate: RED FIX admitted: {detail}", file=sys.stderr)
        return 0
    print(f"commit-gate: RED release verdict (releases wait, saves continue): {detail}. Fix the failing files and carry Fixes-Red: <bead-id> on the repair.", file=sys.stderr)
    return 0


def main() -> int:
    try:
        repo, base, message = Path(sys.argv[1]).resolve(), sys.argv[2], Path(sys.argv[3])
        return check(load_store(), repo, base, message)
    except Exception as error:
        # A broken store must never turn the main branch into an unrepairable gate.
        print(f"commit-gate: UNKNOWN release verdict ({type(error).__name__}: {str(error).splitlines()[0] if str(error) else 'read error'})", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
