#!/usr/bin/env python3
"""br-update-lint.py -- LINTGATE1 update path (ompkit-fp72.19.1.28).

Gate content edits to a bead (`br update ID ...`) on the per-bead
bead-lint subset before the write lands. Invoked by br-shim.sh; also
usable directly as a kit `bead update` verb.

Exit contract (shim honors it):
  0  admit (no content flags, or prospective bead passes)
  4  LINT_REFUSED (prospective bead fails; check names on stderr)
  3  UNVERIFIED (infra error reading the tracker; shim passes through
     with a warning, never refusing on a broken probe). A claim move is
     the exception: it needs a PASS, so a probe that cannot judge it exits 4.

Lint-relevant content flags trigger evaluation: --title,
-d/--description/--body, --description-file, --acceptance-criteria,
--add-acceptance, --set-labels/--add-label/--remove-label, -t/--type.
So does a claim move (CLAIMLINT ompkit-fp72.135.3.50 [b], J-2026-10-25-107:
no worker picks up a bead that does not pass bead lint): `--claim`, or
`--status in_progress` / `-s in_progress`. A claim on a bead that fails any
check is refused (exit 4), and so is a claim the gate cannot judge. Other
workflow flags (--priority/--assignee/--owner, parking with --status open)
and edge flags (--parent) never newly fail the gated checks and pass through.
`br update` takes several ids; every id is judged, so a passing first id
cannot carry a failing second one through.

Repair admission (LINTREPAIR ompkit-fp72.135.3.50 [a]): a content edit to a
bead that already fails is admitted when the checks it fails afterwards are a
strict subset of the checks it fails now (it repairs something and breaks
nothing), so a failing bead is repaired without claiming it. It never applies
when the same command carries --claim or --status.

`--status in_review` (ACPHASE1 ompkit-9e9w6 + PREGRADE1 ompkit-3s6d2): for
a bead created at or after ac_phase.AC_PHASE_CUTOVER the move is also
refused (exit 4) unless every [build]/[landed] item is ticked
(ac_phase.in_review_admission). When the tracker repo opts in with
`.omp/pregrade.json` = {"required": true}, it also needs a non-author
pregrade record matching the bead, its current AC digest, verdict PASS or
WAITING, within 24 h; an invalid opt-in file fails closed. The tracker repo
is the directory holding the `.beads` of the `--db` in use (BR_UPDATE_DB,
else BEADS_DB), else the nearest ancestor of the project dir holding a
`.beads` directory, else the project dir. The refusal codes
(AC_PHASE_UNTAGGED, AC_PHASE_MULTI, AC_UNTICKED_BUILD_LANDED,
PREGRADE_CONFIG_INVALID, PREGRADE_MISSING, PREGRADE_STALE,
PREGRADE_AC_CHANGED, PREGRADE_NOT_PASSING, PREGRADE_SELF) ride the
LINT_REFUSED line, each detailed on its own line; after any PREGRADE_*
refusal the opt-in file's optional "hint" (control characters stripped,
500 chars max) follows on a `PREGRADE_HINT` line. Legacy beads are admitted
with a one-line AC_PHASE_LEGACY notice.

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


# Every `br update` option that consumes a value (br 0.6), so intermixed
# parsing never mistakes a value such as `--actor NAME` for a bead id.
BR_UPDATE_VALUE_FLAGS = (
    "--design", "--prerequisites", "--check-acceptance", "--uncheck-acceptance",
    "--notes", "--append-notes", "--transition-comment", "-p", "--priority",
    "--assignee", "--owner", "--if-unchanged", "--due", "--defer", "--estimate",
    "--parent", "--external-ref", "--source-repo", "--source-repo-path",
    "--agent-context", "--session", "--agent-name", "--harness", "--model",
    "--db", "--actor", "--lock-timeout",
)


def native_status(value: str) -> str:
    """The status native br stores for a --status value (br 0.7.4, measured 2026-10-26):
    case-insensitive, with `inprogress` as an alias of in_progress. Any other spelling
    (in-progress, inreview, wip) is stored as a custom status, not a known one."""
    lowered = value.lower()
    return "in_progress" if lowered in ("in_progress", "inprogress") else lowered


def parse_update(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("subcommand", nargs="?")
    parser.add_argument("bead_ids", nargs="*")
    parser.add_argument("-s", "--status")
    parser.add_argument("--claim", action="store_true")
    # br's flag-only short options, declared so combined forms (-qs in_progress,
    # -qsin_progress, -vqs ...) split the way native br splits them.
    parser.add_argument("-q", "--quiet", action="store_true")
    parser.add_argument("-v", "--verbose", action="count", default=0)
    parser.add_argument("--title")
    parser.add_argument("-d", "--description", "--body", dest="description")
    parser.add_argument("--description-file")
    parser.add_argument("--acceptance-criteria", "--acceptance",
                        dest="acceptance")
    parser.add_argument("--add-acceptance", action="append", default=[])
    parser.add_argument("--set-labels", "--labels")
    parser.add_argument("--add-label", action="append", default=[])
    parser.add_argument("--remove-label", action="append", default=[])
    parser.add_argument("-t", "--type")
    for flag in BR_UPDATE_VALUE_FLAGS:
        parser.add_argument(flag, dest="ignored_" + flag.lstrip("-").replace("-", "_"))
    args, _ = parser.parse_known_intermixed_args(argv)
    if args.status is not None:
        args.status = native_status(args.status)
    args.bead_id = args.bead_ids[0] if args.bead_ids else None
    return args


def is_claim_move(args: argparse.Namespace) -> bool:
    """A move that starts work on the bead: J-107 requires a lint PASS first.
    The status is already in native br's spelling (parse_update)."""
    return bool(args.claim) or args.status == "in_progress"


