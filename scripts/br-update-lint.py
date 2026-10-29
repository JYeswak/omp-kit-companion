#!/usr/bin/env python3
"""br-update-lint.py -- LINTGATE1 update path (ompkit-fp72.19.1.28).

Gate content edits to a bead (`br update ID ...`) on the per-bead
bead-lint subset before the write lands. Invoked by the kit-flywheel-guard
extension and, for the REPLAYABLE1 claim gate only, by br-shim.sh; also
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
claiming a failing bead for repair is never deadlocked by them; only the
REPLAYABLE1 claim gate below judges a claim.

Repair admission (LINTREPAIR ompkit-fp72.135.3.50): a content edit to a bead
that already fails is admitted when the checks it fails afterwards are a
strict subset of the checks it fails now (it repairs something and breaks
nothing), so a description repair is not frozen behind a failure only a
different fix can clear. It never applies when the same command carries
--claim or --status: those moves are judged exactly as before.

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

REPLAYABLE1 (ompkit-fp72.135.3.71): on an edit carrying --acceptance-criteria
or --add-acceptance, a non-[v] box the edit adds or changes that `omp-kit
verify` cannot replay (no backticked command, or a tag run other than one
scope letter then one known phase) fails r-verify-replayable naming the box
and its corrected shape. Boxes left as stored are reported on an
ACCEPTANCE_NOT_REPLAYABLE_LEGACY line and never refused; REPLAYABLE_EXIT_ONLY
names boxes with no expected outcome. The box grammar is src/verify.ts's, run
through scripts/box-lint.ts.

Claim gate (REPLAYABLE1 revision, J-2026-10-29-22 'Migrate at claim,
enforced'): `--claim` and `--status in_review` are refused (exit 4,
REFUSED_NOT_REPLAYABLE on the LINT_REFUSED line) unless `omp-kit verify` can
replay the bead's acceptance as it would stand after the command: at least
one non-[v] box, and every such box replayable. Each bad box is named on its
own REFUSED_NOT_REPLAYABLE line with the corrected shape; once the boxes are
rewritten the claim is admitted. With BR_UPDATE_REPLAYABLE_ONLY=1 (the
shim's call) only this gate runs.

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
    parser.add_argument("--claim", action="store_true")
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
    if args.subcommand != "update" or not args.bead_id:
        return 0
    # REPLAYABLE1 claim gate (J-2026-10-29-22): a claim or an in_review move
    # needs acceptance `omp-kit verify` can replay. br-shim.sh runs only this
    # gate (BR_UPDATE_REPLAYABLE_ONLY=1); content edits get the full lint.
    claim_gate = args.claim or args.status == "in_review"
    replay_only = os.environ.get("BR_UPDATE_REPLAYABLE_ONLY") == "1"
    full = not replay_only and has_content_flags(args)
    if not (full or claim_gate):
        return 0
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    failures: list[str] = []
    replay_notices: list[str] = []
    claim_refusal: list[str] = []
    repair_base = None
    admission = None
    try:
        from bead_lint import (BoxGrammarUnavailable, lint_bead_failures,
                               replayable_claim_refusal, replayable_findings)
        import ac_phase
        live = show_bead(real, project, db, args.bead_id)
        bead = prospective(live, args, project)
        if claim_gate:
            try:
                claim_refusal = replayable_claim_refusal(bead)
            except BoxGrammarUnavailable as exc:
                replay_notices.append(f"REPLAYABLE_UNVERIFIED {exc}")
        if full:
            byid = tracker_ids(real, project, db) | {bead["id"]}
            failures = lint_bead_failures(bead, byid)
            # REPLAYABLE1: only a box this edit adds or changes can fail; boxes
            # left as stored are reported, never refused. An edit that does not
            # touch acceptance cannot add a box, so it is not judged here (the
            # legacy backlog is bead_lint.py --replayable-report's to list).
            replay_failures: list[str] = []
            if args.acceptance is not None or args.add_acceptance:
                try:
                    replay_failures, notices = replayable_findings(
                        bead, live.get("acceptance_criteria") or "")
                    replay_notices.extend(notices)
                except BoxGrammarUnavailable as exc:
                    replay_notices.append(f"REPLAYABLE_UNVERIFIED {exc}")
            failures = sorted(failures + replay_failures)
            # LINTREPAIR: the live bead's own failures, judged the same way, are the
            # baseline a repair is measured against (content edits only).
            repair_base = (lint_bead_failures(prospective(live, parse_update([]), project), byid)
                           if failures and args.status is None and not args.claim else None)
            admission = (ac_phase.in_review_admission(
                bead, repo=tracker_repo(project, db or os.environ.get("BEADS_DB", "")))
                if args.status == "in_review" else None)
    except Exception as exc:  # fail OPEN on probe failure, never refuse blind
        print(f"br-shim: LINT_GATE_UNVERIFIED {exc}", file=sys.stderr)
        return 3
    for notice in replay_notices:
        print(f"br-shim: {notice}", file=sys.stderr)
    details: list[str] = []
    if claim_refusal:
        failures.insert(0, "REFUSED_NOT_REPLAYABLE")
        move = "claimed" if args.claim else "moved to in_review"
        details.append(
            f"br-shim: REFUSED_NOT_REPLAYABLE {bead['id']}: omp-kit verify cannot replay this "
            f"bead's acceptance, so it cannot be {move} until each box below is rewritten in the "
            f"verify grammar (keep every obligation word for word; J-2026-10-29-22), then retry")
        details.extend(f"br-shim: REFUSED_NOT_REPLAYABLE {line}" for line in claim_refusal)
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
