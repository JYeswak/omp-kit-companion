#!/usr/bin/env python3
"""Guard single-issue br creates with duplicate, P0-budget and sweep checks."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import NoReturn
import unicodedata

import kitlib_lock  # sibling in scripts/ and in every release (KL08 persistent private resource locks)

SIMILARITY_THRESHOLD = 0.30
MIN_SHARED_TOKENS = 3
LOCK_TIMEOUT_SECONDS = 5.0
DEFAULT_P0_CAP = 15
SWEEP_THRESHOLD = 20
STOPWORDS = {
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "is",
    "it", "of", "on", "or", "the", "this", "to", "with", "without",
}


class AdmissionError(Exception):
    pass


def fail(message: str) -> int:
    print(f"br-shim: {message}", file=sys.stderr)
    return 4


def parse_priority(value: object) -> int:
    if type(value) is int and 0 <= value <= 4:
        return value
    if isinstance(value, str):
        normalized = value.strip().upper()
        if normalized.startswith("P"):
            normalized = normalized[1:]
        if normalized in {"0", "1", "2", "3", "4"}:
            return int(normalized)
    raise AdmissionError(f"malformed or unsupported priority: {value!r}")


def parse_timestamp(value: object) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise AdmissionError("tracker inventory has a missing creation timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise AdmissionError(f"tracker inventory has a malformed creation timestamp: {value!r}") from error
    return parsed.replace(tzinfo=dt.timezone.utc) if parsed.tzinfo is None else parsed


class CreateArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise AdmissionError(message)


def strip_custom_options(arguments: list[str]) -> list[str]:
    custom_options = {"--not-duplicate", "--comment-target", "--displaces"}
    forwarded = []
    index = 0
    while index < len(arguments):
        option, separator, _ = arguments[index].partition("=")
        if option in custom_options:
            index += 1 if separator else 2
        else:
            forwarded.append(arguments[index])
            index += 1
    return forwarded


def parse_create_args(argv: list[str]) -> dict:
    try:
        command_index = argv.index("create")
    except ValueError as error:
        raise AdmissionError("internal invocation did not contain `create`") from error

    prefix = list(argv[:command_index])
    raw = list(argv[command_index + 1:])
    parser = CreateArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("title_pos", nargs="?")
    parser.add_argument("--title", dest="title_flag")
    parser.add_argument("-t", "--type")
    parser.add_argument("--slug")
    parser.add_argument("-p", "--priority", default="2")
    parser.add_argument("-d", "--description", "--body", dest="description")
    parser.add_argument("--description-file")
    parser.add_argument("-a", "--assignee")
    parser.add_argument("--owner")
    parser.add_argument("-l", "--labels")
    parser.add_argument("--parent")
    parser.add_argument("--deps")
    parser.add_argument("-e", "--estimate")
    parser.add_argument("--due")
    parser.add_argument("--defer")
    parser.add_argument("--external-ref")
    parser.add_argument("-s", "--status", default="open")
    parser.add_argument("--acceptance-criteria", "--acceptance")
    parser.add_argument("--prerequisites")
    parser.add_argument("--agent-context")
    parser.add_argument("--file", "-f", dest="bulk_file")
    parser.add_argument("--agent-name")
    parser.add_argument("--harness")
    parser.add_argument("--model")
    parser.add_argument("--db")
    parser.add_argument("--actor")
    parser.add_argument("--lock-timeout")
    parser.add_argument("--not-duplicate", action="append", default=[])
    parser.add_argument("--comment-target", action="append", default=[])
    parser.add_argument("--displaces", action="append", default=[])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--ephemeral", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-daemon", action="store_true")
    parser.add_argument("--no-auto-flush", action="store_true")
    parser.add_argument("--no-auto-import", action="store_true")
    parser.add_argument("--allow-stale", action="store_true")
    parser.add_argument("--no-db", action="store_true")
    parser.add_argument("--verbose", "-v", "-vv", action="count", default=0)
    parser.add_argument("--quiet", "-q", action="store_true")
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument("--help", "-h", action="store_true")
    parsed = parser.parse_args(raw)

    title = parsed.title_flag if parsed.title_flag is not None else parsed.title_pos
    if parsed.title_flag is not None and parsed.title_pos is not None:
        raise AdmissionError("specify the create title once, positionally or with --title")
    dry_run = parsed.dry_run or parsed.help or any(option in prefix for option in ("--dry-run", "--help", "-h"))
    if parsed.bulk_file is not None and not dry_run:
        raise AdmissionError("bulk `br create --file` is not admitted by the single-issue guard; create each issue individually")
    if (title is None or not title.strip()) and not dry_run:
        raise AdmissionError("a non-empty title is required for guarded create")

    custom = {}
    for option, values in (
        ("--not-duplicate", parsed.not_duplicate),
        ("--comment-target", parsed.comment_target),
        ("--displaces", parsed.displaces),
    ):
        if len(values) > 1:
            raise AdmissionError(f"{option} may be supplied only once")
        if values:
            if not values[0]:
                raise AdmissionError(f"{option} requires a non-empty ID")
            custom[option] = values[0]
    if "--not-duplicate" in custom and "--comment-target" in custom:
        raise AdmissionError("choose either --not-duplicate or --comment-target, not both")
    priority = parse_priority(parsed.priority)
    status = parsed.status
    if "--displaces" in custom and (priority != 0 or status != "open"):
        raise AdmissionError("--displaces is valid only for a new open P0")
    return {
        "prefix": prefix,
        "forwarded": strip_custom_options(raw),
        "title": title or "",
        "priority": priority,
        "status": status,
        "issue_type": parsed.type,
        "labels": parsed.labels,
        "acceptance": parsed.acceptance_criteria,
        "deps": parsed.deps,
        "parent": parsed.parent,
        "description": parsed.description,
        "description_file": parsed.description_file,
        "custom": custom,
        "has_json": parsed.json or "--json" in prefix,
        "silent": parsed.silent or "--silent" in prefix,
        "quiet": parsed.quiet or "--quiet" in prefix or "-q" in prefix,
        "dry_run": dry_run,
    }


def read_prospective_description(
    parsed: dict, project: str
) -> str:
    """Description the create would store (LINTGATE1 prospective read)."""
    if not parsed["description_file"]:
        return parsed["description"] or ""
    path = Path(parsed["description_file"])
    if not path.is_absolute():
        path = Path(project) / path
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise AdmissionError(
            f"cannot read lint-gated description file: {error}") from error
    if len(content.encode("utf-8")) > 1_000_000:
        raise AdmissionError("description file exceeds the 1 MB limit")
    return content


def prospective_bead(
    parsed: dict, project: str, now: dt.datetime | None = None
) -> dict:
    """The bead record this create would store, JSONL-shaped for lint.

    created_at is the admission clock, so a create at or after the ACPHASE1
    cutover is an ENFORCED bead: an untagged acceptance item is refused
    l-ac-phase:AC_PHASE_UNTAGGED naming the line (bead_lint check l).
    """
    created = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    labels = [token.strip() for token in (parsed["labels"] or "").split(",")
              if token.strip()]
    deps: list[dict] = []
    if parsed["parent"]:
        deps.append({"depends_on_id": parsed["parent"],
                     "type": "parent-child"})
    for item in (parsed["deps"] or "").split(","):
        item = item.strip()
        if not item:
            continue
        dtype, sep, did = item.partition(":")
        if not sep or not dtype.strip() or not did.strip():
            raise AdmissionError(
                f"malformed --deps entry for lint gate: {item!r}")
        deps.append({"depends_on_id": did.strip(),
                     "type": dtype.strip()})
    return {
        "id": "<new>",
        "title": parsed["title"],
        "status": parsed["status"],
        "priority": parsed["priority"],
        "issue_type": parsed["issue_type"] or "task",
        "labels": labels,
        "description": read_prospective_description(parsed, project),
        "acceptance_criteria": parsed["acceptance"] or "",
        "created_at": created.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "dependencies": deps,
    }


def lint_prospective(
    parsed: dict, issues: list[dict], project: str,
    now: dt.datetime | None = None,
) -> list[str]:
    """Failing LINTGATE1 check names for this create (empty = admit).

    `now` defaults to the wall clock; tests pin it across the cutover.
    REPLAYABLE1: every non-[v] acceptance box of a create is new, so one
    `omp-kit verify` cannot replay fails r-verify-replayable naming it. When
    box-lint.ts cannot run, the check is reported unverified on stderr and the
    other checks still decide.
    """
    import sys as _sys
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in _sys.path:
        _sys.path.insert(0, here)
    from bead_lint import (BoxGrammarUnavailable, lint_bead_failures, live_dependents,
                           replayable_findings)
    bead = prospective_bead(parsed, project, now)
    byid = {row["id"] for row in issues} | {"<new>"}
    # CUTGRAPH1 m-goal-path: the rows judge goals; blocks edges are read live.
    real = os.environ.get("BR_SHIM_REAL", "")
    dependents = (live_dependents(real, os.environ.get("BR_SHIM_DB", ""), project)
                  if real else None)
    failures = lint_bead_failures(bead, byid, graph=issues, dependents=dependents)
    try:
        replay_failures, notices = replayable_findings(bead, None)
    except BoxGrammarUnavailable as exc:
        replay_failures, notices = [], [f"REPLAYABLE_UNVERIFIED {exc}"]
    for notice in notices:
        print(f"bead-lint: {notice}", file=_sys.stderr)
    return sorted(failures + replay_failures)


def normalize_tokens(value: str) -> set[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    pieces: list[str] = []
    current: list[str] = []
    for character in normalized:
        if character.isalnum():
            current.append(character)
        elif current:
            pieces.append("".join(current))
            current = []
    if current:
        pieces.append("".join(current))

    result = set()
    for token in pieces:
        if token.endswith("ies") and len(token) > 5:
            token = token[:-3] + "y"
        elif token.endswith("es") and len(token) > 4:
            token = token[:-2]
        elif token.endswith("s") and len(token) > 4:
            token = token[:-1]
        if token not in STOPWORDS and len(token) > 1:
            result.add(token)
    return result


def duplicate_matches(title: str, issues: list[dict]) -> list[tuple[float, dict]]:
    wanted = normalize_tokens(title)
    if not wanted:
        return []
    matches = []
    for row in issues:
        if row["status"] != "open":
            continue
        existing = normalize_tokens(row["title"])
        shared = wanted & existing
        union = wanted | existing
        score = len(shared) / len(union) if union else 0.0
        if len(shared) >= MIN_SHARED_TOKENS and score >= SIMILARITY_THRESHOLD:
            matches.append((score, row))
    return sorted(matches, key=lambda item: (-item[0], item[1]["id"]))


def tracker_rows(real: str, project: str, database: str, lock_fd: int | None = None) -> list[dict]:
    command = [real, "list", "--status", "all", "--deferred", "--limit", "0", "--json",
               "--db", database, "--no-auto-import", "--no-auto-flush"]
    try:
        result = subprocess.run(command, cwd=project, capture_output=True, text=True,  # pysafe: leaf native br list; timeout bounds the wait, DEVNULL stdin
                                timeout=60, stdin=subprocess.DEVNULL, pass_fds=(() if lock_fd is None else (lock_fd,)))
    except (OSError, subprocess.SubprocessError) as error:
        raise AdmissionError(f"native br list failed: {error}") from error
    if result.returncode:
        raise AdmissionError(f"native br list rc={result.returncode}: {result.stderr.strip()[:400]}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AdmissionError("native br list returned malformed JSON") from error
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = payload.get("issues")
        if (payload.get("has_more") is True or payload.get("offset", 0) != 0
                or not isinstance(rows, list)
                or ("total" in payload and payload["total"] != len(rows))):
            raise AdmissionError("native br list returned incomplete or paginated inventory")
    else:
        raise AdmissionError("native br list returned an unsupported JSON envelope")

    seen = set()
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                or not isinstance(row.get("title"), str) or not row["title"]
                or not isinstance(row.get("status"), str)):
            raise AdmissionError("native br list contains a malformed issue row")
        if row["id"] in seen:
            raise AdmissionError("native br list contains duplicate issue IDs")
        seen.add(row["id"])
        parse_timestamp(row.get("created_at"))
        if row.get("created_by") is not None and not isinstance(row["created_by"], str):
            raise AdmissionError(f"{row['id']}: malformed creator")
        row["priority"] = parse_priority(row.get("priority"))
    return rows


def project_policy(project: str) -> tuple[int, tuple[str, str] | None]:
    config_value = os.environ.get("OMP_KIT_FLEET_WATCH_CONFIG")
    path = Path(config_value) if config_value else Path.home() / ".config" / "omp-kit" / "fleet-watch.json"
    if not path.exists():
        return DEFAULT_P0_CAP, None
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise AdmissionError(f"cannot read fleet policy {path}: {error}") from error
    if not isinstance(config, dict):
        raise AdmissionError("fleet policy is not a JSON object")
    sessions = config.get("sessions", [])
    herdr = config.get("herdr", [])
    if not isinstance(sessions, list) or not isinstance(herdr, list):
        raise AdmissionError("fleet policy has malformed sessions/herdr arrays")
    project_real = os.path.realpath(project)
    rows = [row for row in sessions + herdr if isinstance(row, dict)
            and isinstance(row.get("repo"), str) and os.path.realpath(row["repo"]) == project_real]
    if not rows:
        return DEFAULT_P0_CAP, None

    caps = set()
    coordinators = set()
    for row in rows:
        cap = row.get("p0Cap")
        if cap is None:
            cap = DEFAULT_P0_CAP
        if type(cap) is not int or cap < 0:
            raise AdmissionError("fleet policy p0Cap must be a non-negative integer")
        caps.add(cap)
        session, pane = row.get("coordinatorSession"), row.get("coordinatorPane")
        if session is not None or pane is not None:
            if not isinstance(session, str) or not session or not isinstance(pane, str) or not pane:
                raise AdmissionError("fleet policy coordinatorSession/coordinatorPane is incomplete")
            coordinators.add((session, pane))
    if len(caps) != 1 or len(coordinators) > 1:
        raise AdmissionError("fleet policy has conflicting P0 caps or project directors")
    return next(iter(caps)), next(iter(coordinators)) if coordinators else None


def acquire_tracker_lock(database: str) -> kitlib_lock.PrivateLock:
    # A separate persistent lock inode (kitlib KL08): flocking the DB deadlocks native br, and unlinking a lock
    # would split waiters. The lock file is $XDG_STATE_HOME/omp-kit/create-admission/<sha256(realpath(db))>.lock.
    try:
        return kitlib_lock.private_lock({"namespace": "create-admission", "path": database},
                                        deadline_s=LOCK_TIMEOUT_SECONDS)
    except kitlib_lock.PrivateLockError as error:
        if error.code == "INVALID_STATE_DIR":
            raise AdmissionError("XDG_STATE_HOME must be absolute for create serialization") from error
        if error.code == "DEADLINE":
            raise AdmissionError("another guarded create holds the tracker admission lock") from error
        if error.code == "NOT_DIRECTORY" or error.evidence.get("which") == "directory":
            raise AdmissionError(f"unsafe create lock directory: {error.evidence['path']}") from error
        if error.evidence.get("which") == "lock-file" or error.code in ("NOT_REGULAR", "LINKED", "INODE_REPLACED"):
            raise AdmissionError(f"unsafe create admission lock file: {error.code}") from error
        if error.evidence.get("step") == "flock":
            raise AdmissionError(f"cannot acquire tracker admission lock: {error}") from error
        raise AdmissionError(f"cannot create private tracker admission lock: {error}") from error



def recent_creations(issues: list[dict], actor: str, now: dt.datetime) -> list[dict]:
    start = now - dt.timedelta(hours=1)
    return [row for row in issues if isinstance(row.get("created_by"), str)
            and row["created_by"].casefold() == actor.casefold()
            and start <= parse_timestamp(row["created_at"]) < now]


def send_sweep_page(policy: tuple[int, tuple[str, str] | None], issues: list[dict],
                    actor: str, now: dt.datetime) -> None:
    entries = sorted(recent_creations(issues, actor, now),
                     key=lambda row: (parse_timestamp(row["created_at"]), row["id"]))
    if len(entries) <= SWEEP_THRESHOLD:
        print(f"br-shim: BR_CREATE_SWEEP_PAGE_UNKNOWN post-create inventory has only {len(entries)} "
              f"same-agent rows; expected at least {SWEEP_THRESHOLD + 1}", file=sys.stderr)
        return
    lines = [f"Creation sweep: {len(entries)} beads by {actor} in the preceding UTC hour.",
             "Review each as real work, split to fold back, or duplicate:"]
    lines.extend(f"- {row['id']}: {row['title']}" for row in entries)
    message = "\n".join(lines)
    coordinator = policy[1]
    if coordinator is None:
        print(f"br-shim: BR_CREATE_SWEEP_PAGE_UNKNOWN no configured project director\n{message}",
              file=sys.stderr)
        return
    session, pane = coordinator
    command = ["omp-kit", "send", session, pane, message, "--no-bead-reason",
               "creation-sweep-review", "--until-delivered", "15", "--json"]
    try:
        result = subprocess.run(command, cwd=os.environ["BR_SHIM_PROJECT"], capture_output=True,  # pysafe: leaf omp-kit send with --until-delivered 15; timeout bounds the wait, DEVNULL stdin
                                text=True, timeout=30, stdin=subprocess.DEVNULL)
        receipt = json.loads(result.stdout) if result.stdout else {}
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"br-shim: BR_CREATE_SWEEP_PAGE_UNVERIFIED {error}; review list follows:\n{message}",
              file=sys.stderr)
        return
    if result.returncode or receipt.get("status") != "OK" or receipt.get("overall") != "OK":
        print(f"br-shim: BR_CREATE_SWEEP_PAGE_UNVERIFIED rc={result.returncode} "
              f"receipt={result.stdout.strip()[:300]} stderr={result.stderr.strip()[:300]}\n{message}",
              file=sys.stderr)
