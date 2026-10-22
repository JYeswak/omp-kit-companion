#!/usr/bin/env python3
"""br-update-lint.py -- LINTGATE1 update path (ompkit-fp72.19.1.28).

Gate content edits to a bead (`br update ID ...`) on the per-bead
bead-lint subset before the write lands. Invoked by br-shim.sh; also
usable directly as a kit `bead update` verb.

Exit contract (shim honors it):
  0  admit (no content flags, or prospective bead passes)
  4  LINT_REFUSED (prospective bead fails; check names on stderr)
  3  UNVERIFIED (infra error reading the tracker; shim passes through
     with a warning, never refusing on a broken probe)

Only lint-relevant content flags trigger evaluation: --title,
-d/--description/--body, --description-file, --acceptance-criteria,
--add-acceptance, --set-labels/--add-label/--remove-label, -t/--type.
Workflow flags (--status/--priority/--assignee/--owner/--claim) and edge
flags (--parent) never newly fail the gated checks and pass through, so
claiming a failing bead for repair is never deadlocked by this gate.

Reads are live (`br show`, `br list`); no JSONL flush is involved, so a
fixed bead passes immediately (LINTGATE1 acceptance 2).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys


def run(cmd: list[str], cwd: str, timeout: int = 60) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
            stdin=subprocess.DEVNULL,  # pysafe: leaf exec to native br; timeout bounds the wait, DEVNULL stdin
        )
        return proc.returncode, proc.stdout, proc.stderr
    except (OSError, subprocess.SubprocessError) as exc:
        return 127, "", str(exc)


def split_csv(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for value in values or []:
        out.extend(
            token.strip() for token in value.split(",") if token.strip())
    return out


def parse_update(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("subcommand", nargs="?")
    parser.add_argument("bead_id", nargs="?")
    parser.add_argument("--status")
    parser.add_argument("--title")
    parser.add_argument("-d", "--description", "--body", dest="description")
    parser.add_argument("--description-file")
    parser.add_argument("--acceptance-criteria", "--acceptance",
                        dest="acceptance")
    parser.add_argument("--add-acceptance", action="append", default=[])
    parser.add_argument("--set-labels")
    parser.add_argument("--add-label", action="append", default=[])
    parser.add_argument("--remove-label", action="append", default=[])
    parser.add_argument("-t", "--type")
    args, _ = parser.parse_known_args(argv)
    return args


def has_content_flags(args: argparse.Namespace) -> bool:
    # TIMEAC1 is a lifecycle gate: review entry is linted even when the
    # mutation contains workflow-only flags.
    return any([
        args.status == "in_review",
        args.title is not None,
        args.description is not None,
        args.description_file is not None,
        args.acceptance is not None,
        bool(args.add_acceptance),
        args.set_labels is not None,
        bool(args.add_label),
        bool(args.remove_label),
        args.type is not None,
    ])


def show_bead(real: str, project: str, db: str, bead_id: str) -> dict:
    cmd = [real, "show", bead_id, "--json"]
    if db:
        cmd.extend(["--db", db])
    rc, out, err = run(cmd, project)
    if rc != 0:
        raise RuntimeError(f"br show failed rc={rc}: {(err or out)[:300]}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br show unparsable: {exc}")
    record = data[0] if isinstance(data, list) else data
    if not isinstance(record, dict) or record.get("id") != bead_id:
        raise RuntimeError(f"br show returned no such bead: {bead_id}")
    return record


def tracker_ids(real: str, project: str, db: str) -> set[str]:
    cmd = [real, "list", "--status", "all", "--deferred", "--limit", "0",
           "--json"]
    if db:
        cmd.extend(["--db", db])
    rc, out, err = run(cmd, project)
    if rc != 0:
        raise RuntimeError(f"br list failed rc={rc}: {(err or out)[:300]}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"br list unparsable: {exc}")
    rows = data.get("issues", data) if isinstance(data, dict) else data
    return {row["id"] for row in rows if isinstance(row, dict) and row.get("id")}


def prospective(
    live: dict, args: argparse.Namespace, project: str
) -> dict:
    bead = {
        "id": live["id"],
        "title": live.get("title") or "",
        "status": live.get("status") or "open",
        "priority": live.get("priority", 2),
        "issue_type": args.type or live.get("issue_type") or "task",
        "labels": list(live.get("labels") or []),
        "description": live.get("description") or "",
        "acceptance_criteria": live.get("acceptance_criteria") or "",
        "dependencies": [
            {
                "depends_on_id": dep.get("depends_on_id", dep.get("id")),
                "type": dep.get("type", dep.get("dependency_type")),
            }
            for dep in (live.get("dependencies") or [])
        ],
    }
    if args.title is not None:
        bead["title"] = args.title
    if args.description_file is not None:
        path = args.description_file
        if not os.path.isabs(path):
            path = os.path.join(project, path)
        try:
            with open(path, encoding="utf-8") as handle:
                bead["description"] = handle.read()
        except (OSError, UnicodeError) as exc:
            raise RuntimeError(f"cannot read description file: {exc}")
    elif args.description is not None:
        bead["description"] = args.description
    if args.acceptance is not None:
        bead["acceptance_criteria"] = args.acceptance
    for text in args.add_acceptance:
        # br stores --add-acceptance as a new "- [ ] <text>" box.
        bead["acceptance_criteria"] += f"\n- [ ] {text}"
    if args.set_labels is not None:
        bead["labels"] = split_csv([args.set_labels])
    else:
        bead["labels"].extend(split_csv(args.add_label))
        bead["labels"] = [
            label for label in bead["labels"]
            if label not in set(split_csv(args.remove_label))
        ]
    return bead


def main(argv: list[str]) -> int:
    real = os.environ.get("BR_UPDATE_REAL", "br")
    project = os.environ.get("BR_UPDATE_PROJECT", os.getcwd())
    db = os.environ.get("BR_UPDATE_DB", "")
    args = parse_update(argv)
    if args.subcommand != "update" or not args.bead_id:
        return 0
    if not has_content_flags(args):
        return 0
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        from bead_lint import lint_bead_failures
        live = show_bead(real, project, db, args.bead_id)
        bead = prospective(live, args, project)
        byid = tracker_ids(real, project, db) | {bead["id"]}
        failures = lint_bead_failures(bead, byid)
    except Exception as exc:  # fail OPEN on probe failure, never refuse blind
        print(f"br-shim: LINT_GATE_UNVERIFIED {exc}", file=sys.stderr)
        return 3
    if failures:
        print(f"br-shim: LINT_REFUSED {','.join(failures)}: this edit "
              f"would leave {bead['id']} failing bead-lint; fix the named "
              f"checks and retry", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
