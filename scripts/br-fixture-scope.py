#!/usr/bin/env python3
"""Read-only SHIMHERMETIC1 fixture scope; never an identity or tracker grant.

The shell uses this only to distinguish an owned native fixture from a fleet
tracker. Unknown native destination selectors decline the exception. Production
policy remains the shell's responsibility. Owner fields mirror scratch.ts;
physical admission mirrors runtime.ts callerScratchRoot.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import stat
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

BASE = {"pid", "process_start", "label", "repo", "created_at", "argv0"}
LEGACY = {"pid", "label", "repo", "created"}
SEAT = {"agent", "session"}
BIN = {"bin", "purpose", "bead", "expires"}
OPTIONAL = SEAT | BIN | {"budget", "capability_sha256", "creator_session"}
ALLOWED = BASE | LEGACY | OPTIONAL
NAME = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
# ECMAScript trim, as used before JSON.parse in scratch.ts (not Python strip).
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
VALUE_FLAGS = {
    "--actor", "--author", "--prefix", "--title", "--description", "--body", "-d",
    "--design", "--acceptance", "--acceptance-criteria", "--prerequisites", "--notes",
    "--transition-comment", "--message", "--content", "--comment", "--reason", "-m", "-r",
    "--assignee", "--owner", "--priority", "-p", "--type", "-t", "--status", "-s",
    "--labels", "--add-label", "--remove-label", "--set-labels", "--parent", "--due",
    "--defer", "--estimate", "--external-ref", "--source-repo", "--source-repo-path",
    "--agent-context", "--session", "--agent-name", "--harness", "--model", "--format",
    "--limit", "--offset", "--sort", "--since", "--until", "--lock-timeout", "--file", "-f",
    "--check-acceptance", "--uncheck-acceptance", "--add-acceptance", "--append-notes",
    "--description-file", "--if-unchanged",
    "-l", "--direction",
}
DESTINATION_FLAGS = {
    "--output", "--output-file", "-o", "--jsonl", "--jsonl-path", "--jsonl-export",
    "--path", "--beads-dir", "--config", "--config-file", "--export-to", "--from", "--to",
}
COMMANDS = {
    "init", "create", "list", "show", "where", "info", "count", "ready", "blocked",
    "search", "stats", "status", "dep", "comments", "update", "close", "reopen",
    "delete", "label", "sync",
}
BOOLEAN_FLAGS = {
    "--json", "--robot", "--quiet", "-q", "--verbose", "-v", "--no-color", "--all",
    "--claim", "--force", "--hard", "--cascade", "--yes", "--import-only", "--flush-only",
    "--no-auto-import", "--no-auto-flush", "--offline", "--dry-run", "--no-daemon",
    "--deferred",
}


def date_ms(value: str) -> int:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = parsedate_to_datetime(value)
    # Date-only ISO is UTC; timezone-less date-times use the caller's local zone,
    # like Date.parse. Keep policy arithmetic in exact integer milliseconds.
    if parsed.tzinfo is None and len(value) == 10:
        parsed = parsed.replace(tzinfo=timezone.utc)
    delta = parsed.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000


def bin_fields_valid(fields: dict[str, str]) -> bool:
    present = BIN & fields.keys()
    if not present:
        return True
    if present == {"bead"}:
        return re.fullmatch(NAME, fields["bead"]) is not None
    if fields.get("bin") not in {"throwaway", "evidence", "promote", "hold"}:
        return False
    for key, pattern in (("purpose", r"[A-Za-z0-9][A-Za-z0-9._-]{0,39}"), ("bead", NAME)):
        if key in fields and re.fullmatch(pattern, fields[key]) is None:
            return False
    if "expires" not in fields:
        return fields["bin"] != "hold"
    if fields["bin"] != "hold" or "bead" not in fields:
        return False
    if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,3})?)?Z)?", fields["expires"]) is None:
        return False
    try:
        lifetime = date_ms(fields["expires"]) - date_ms(fields.get("created_at", fields.get("created", "")))
        return 0 < lifetime <= 14 * 86_400_000
    except (ValueError, TypeError, OverflowError):
        return False


def json_field_string(value: str | float) -> str:
    """Coerce JSON Number once at the JS boundary; validation then uses strings."""
    if isinstance(value, str):
        return value
    value = float(value)
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return str(value)


def owner_fields(text: str) -> dict[str, str] | None:
    trimmed = text.strip(JS_WHITESPACE)
    if trimmed.startswith("{"):
        def bad_constant(value: str) -> None:
            raise ValueError(value)
        raw = json.loads(trimmed, parse_constant=bad_constant, parse_int=float, parse_float=float)
        if not isinstance(raw, dict) or any(type(value) not in {str, int, float} for value in raw.values()):
            return None
        fields = {key: json_field_string(value) for key, value in raw.items()}
    else:
        fields: dict[str, str] = {}
        lines = [line for line in text.split("\n") if line != ""]
        tokens = re.split(r"[ \t]+", lines[0].strip(JS_WHITESPACE)) if len(lines) == 1 else []
        for line in tokens if len(tokens) > 1 else lines:
            key, separator, value = line.partition("=")
            if not separator:
                key, separator, value = line.partition(": ")
            if not separator or key in fields or not value or any(char in value for char in "\t\r\n"):
                return None
            fields[key] = value
    keys = fields.keys()
    if keys - ALLOWED or (keys & SEAT not in (set(), SEAT)):
        return None
    if keys - OPTIONAL not in (BASE, LEGACY):
        return None
    if re.fullmatch(r"[1-9][0-9]{0,5}", fields["pid"]) is None:
        return None
    if SEAT <= keys and (re.fullmatch(NAME, fields["agent"]) is None
                        or re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z-]{7,63}", fields["session"]) is None):
        return None
    if "budget" in fields and re.fullmatch(r"[1-9][0-9]{0,14}", fields["budget"]) is None:
        return None
    if "capability_sha256" in fields and re.fullmatch(r"[0-9a-f]{64}", fields["capability_sha256"]) is None:
        return None
    # SCRATCHSIBLING1: the creating incarnation, only inside a seat.
    if "creator_session" in fields and (not SEAT <= keys
                                        or re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z-]{7,63}", fields["creator_session"]) is None):
        return None
    return fields if bin_fields_valid(fields) else None


def physical(path: Path) -> bool:
    return path.is_absolute() and str(path) == os.path.realpath(path)


def owned_scratch_root(root: Path, workspace: Path) -> bool:
    """Fail closed on the physical root, marker, uid and canonical repo binding."""
    try:
        caller = workspace.resolve(strict=True)
        scratch = caller / "var" / "agent-tmp"
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or not physical(root):
            return False
        if not physical(scratch) or root == scratch or not root.is_relative_to(scratch):
            return False
        marker = root / ".owner"
        descriptor = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            owner_info = os.fstat(stream.fileno())
            if not stat.S_ISREG(owner_info.st_mode) or owner_info.st_uid != info.st_uid or owner_info.st_size > 4096:
                return False
            data = stream.read(4097)
        if len(data) > 4096:
            return False
        fields = owner_fields(data.decode("utf-8"))
        return fields is not None and Path(fields["repo"]).is_absolute() and Path(fields["repo"]).resolve(strict=True) == caller
    except (OSError, ValueError, TypeError, UnicodeError):
        return False


def comments_only_config(path: Path) -> bool:
    if not path.exists() and not path.is_symlink():
        return True
    if not physical(path) or not path.is_file() or path.stat().st_size > 65536:
        return False
    return all(not line.strip() or line.lstrip().startswith("#")
               for line in path.read_text(encoding="utf-8").splitlines())


def implicit_database(command: str) -> str:
    """Only native defaults with no unresolved startup override are admitted."""
    home = Path(os.environ.get("HOME", ""))
    configs = [home / ".config/beads/config.yaml", home / ".config/bd/config.yaml", home / ".beads/config.yaml"]
    if not all(comments_only_config(path) for path in configs):
        return ""
    current = Path.cwd()
    for project in (current, *current.parents):
        directory = project / ".beads"
        if not directory.exists():
            continue
        if not physical(directory) or not directory.is_dir() or not comments_only_config(directory / "config.yaml"):
            return ""
        metadata = directory / "metadata.json"
        if metadata.exists() or metadata.is_symlink():
            if not physical(metadata) or not metadata.is_file() or metadata.stat().st_size > 65536:
                return ""
            parsed = json.loads(metadata.read_text(encoding="utf-8"))
            if not isinstance(parsed, dict) or parsed.get("database") != "beads.db" or parsed.get("jsonl_export") != "issues.jsonl":
                return ""
        return str(directory / "beads.db")
    return str(current / ".beads/beads.db") if command == "init" else ""


def selected_database(args: list[str]) -> tuple[Path, str] | None:
    database = ""
    command = ""
    skip = False
    positionals: list[str] = []
    for index, argument in enumerate(args):
        if skip:
            skip = False
            continue
        flag = argument.partition("=")[0]
        if argument == "--" or flag in DESTINATION_FLAGS:
            return None
        if flag == "--db":
            if database:
                return None
            if "=" in argument:
                database = argument.partition("=")[2]
            elif index + 1 < len(args):
                database = args[index + 1]
                skip = True
            if not database or database.startswith("-"):
                return None
        elif flag in VALUE_FLAGS:
            skip = "=" not in argument
        elif argument.startswith("-"):
            if argument not in BOOLEAN_FLAGS:
                return None
        elif not argument.startswith("-") and not command:
            command = argument
        elif not argument.startswith("-"):
            positionals.append(argument)
    if command not in COMMANDS or skip:
        return None
    if command == "init" and positionals:
        return None
    if command == "sync" and not ({"--import-only", "--flush-only"} & set(args)):
        return None
    if any(value for key, value in os.environ.items() if key.startswith("BD_")
           or (key.startswith("BEADS_") and key not in {"BEADS_DB", "BEADS_JSONL"})):
        return None
    database = database or os.environ.get("BEADS_DB", "") or implicit_database(command)
    if not database:
        return None
    path = Path(os.path.abspath(database))
    return (path, command) if os.path.realpath(database) == str(path) and physical(path) else None


def destinations_inside(database: Path, owned: Path) -> bool:
    directory = database.parent
    for name in ("redirect", ".redirect"):
        if (directory / name).exists() or (directory / name).is_symlink():
            return False
    # Native --db/BEADS_DB binds the database; its JSONL is the sibling
    # issues.jsonl unless BEADS_JSONL overrides it (config/mod.rs resolve_jsonl_path).
    # Check original spellings too: normalizing link/../ first would hide escape.
    targets = [str(database), str(directory / "issues.jsonl"), os.environ.get("BEADS_JSONL", "")]
    for target in targets:
        if target:
            path = Path(os.path.abspath(target))
            if os.path.realpath(target) != str(path) or not physical(path) or not path.is_relative_to(owned):
                return False
    for filename in ("metadata.json", "config.yaml", "config.yml"):
        path = directory / filename
        if path.exists() or path.is_symlink():
            if not physical(path) or not path.is_file():
                return False
    return True


def fixture_project(args: list[str]) -> Path | None:
    selected = selected_database(args)
    if selected is None:
        return None
    database, _ = selected
    project = database.parent.parent if database.parent.name == ".beads" else database.parent
    declared = os.environ.get("OMP_KIT_CASE_CWD") or os.environ.get("GITHUB_WORKSPACE")
    for candidate in (project, *project.parents):
        if candidate.name in {"", ".", ".."}:
            continue
        marker = candidate / ".owner"
        if not marker.exists() and not marker.is_symlink():
            continue
        workspaces = [Path(declared)] if declared else [parent.parent for parent in candidate.parents
                      if parent.name == "var" and candidate.is_relative_to(parent / "agent-tmp")]
        for workspace in workspaces:
            if owned_scratch_root(candidate, workspace) and destinations_inside(database, candidate):
                return project
        # An invalid nearest owner cannot be laundered through an outer owner.
        return None
    return None


def main(args: list[str]) -> int:
    try:
        if not args:
            return 1
        os.chdir(args[0])
        project = fixture_project(args[1:])
        if project is None or any(char in str(project) for char in "\r\n\x00"):
            return 1
        print(project)
        return 0
    except (OSError, ValueError, TypeError, UnicodeError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
