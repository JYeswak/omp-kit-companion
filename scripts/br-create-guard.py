#!/usr/bin/env python3
"""Entry point for the br create admission guard."""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import sys

import kitlib_run  # sibling in scripts/ and in every release (KL02 process adoption)
from br_create_guard_core import (
    AdmissionError,
    SWEEP_THRESHOLD,
    acquire_tracker_lock,
    duplicate_matches,
    fail,
    parse_create_args,
    project_policy,
    recent_creations,
    send_sweep_page,
    tracker_rows,
)

def run_shim(args: list[str], shim: str, real: str, project: str) -> int:
    command = [shim, *args]
    environment = dict(os.environ, BR_REAL=real)
    try:
        result = kitlib_run.run(command, deadline_s=30, cwd=project, env=environment)
    except (OSError, ValueError) as error:
        print(f"br-shim: BR_CREATE_DISPLACEMENT_WRITE_FAILED {error}", file=sys.stderr)
        return 4
    if result.timed_out:
        print(f"br-shim: BR_CREATE_DISPLACEMENT_WRITE_FAILED {timeout_text(command, 30)}", file=sys.stderr)
        return 4
    rc = exit_code(result)
    if rc:
        write_captured(result)
        print(f"br-shim: BR_CREATE_DISPLACEMENT_WRITE_FAILED rc={rc}", file=sys.stderr)
    return rc


def timeout_text(command: list[str], seconds: int) -> str:
    # The wording subprocess.TimeoutExpired carried before KL02, so the guard's messages are unchanged.
    return f"Command '{command}' timed out after {seconds} seconds"


def exit_code(result: kitlib_run.RunResult) -> int:
    # None: the child was never reaped; report the generic failure an uncaught error used to give.
    return 1 if result.rc is None else result.rc


def write_captured(result: kitlib_run.RunResult) -> None:
    for stream, data in ((sys.stdout, result.stdout), (sys.stderr, result.stderr)):
        if data:
            stream.flush()
            stream.buffer.write(data)
            stream.buffer.flush()


def passthrough(command: list[str], project: str, inherit_fds: list[int]) -> int:
    """Native br with its output streamed live to the guard's own stdout/stderr, as the uncaptured
    subprocess.run did. A deadline exits 1 with the TimeoutExpired wording that used to escape here."""
    def forward(stream: str, chunk: bytes) -> None:
        target = sys.stdout if stream == "stdout" else sys.stderr
        target.buffer.write(chunk)
        target.buffer.flush()

    sys.stdout.flush()
    sys.stderr.flush()
    result = kitlib_run.run(command, deadline_s=120, cwd=project, inherit_fds=inherit_fds, on_output=forward)
    if result.timed_out:
        print(f"subprocess.TimeoutExpired: {timeout_text(command, 120)}", file=sys.stderr)
        return 1
    return exit_code(result)



def read_comment_description(parsed: dict, project: str) -> str:
    description = parsed["description"]
    if parsed["description_file"]:
        path = Path(parsed["description_file"])
        if not path.is_absolute():
            path = Path(project) / path
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise AdmissionError(f"cannot read comment description file: {error}") from error
        if len(content.encode("utf-8")) > 1_000_000:
            raise AdmissionError("comment description file exceeds the 1 MB limit")
        description = content
    return description or ""


def replace_priority(arguments: list[str], priority: int) -> list[str]:
    output: list[str] = []
    index = 0
    while index < len(arguments):
        token = arguments[index]
        option = token.partition("=")[0]
        if option in ("--priority", "-p"):
            if "=" not in token:
                index += 1
            index += 1
            continue
        if token.startswith("-p") and len(token) > 2 and token[2:].isdigit():
            index += 1
            continue
        output.append(token)
        index += 1
    output.extend(("--priority", str(priority)))
    return output


def displacement_comment(old_id: str, new_id: str, direction: str) -> str:
    if direction == "old":
        return f"Displaced by {new_id}: the new open P0 takes this P0's slot; priority changed to P1."
    return f"Displaces {old_id}: this open P0 takes the named P0 slot."