def has_content_flags(args: argparse.Namespace) -> bool:
    # TIMEAC1 is a lifecycle gate: review entry is linted even when the
    # mutation contains workflow-only flags. CLAIMLINT: so is a claim move.
    return any([
        is_claim_move(args),
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
        "created_at": live.get("created_at"),
        "assignee": live.get("assignee"),
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


def tracker_repo(project: str, db: str) -> str:
    """The repo whose tracker this update writes (see module docstring)."""
    if db:
        beads_dir = os.path.dirname(os.path.realpath(db))
        if os.path.basename(beads_dir) == ".beads":
            return os.path.dirname(beads_dir)
    here = os.path.realpath(project)
    for _ in range(here.count(os.sep) + 1):  # one step per path component
        if os.path.isdir(os.path.join(here, ".beads")):
            return here
        here = os.path.dirname(here)
    return os.path.realpath(project)


def main(argv: list[str]) -> int:
    real = os.environ.get("BR_UPDATE_REAL", "br")
    project = os.environ.get("BR_UPDATE_PROJECT", os.getcwd())
    db = os.environ.get("BR_UPDATE_DB", "")
    args = parse_update(argv)
    if args.subcommand != "update" or not args.bead_ids:
        return 0
    if not has_content_flags(args):
        return 0
    claim = is_claim_move(args)
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    try:
        from bead_lint import lint_bead_failures
        import ac_phase
        byid = tracker_ids(real, project, db) | set(args.bead_ids)
    except Exception as exc:
        return unverified(exc, claim, args.bead_ids)
    # br update takes several ids: every one is judged, and the first refusal wins.
    for bead_id in args.bead_ids:
        rc = judge(bead_id, args, claim, real, project, db, byid, lint_bead_failures, ac_phase)
        if rc != 0:
            return rc
    return 0


def unverified(exc: Exception, claim: bool, bead_ids: list[str]) -> int:
    if claim:
        # CLAIMLINT: a claim needs a PASS, so a gate that cannot judge it refuses.
        print(f"br-shim: LINT_REFUSED LINT_UNAVAILABLE: this claim on {','.join(bead_ids)} "
              f"cannot be admitted because bead-lint could not run ({exc}); retry once the "
              f"tracker is readable", file=sys.stderr)
        return 4
    print(f"br-shim: LINT_GATE_UNVERIFIED {exc}", file=sys.stderr)  # fail OPEN for content edits
    return 3


def judge(bead_id: str, args: argparse.Namespace, claim: bool, real: str, project: str,
          db: str, byid: set[str], lint_bead_failures, ac_phase) -> int:
    try:
        live = show_bead(real, project, db, bead_id)
        bead = prospective(live, args, project)
        failures = lint_bead_failures(bead, byid)
        # LINTREPAIR: the live bead's own failures, judged the same way, are the
        # baseline a repair is measured against (content edits only).
        repair_base = (lint_bead_failures(prospective(live, parse_update([]), project), byid)
                       if failures and args.status is None and not args.claim else None)
        admission = (ac_phase.in_review_admission(
            bead, repo=tracker_repo(project, db or os.environ.get("BEADS_DB", "")))
            if args.status == "in_review" else None)
    except Exception as exc:
        return unverified(exc, claim, [bead_id])
    details: list[str] = []
    if admission is not None:
        if admission["notice"]:
            print(f"br-shim: {admission['notice']}", file=sys.stderr)
        lint_tagged = any(f.startswith("l-ac-phase:") for f in failures)
        for code, detail in admission["refusals"]:
            # check l already names untagged/multi items for enforced beads.
            if lint_tagged and code in ("AC_PHASE_UNTAGGED", "AC_PHASE_MULTI"):
                continue
            failures.append(code)
            details.append(f"br-shim: {code} {detail}")
        if admission["hint"]:
            # The repo's own instructions for producing a pregrade (.omp/pregrade.json "hint").
            details.append(f"br-shim: PREGRADE_HINT {admission['hint']}")
    if failures and repair_base is not None:
        after = {f.split(":", 1)[0] for f in failures}
        before = {f.split(":", 1)[0] for f in repair_base}
        if after < before:
            print(f"br-shim: LINT_REPAIR_ADMITTED {bead['id']}: this edit clears "
                  f"{','.join(sorted(before - after))} and adds no failure; still failing "
                  f"{','.join(sorted(after))}, so a claim or review move stays refused until those pass",
                  file=sys.stderr)
            return 0
    if failures and claim:
        print(f"br-shim: LINT_REFUSED {','.join(failures)}: this claim would start work on "
              f"{bead['id']} while it fails bead-lint (J-2026-10-25-107); repair it first "
              f"(a content-only edit that clears a failure and adds none is admitted), then claim",
              file=sys.stderr)
        for line in details:
            print(line, file=sys.stderr)
        return 4
    if failures:
        print(f"br-shim: LINT_REFUSED {','.join(failures)}: this edit "
              f"would leave {bead['id']} failing bead-lint or in_review "
              f"admission; fix the named checks and retry", file=sys.stderr)
        for line in details:
            print(line, file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
