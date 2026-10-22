#!/usr/bin/env python3
"""br-create-lint.py -- LINTGATE1 create path at the act (ompkit-nskhp).

Evaluate a prospective `br create ...` against the per-bead bead-lint
subset before the write lands, through br_create_guard_core.lint_prospective.
Invoked by the kit-flywheel-guard extension for every bash tool call that
runs `br create`, so admission no longer depends on br-shim.sh being on PATH.

argv: the br argv after the binary (`create "title" -t task ...`).
Env: BR_CREATE_REAL (default `br`), BR_CREATE_PROJECT (default cwd),
BR_CREATE_DB (default: the `--db` on argv, else br's own discovery).

Exit contract (same as br-update-lint.py):
  0  admit (dry run, or prospective bead passes)
  4  LINT_REFUSED (prospective bead fails; check names on stderr)
  3  UNVERIFIED (unparseable create or unreadable tracker; the caller
     passes through with a warning, never refusing on a broken probe)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys


def argv_db(argv: list[str]) -> str:
    for index, word in enumerate(argv):
        if word == "--db" and index + 1 < len(argv):
            return argv[index + 1]
        if word.startswith("--db="):
            return word[len("--db="):]
    return ""


def tracker_issues(real: str, project: str, db: str) -> list[dict]:
    cmd = [real, "list", "--status", "all", "--deferred", "--limit", "0",
           "--json"]
    if db:
        cmd.extend(["--db", db])
    try:
        proc = subprocess.run(  # pysafe: leaf exec to native br list; timeout bounds the wait, DEVNULL stdin
            cmd, cwd=project, capture_output=True, text=True, timeout=60,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"br list failed: {exc}") from exc
    if proc.returncode != 0:
        raise RuntimeError(
            f"br list failed rc={proc.returncode}: {(proc.stderr or proc.stdout)[:300]}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br list unparsable: {exc}") from exc
    rows = data.get("issues", data) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise RuntimeError("br list returned an unsupported JSON envelope")
    return [row for row in rows if isinstance(row, dict) and row.get("id")]


def main(argv: list[str]) -> int:
    real = os.environ.get("BR_CREATE_REAL", "br")
    project = os.environ.get("BR_CREATE_PROJECT", os.getcwd())
    db = os.environ.get("BR_CREATE_DB", "") or argv_db(argv)
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        from br_create_guard_core import lint_prospective, parse_create_args
        parsed = parse_create_args(argv)
        if parsed["dry_run"]:
            return 0
        failures = lint_prospective(
            parsed, tracker_issues(real, project, db), project)
    except Exception as exc:  # fail OPEN on probe failure, never refuse blind
        print(f"br-create-lint: LINT_GATE_UNVERIFIED {exc}", file=sys.stderr)
        return 3
    if failures:
        print(f"br-create-lint: LINT_REFUSED {','.join(failures)}: this "
              f"create would add a bead failing bead-lint; fix the named "
              f"checks and retry", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