def execute_displacement(parsed: dict, issues: list[dict], real: str, shim: str,
                         project: str, database: str, actor: str, lock_fd: int) -> int:
    old_id = parsed["custom"]["--displaces"]
    old_row = next((row for row in issues if row["id"] == old_id), None)
    if old_row is None or old_row["status"] != "open" or old_row["priority"] != 0:
        return fail("--displaces must name an existing open P0 in this tracker")

    create_args = replace_priority(parsed["forwarded"], 1)
    create_args = [argument for argument in create_args if argument not in ("--json", "--silent")]
    create_args.append("--json")
    create_command = [real, *parsed["prefix"], "create", *create_args]
    try:
        created = kitlib_run.run(create_command, deadline_s=120, cwd=project, inherit_fds=[lock_fd])
    except (OSError, ValueError) as error:
        return fail(f"P0 displacement create failed before changing the named P0: {error}")
    if created.timed_out:
        return fail("P0 displacement create failed before changing the named P0: "
                    f"{timeout_text(create_command, 120)}")
    if exit_code(created):
        write_captured(created)
        return exit_code(created)
    try:
        record = json.loads(created.stdout)
    except json.JSONDecodeError:
        return fail("P0 displacement created a P1 bead but native br returned malformed JSON; no P0 was changed")
    new_id = record.get("id") if isinstance(record, dict) else None
    if not isinstance(new_id, str) or not new_id:
        return fail("P0 displacement created a P1 bead but native br returned no issue ID; no P0 was changed")

    demote_rc = run_shim(["update", old_id, "--priority", "1", "--db", database,
                          "--actor", actor], shim, real, project)
    if demote_rc:
        return fail(f"created {new_id} at P1; could not demote {old_id}; no new P0 was added")
    promote_rc = run_shim(["update", new_id, "--priority", "0", "--db", database,
                           "--actor", actor], shim, real, project)
    if promote_rc:
        rollback_rc = run_shim(["update", old_id, "--priority", "0", "--db", database,
                                "--actor", actor], shim, real, project)
        return fail(f"created {new_id} at P1; promotion failed; restored {old_id}={rollback_rc == 0}")

    old_comment_rc = run_shim(["comments", "add", "--message",
                               displacement_comment(old_id, new_id, "old"), old_id,
                               "--db", database, "--actor", actor], shim, real, project)
    new_comment_rc = run_shim(["comments", "add", "--message",
                               displacement_comment(old_id, new_id, "new"), new_id,
                               "--db", database, "--actor", actor], shim, real, project)
    if old_comment_rc or new_comment_rc:
        return fail(f"P0 priorities changed ({old_id}→P1, {new_id}→P0) but two-sided displacement comments failed: "
                    f"old_rc={old_comment_rc} new_rc={new_comment_rc}")

    if parsed["has_json"]:
        print(json.dumps({"id": new_id, "priority": 0, "status": "open", "displaces": old_id,
                          "displacement_recorded": True}, separators=(",", ":")))
    elif parsed["silent"]:
        print(new_id)
    elif not parsed["quiet"]:
        print(f"Created {new_id} as P0; displaced {old_id} to P1.")
    return 0


def main(argv: list[str]) -> int:
    real = os.environ.get("BR_SHIM_REAL", "")
    project = os.environ.get("BR_SHIM_PROJECT", "")
    database = os.environ.get("BR_SHIM_DB", "")
    actor = os.environ.get("BR_SHIM_AGENT", "")
    entry = os.environ.get("BR_SHIM_ENTRY", "")
    if not all((real, project, database, actor, entry)):
        return fail("BR_CREATE_ADMISSION_UNKNOWN shim context is incomplete")
    project = os.path.realpath(project)
    database = os.path.abspath(database)
    shim = os.path.abspath(entry)

    try:
        parsed = parse_create_args(argv)
        if parsed["dry_run"]:
            return passthrough([real, *parsed["prefix"], "create", *parsed["forwarded"]], project, [])
        lock = acquire_tracker_lock(database)
        lock_fd = lock.fd
        try:
            issues = tracker_rows(real, project, database, lock_fd)
            policy = project_policy(project)
            custom = parsed["custom"]

            if "--comment-target" in custom:
                target_id = custom["--comment-target"]
                target = next((row for row in issues if row["id"] == target_id), None)
                if target is None or target["status"] != "open":
                    return fail("--comment-target must name an existing open issue in this tracker")
                description = read_comment_description(parsed, project)
                message = f"Follow-up requested for: {parsed['title']}"
                if description:
                    message += f"\n\n{description}"
                comment_rc = run_shim(["comments", "add", "--message", message, target_id,
                                       "--db", database, "--actor", actor], shim, real, project)
                if comment_rc:
                    return comment_rc
                if not parsed["quiet"]:
                    print(f"Added follow-up comment to {target_id}; no new bead created.")
                return 0

            matches = duplicate_matches(parsed["title"], issues)
            not_duplicate = custom.get("--not-duplicate")
            matching_ids = {row["id"] for _, row in matches}
            if matches and not_duplicate is None:
                print("br-shim: BR_CREATE_POSSIBLE_DUPLICATE; review the open matches:", file=sys.stderr)
                for score, row in matches[:10]:
                    print(f"  {row['id']} ({score:.2f}): {row['title']}", file=sys.stderr)
                print("Use --not-duplicate <id> to confirm distinct work, or --comment-target <id> to add context.",
                      file=sys.stderr)
                return 4
            if not_duplicate is not None and not_duplicate not in matching_ids:
                return fail(f"--not-duplicate {not_duplicate} does not name a current similar open bead")

            open_p0 = [row for row in issues if row["status"] == "open" and row["priority"] == 0]
            cap = policy[0]
            displaces = custom.get("--displaces")
            needs_displacement = parsed["status"] == "open" and parsed["priority"] == 0 and len(open_p0) >= cap
            if needs_displacement and displaces is None:
                return fail(f"P0 cap={cap}: {len(open_p0)} open P0 beads already consume the budget; "
                            "name one with --displaces <id>")
            if displaces is not None and not needs_displacement:
                return fail("--displaces is only valid when a new open P0 would exceed the configured cap")
            if displaces is not None:
                return execute_displacement(parsed, issues, real, shim, project, database, actor, lock_fd)

            now = dt.datetime.now(dt.timezone.utc)
            sweep_crossing = len(recent_creations(issues, actor, now)) == SWEEP_THRESHOLD
            command = [real, *parsed["prefix"], "create", *parsed["forwarded"]]
            create_rc = passthrough(command, project, [lock_fd])
            if create_rc:
                return create_rc
            if sweep_crossing:
                try:
                    after = tracker_rows(real, project, database, lock_fd)
                    send_sweep_page(policy, after, actor, dt.datetime.now(dt.timezone.utc))
                except AdmissionError as error:
                    print(f"br-shim: BR_CREATE_SWEEP_PAGE_UNVERIFIED {error}; planned title: {parsed['title']}",
                          file=sys.stderr)
            return 0
        finally:
            lock.release()
    except AdmissionError as error:
        return fail(f"BR_CREATE_ADMISSION_UNKNOWN {error}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
