#!/usr/bin/env python3
"""Execute opt-in informing hook members and qualify their promotion from real full runs."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitlib_io import atomic_replace_bytes
from kitlib_jsonl import JsonlError, append_jsonl, read_jsonl
from kitlib_lock import PrivateLockError
from kitlib_run import run
import pysafe

MARKER = b"# omp-kit-rollout: informing "
WRAPPER = """#!/bin/sh
# INFORMING1 member wrapper; the hidden payload retains its own interpreter.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
member="$here/$(basename -- "$0")"
OMP_KIT_HOOK_CWD=$PWD
export OMP_KIT_HOOK_CWD
cd -- "$here"
exec python3 ./gate-rollout.py run "$member" "$@"
"""


def checked_git(repo: Path, *args: str) -> str:
    result = run(["git", "-C", str(repo), *args], deadline_s=15, max_output_bytes=65536)
    if result.rc != 0 or result.timed_out or result.truncated:
        raise ValueError("Git rollout identity unavailable")
    return result.stdout.decode("utf-8", errors="strict").strip()


def state_root(repo: Path) -> Path:
    common = Path(checked_git(repo, "rev-parse", "--git-common-dir"))
    if not common.is_absolute():
        common = repo / common
    root = common.resolve() / "omp-kit" / "gate-rollout"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("unsafe rollout state directory")
    return root


def append(root: Path, name: str, row: dict) -> None:
    append_jsonl(str(root / name), lambda _state: row, deadline_s=5, durable=True, state_dir=str(root))


def regular_bytes(path: Path, cap: int = 1 << 20) -> bytes:
    with path.open("rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > cap or path.is_symlink():
            raise ValueError("rollout input is not a bounded regular file")
        return handle.read(cap + 1)


def save_json(path: Path, row: dict) -> None:
    atomic_replace_bytes(str(path), (json.dumps(row, sort_keys=True) + "\n").encode(), mode=0o600, durability="full")


def declaration(data: bytes) -> int | None:
    declarations = [line for line in data.splitlines()[:16] if line.startswith(MARKER)]
    if not declarations:
        return None
    if len(declarations) != 1:
        raise ValueError("duplicate informing declaration")
    value = declarations[0][len(MARKER):]
    if not value.isdigit() or not 1 <= int(value) <= 1000:
        raise ValueError("informing declaration needs a green-run count from 1 to 1000")
    return int(value)


def install(hooks: Path) -> None:
    for kind in ("pre-commit", "commit-msg", "pre-push", "reference-transaction"):
        directory = hooks / "hooks.d" / kind
        for member in sorted(directory.glob("[0-9][0-9]-*")):
            if not os.access(member, os.X_OK):
                continue
            data = regular_bytes(member)
            metadata = directory / ("." + member.name + ".rollout.json")
            if data == WRAPPER.encode():
                if not metadata.is_file():
                    raise ValueError("informing wrapper has no declaration")
                continue
            count = declaration(data)
            if count is None:
                continue
            payload = directory / ("." + member.name + ".payload")
            if metadata.exists() or payload.exists():
                previous = json.loads(regular_bytes(metadata))
                if (previous.get("version") != 1
                        or previous.get("sha256") != hashlib.sha256(regular_bytes(payload)).hexdigest()):
                    raise ValueError("informing member conflicts with unverified retained payload")
            # The payload stays byte-identical. Both old and foreign chain dispatchers call the wrapper.
            atomic_replace_bytes(str(payload), data, mode=0o700, durability="full")
            save_json(metadata, {"version": 1, "sha256": hashlib.sha256(data).hexdigest(),
                                 "required_green": count, "promoted": None})
            atomic_replace_bytes(str(member), WRAPPER.encode(), mode=0o755, durability="full")


def green_streak(root: Path, commit: str, member: str, digest: str) -> tuple[int, str]:
    history = read_jsonl(str(root / "full-runs.jsonl"), max_bytes=8 << 20)
    if history["errors"] or history["more"] or history["pending_tail_bytes"]:
        return 0, "full-run history incomplete"
    runs = {}
    ordered = []
    records = set()
    for row in history["rows"]:
        if not isinstance(row, dict) or row.get("version") != 1:
            return 0, "full-run history malformed"
        identity = row.get("run")
        if not isinstance(identity, str):
            return 0, "full-run identity missing"
        if row.get("event") == "begin":
            if identity in runs:
                return 0, "duplicate full-run identity"
            runs[identity] = row
            ordered.append(identity)
        elif row.get("event") == "finish":
            start = runs.get(identity)
            if start is None or "passed" in start or start.get("commit") != row.get("commit"):
                return 0, "unpaired full-run completion"
            record = row.get("record_sha256")
            if not isinstance(record, str) or len(record) != 64 or record in records:
                return 0, "missing or reused full-run evidence"
            records.add(record)
            start["passed"] = row.get("passed") is True
        else:
            return 0, "unknown full-run event"
    count = 0
    for identity in reversed(ordered):
        row = runs[identity]
        members = row.get("members")
        if (row.get("commit") != commit or row.get("passed") is not True
                or not isinstance(members, dict) or members.get(member) != digest):
            break
        count += 1
    return count, "validated full-run history"


def execute(member: Path, argv: list[str]) -> int:
    directory = member.parent
    metadata = directory / ("." + member.name + ".rollout.json")
    config = json.loads(regular_bytes(metadata))
    payload = directory / ("." + member.name + ".payload")
    data = regular_bytes(payload)
    digest = hashlib.sha256(data).hexdigest()
    count = config.get("required_green")
    if (config.get("version") != 1 or config.get("sha256") != digest or type(count) is not int
            or count < 1 or count > 1000 or declaration(data) != count):
        raise ValueError("informing payload or declaration changed")
    cwd = Path(os.environ["OMP_KIT_HOOK_CWD"]).resolve()
    commit = None
    root = None
    streak, reason = 0, "full-run history unavailable"
    promoted = config.get("promoted")
    try:
        commit = checked_git(cwd, "rev-parse", "HEAD")
        root = state_root(cwd)
        streak, reason = green_streak(root, commit, directory.name + "/" + member.name, digest)
        if promoted is None and streak >= count:
            promotion = {"commit": commit, "green_runs": streak, "sha256": digest}
            save_json(metadata, {**config, "promoted": promotion})
            promoted = promotion
    except (OSError, ValueError, JsonlError, PrivateLockError) as error:
        reason = "promotion unavailable: " + str(error)
    if promoted is not None and (not isinstance(promoted, dict) or promoted.get("sha256") != digest
                                 or type(promoted.get("green_runs")) is not int or promoted["green_runs"] < count):
        raise ValueError("invalid informing promotion")
    input_bytes = None
    if directory.name in ("pre-push", "reference-transaction"):
        outcome, input_bytes, truncated = pysafe.read_stdin(timeout=10, cap_bytes=16 << 20)
        if outcome != pysafe.OK or truncated:
            raise ValueError("hook input incomplete")
    command = [str(payload), *argv] if data.startswith(b"#!") else ["sh", str(payload), *argv]
    result = run(command, cwd=cwd, deadline_s=900 if directory.name == "pre-push" else 60,
                 stdin=input_bytes, max_output_bytes=4 << 20)
    rc = result.rc if result.rc is not None and 0 <= result.rc <= 125 else 1
    if result.timed_out or result.killed or result.truncated:
        rc = 1
    finding = any(line.startswith(b"FINDING\t") for line in result.stdout.splitlines())
    mode = "blocking" if promoted is not None else "informing"
    row = {"version": 1, "commit": commit, "hook": directory.name, "member": member.name,
           "sha256": digest, "mode": mode, "rc": rc, "finding": finding,
           "green_runs": streak, "required_green": count, "reason": reason}
    try:
        if root is not None:
            append(root, "member-verdicts.jsonl", row)
        else:
            row["recording"] = "UNAVAILABLE"
    except (OSError, JsonlError, PrivateLockError) as error:
        row["recording"] = "UNAVAILABLE: " + str(error)
    print("INFORMING1 " + json.dumps(row, sort_keys=True), file=sys.stderr)
    sys.stderr.buffer.write(result.stderr)
    if mode == "informing":
        # FINDING is the existing chain's refusal protocol; retain it as diagnostic text, not a refusal.
        for line in result.stdout.splitlines(keepends=True):
            sys.stdout.buffer.write(b"INFORMING " + member.name.encode() + b": " + line)
        return 0
    sys.stdout.buffer.write(result.stdout)
    return rc or int(finding)


def full_run(args: argparse.Namespace) -> None:
    repo = Path(args.repo).resolve()
    commit = checked_git(repo, "rev-parse", args.commit + "^{commit}")
    if args.action == "begin":
        identity = secrets.token_hex(16)
        hooks = Path(checked_git(repo, "rev-parse", "--git-path", "hooks"))
        if not hooks.is_absolute():
            hooks = repo / hooks
        members = {}
        for metadata in hooks.glob("hooks.d/*/.*.rollout.json"):
            config = json.loads(regular_bytes(metadata))
            name = metadata.name[1:-len(".rollout.json")]
            if regular_bytes(metadata.with_name(name)) != WRAPPER.encode():
                continue
            payload = metadata.with_name("." + name + ".payload")
            digest = hashlib.sha256(regular_bytes(payload)).hexdigest()
            if config.get("sha256") != digest:
                raise ValueError("installed informing payload changed before full run")
            members[metadata.parent.name + "/" + name] = digest
        if not members:
            print("")
            return
        root = state_root(repo)
        append(root, "full-runs.jsonl", {"version": 1, "event": "begin", "run": identity,
                                        "commit": commit, "members": members})
        print(identity)
        return
    root = state_root(repo)
    spec = importlib.util.spec_from_file_location("rollout_verdict_store", Path(__file__).with_name("full-suite-verdict-store.py"))
    if spec is None or spec.loader is None:
        raise ValueError("full-run validator unavailable")
    store = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(store)
    valid, reason = store.validate_record(Path(args.record), judge_root=Path(__file__).resolve().parent.parent,
                                          repo=repo, commit=commit, role="main", exact_filename=True)
    if valid is None or valid["tree"] != checked_git(repo, "rev-parse", commit + "^{tree}"):
        raise ValueError("full-run promotion evidence invalid: " + reason)
    append(root, "full-runs.jsonl", {"version": 1, "event": "finish", "run": args.run,
                                    "commit": commit, "passed": valid["verdict"] == "PASS",
                                    "record_sha256": hashlib.sha256(regular_bytes(Path(args.record))).hexdigest()})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    installing = actions.add_parser("install")
    installing.add_argument("--hooks", required=True)
    execution = actions.add_parser("run")
    execution.add_argument("member")
    execution.add_argument("argv", nargs=argparse.REMAINDER)
    for name in ("begin", "finish"):
        command = actions.add_parser(name)
        command.add_argument("--repo", required=True)
        command.add_argument("--commit", required=True)
        if name == "finish":
            command.add_argument("--run", required=True)
            command.add_argument("--record", required=True)
    args = parser.parse_args()
    try:
        if args.action == "install":
            install(Path(args.hooks).resolve())
        elif args.action == "run":
            return execute(Path(args.member).resolve(), args.argv)
        else:
            full_run(args)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print("INFORMING1 REFUSED: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    pysafe.run_main(main)
