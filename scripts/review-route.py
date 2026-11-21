#!/usr/bin/env python3
"""review-route.py -- REVIEWROUTE1 (ompkit-uikz9).

After a bead successfully enters in_review, assign a named non-author
reviewer of the same project and wake it with the exact verify command.

Seams reused, no new ones: the in_review admission in br-shim.sh (which
invokes `route` only after the transition succeeded), the roster at
fleet-roster.json sessions.<session>.seats plus model family, liveness
from the project's Agent Mail registration, load from live `br list
--status in_review` counts, and the existing review-age scorecard reader.

Rule (one): reviewer = a registered seat of the same project, excluding
the author AND the implementer, preferring a different model family when
available, ordered by least in_review load (stable tiebreak: seat name),
never the author. No new refusal: every trouble (no DONE citation,
unresolvable roster, empty registry, mail failure) records a PENDING
route and exits 0, so the handoff itself is never blocked.

Process spawns go through kitlib_run.run; no temp dirs are needed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib_run

DONE_RE = re.compile(r"DONE\s+(\S+?)@([0-9a-f]{7,40})(?::|\s|$)")


def run(cmd: list[str], cwd: str, timeout: int = 60) -> tuple[int, str, str]:
    result = kitlib_run.run(
        cmd, cwd=cwd, deadline_s=timeout, stdin=b"", max_output_bytes=4 * 1024 * 1024
    )
    out = result.stdout.decode("utf-8", "replace") if result.stdout else ""
    err = result.stderr.decode("utf-8", "replace") if result.stderr else ""
    return result.rc if result.rc is not None else 3, out, err


def show_bead(real_br: str, db: str, bead_id: str, cwd: str) -> dict:
    rc, out, err = run([real_br, "--db", db, "show", bead_id, "--json"], cwd)
    if rc != 0:
        raise RuntimeError(f"br show {bead_id} rc={rc}: {err.strip()[:200]}")
    data = json.loads(out)
    if isinstance(data, list):
        data = data[0] if data else {}
    if not isinstance(data, dict):
        raise RuntimeError(f"br show {bead_id} returned no bead")
    return data


def in_review_loads(real_br: str, db: str, cwd: str) -> dict[str, int]:
    try:
        rc, out, _ = run(
            [real_br, "--db", db, "list", "--status", "in_review", "--json"], cwd
        )
        if rc != 0:
            return {}
        data = json.loads(out)
        rows = data.get("issues", data) if isinstance(data, dict) else data
        loads: dict[str, int] = {}
        for row in rows or []:
            name = row.get("assignee") if isinstance(row, dict) else None
            if name:
                loads[name] = loads.get(name, 0) + 1
        return loads
    except Exception:
        return {}


def registered_agents(project: str, cwd: str) -> set[str]:
    rc, out, _ = run(["am", "agents", "list", "--project", project, "--json"], cwd)
    if rc != 0:
        raise RuntimeError("am agents list failed")
    data = json.loads(out)
    found: set[str] = set()

    def walk(node: object) -> None:
        if isinstance(node, str):
            if node:
                found.add(node)
        elif isinstance(node, dict):
            for key in ("name", "agent", "id"):
                value = node.get(key)
                if isinstance(value, str) and value:
                    found.add(value)
                    break
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data.get("agents", data) if isinstance(data, dict) else data)
    return found


def family_of(model: str) -> str:
    return model.split("/")[0] if "/" in model else (model or "unknown")


def pick_reviewer(
    seats: dict[str, dict],
    author: str,
    implementer: str,
    registered: set[str],
    loads: dict[str, int],
    implementer_family: str,
) -> str | None:
    eligible = [
        name
        for name in seats
        if name in registered and name != author and name != implementer
    ]
    if not eligible:
        return None
    foreign_family = [
        name
        for name in eligible
        if family_of(str((seats[name] or {}).get("model", ""))) != implementer_family
    ]
    pool = foreign_family or eligible
    return sorted(pool, key=lambda n: (loads.get(n, 0), n))[0]


def resolve_session(
    fleet_watch_path: str, tracker_project: str
) -> tuple[str, str] | None:
    try:
        with open(fleet_watch_path) as fh:
            data = json.load(fh)
    except Exception:
        return None
    sessions = data.get("sessions", [])
    if isinstance(sessions, dict):
        sessions = sessions.values()
    for entry in sessions or []:
        if isinstance(entry, dict) and entry.get("repo") == tracker_project:
            name = entry.get("session")
            if name:
                return name, entry.get("repo", tracker_project)
    return None


def verify_command(bead_id: str, sha: str, code_repo: str, seat: str, fam: str) -> str:
    return (
        f"omp-kit verify {bead_id} --export {sha} --project {code_repo} "
        f"--actor {seat} --family {fam}"
    )


def cmd_route(args: argparse.Namespace) -> int:
    tracker = args.project or os.getcwd()
    actor = args.actor or os.environ.get("AGENT_NAME", "")
    tcomment = "\n".join(
        part
        for part in [args.tcomment, args.treason, os.environ.get("BR_ROUTE_TCOMMENT", "")]
        if part
    )
    real_br = args.real_br or os.environ.get("BR_ROUTE_REAL_BR", "br")
    pending_reasons: list[str] = []

    def pending(reason: str) -> int:
        msg = f"REVIEWROUTE PENDING {args.bead}: {reason}"
        try:
            run(
                [real_br, "--db", args.db, "comments", "add", args.bead,
                 "-m", msg, "--actor", actor],
                tracker,
            )
        except Exception as exc:
            print(f"review-route: pending record also failed: {exc}", file=sys.stderr)
        print(msg)
        return 0

    try:
        bead = show_bead(real_br, args.db, args.bead, tracker)
        author = str(bead.get("created_by") or "")
        implementer = str(bead.get("assignee") or actor)
        match = DONE_RE.search(tcomment)
        if not match:
            return pending("no DONE <repo>@<sha> citation on the transition")
        code_repo, sha = match.group(1), match.group(2)
        resolved = resolve_session(args.fleet_watch, tracker)
        session_name = args.session or (resolved[0] if resolved else None)
        try:
            with open(args.roster) as fh:
                roster = json.load(fh)
            seats = roster.get("sessions", {}).get(session_name or "", {}).get(
                "seats", {}
            )
            director = roster.get("sessions", {}).get(session_name or "", {}).get(
                "director", ""
            )
        except Exception:
            seats, director = {}, ""
        if not seats:
            return pending("roster session unresolvable, no candidate seats")
        try:
            registered = registered_agents(tracker, tracker)
        except Exception:
            return pending("agent registry unreadable, no live seats provable")
        impl_family = family_of(str((seats.get(implementer) or {}).get("model", "")))
        reviewer = pick_reviewer(
            seats, author, implementer, registered, in_review_loads(
                real_br, args.db, tracker), impl_family,
        )
        if reviewer is None:
            observer = args.observer or director or "observer"
            note = (
                f"no eligible registered non-author seat; implementer={implementer} "
                f"author={author}"
            )
            try:
                run(
                    ["am", "mail", "send", "--project", tracker, "--from", actor,
                     "--to", observer, "--subject",
                     f"REVIEWROUTE pending {args.bead}",
                     "--body", f"REVIEWROUTE PENDING {args.bead}: {note}"],
                    tracker,
                )
            except Exception as exc:
                print(f"review-route: observer mail failed: {exc}", file=sys.stderr)
            return pending(note + f"; routed to observer {observer}")
        fam = family_of(str((seats[reviewer] or {}).get("model", "")))
        command = verify_command(args.bead, sha, code_repo, reviewer, fam)
        msg = f"REVIEWROUTE {reviewer}: {command}"
        rc, _, err = run(
            [real_br, "--db", args.db, "comments", "add", args.bead,
             "-m", msg, "--actor", actor],
            tracker,
        )
        if rc != 0:
            return pending(f"reviewer record refused: {err.strip()[:160]}")
        rc, _, err = run(
            ["am", "mail", "send", "--project", tracker, "--from", actor,
             "--to", reviewer, "--subject", f"Verify {args.bead}",
             "--body", f"{reviewer}: {command}"],
            tracker,
        )
        if rc != 0:
            return pending(f"reviewer wake failed: {err.strip()[:160]}")
        print(msg)
        return 0
    except Exception as exc:
        print(f"review-route: {exc}", file=sys.stderr)
        return pending(str(exc)[:200])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="review-route.py")
    sub = parser.add_subparsers(dest="verb", required=True)
    route = sub.add_parser("route")
    route.add_argument("--bead", required=True)
    route.add_argument("--db", default=".beads/beads.db")
    route.add_argument("--project", default="")
    route.add_argument("--actor", default="")
    route.add_argument("--tcomment", default="")
    route.add_argument("--treason", default="")
    route.add_argument("--real-br", default="")
    route.add_argument("--session", default=os.environ.get("REVIEW_ROUTE_SESSION", ""))
    route.add_argument("--observer", default=os.environ.get("REVIEW_ROUTE_OBSERVER", ""))
    route.add_argument(
        "--roster",
        default=os.environ.get(
            "OMP_KIT_FLEET_ROSTER",
            str(
                Path.home()
                / ".claude"
                / "skills"
                / "omp-kit-orchestration"
                / "fleet-roster.json"
            ),
        ),
    )
    route.add_argument(
        "--fleet-watch",
        default=os.environ.get(
            "OMP_KIT_FLEET_WATCH_CONFIG",
            str(Path.home() / ".config" / "omp-kit" / "fleet-watch.json"),
        ),
    )
    args = parser.parse_args(argv)
    if args.verb == "route":
        return cmd_route(args)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
