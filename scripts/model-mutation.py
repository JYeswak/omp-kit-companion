#!/usr/bin/env python3
"""CLAIMMODEL1 private shim callee: observe, journal intent, run unchanged br, journal outcome.

No admission authority lives here. br-shim owns its existing admission. The native
child inherits the caller's actual standard descriptors, not a bounded tee; only
metadata probes use capped capture. Missing evidence never prevents the native act.
The TS read model owns the same version-1 limits; the consumer harness exercises both.
"""
from __future__ import annotations

import argparse
import datetime as dt
import errno
import fcntl
import hashlib
import json
import os
import shutil
import signal
import stat
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_jsonl
import kitlib_lock
import kitlib_run
from kitlib_proc import safe_pid
import pysafe

PRODUCER = "omp-kit/model-ledger"
MAX_FILES = 32
MAX_READ = 16 * 1024 * 1024
MAX_EVENT = 16 * 1024
MAX_DAY = 1024 * 1024
RETENTION_DAYS = 28


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def unknown(reason):
    return {"status": "UNKNOWN", "reason": reason}


def warn(error):
    try:
        if sys.stderr is None:
            return
        print("br-shim: MODEL_EVIDENCE_UNKNOWN " + str(error)[:240], file=sys.stderr)
    except OSError:
        pass


def observe():
    root = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    binary = os.path.join(root, "bin", "omp-kit")
    if os.path.isfile(binary) and os.access(binary, os.X_OK):
        argv = [binary]
    elif (installed := shutil.which("omp-kit")) is not None:
        argv = [installed]
    elif os.path.isfile(os.path.join(root, "src", "cli.ts")) and (bun := shutil.which("bun")) is not None:
        argv = [bun, "run", "--no-env-file", "--config=/dev/null", os.path.join(root, "src", "cli.ts")]
    else:
        return unknown("MODEL_OBSERVER_UNAVAILABLE")
    # A journal is input, never execution or credential authority. This probe needs no secrets.
    env = {key: os.environ[key] for key in ("HOME", "PATH", "TMPDIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME",
           "PI_SESSION_FILE", "PI_SESSION_ID", "PI_TOOL_CALL_ID") if key in os.environ}
    try:
        result = kitlib_run.run(argv + ["doctor", "--scope", "model", "--json"],
                                deadline_s=15, max_output_bytes=64 * 1024, env=env)
        if result.timed_out or result.truncated or result.rc not in (0, 3):
            return unknown("MODEL_OBSERVER_UNAVAILABLE")
        evidence = json.loads(result.stdout.decode("utf-8"))["data"]["model"]
        if not isinstance(evidence, dict) or evidence.get("status") not in ("KNOWN", "UNKNOWN"):
            return unknown("MODEL_OBSERVER_INVALID")
        if evidence["status"] == "KNOWN" and (not isinstance(evidence.get("model"), str)
                or not evidence["model"] or not isinstance(evidence.get("provider"), str)
                or not isinstance(evidence.get("source"), dict)):
            return unknown("MODEL_OBSERVER_INVALID")
        if evidence["status"] == "UNKNOWN" and not isinstance(evidence.get("reason"), str):
            return unknown("MODEL_OBSERVER_INVALID")
        return evidence
    except (OSError, ValueError, KeyError, TypeError):
        return unknown("MODEL_OBSERVER_UNAVAILABLE")


def revalidate(evidence):
    if evidence.get("status") != "KNOWN":
        return evidence
    fd = None
    try:
        source = evidence["source"]
        head_bytes, entry_bytes, start = source["head_bytes"], source["entry_bytes"], source["entry_start"]
        if any(type(value) is not int or value < 0 for value in (head_bytes, entry_bytes, start)):
            return unknown("JOURNAL_PROOF_INVALID")
        if head_bytes > 64 * 1024 or entry_bytes > 8 * 1024 * 1024:
            return unknown("JOURNAL_PROOF_LIMIT")
        fd = os.open(source["journal"], os.O_RDONLY | os.O_NOFOLLOW)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or f"{before.st_dev}:{before.st_ino}" != source["identity"]:
            return unknown("SESSION_REPLACED")
        head = os.pread(fd, head_bytes, 0)
        entry = os.pread(fd, entry_bytes, start)
        after, linked = os.fstat(fd), os.stat(source["journal"], follow_symlinks=False)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            return unknown("JOURNAL_CHANGED_DURING_PROOF")
        if (linked.st_dev, linked.st_ino) != (before.st_dev, before.st_ino) or before.st_size < source["cursor_bytes"]:
            return unknown("SESSION_REPLACED")
        if len(head) != head_bytes or len(entry) != entry_bytes or hashlib.sha256(head).hexdigest() != source["head_sha256"] \
                or hashlib.sha256(entry).hexdigest() != source["entry_sha256"]:
            return unknown("JOURNAL_PROOF_CHANGED")
        return evidence
    except (OSError, KeyError, TypeError, ValueError):
        return unknown("JOURNAL_PROOF_UNREADABLE")
    finally:
        if fd is not None:
            os.close(fd)


def pages(directory):
    result = []
    with os.scandir(directory) as entries:
        for count, entry in enumerate(entries):
            if count > MAX_FILES + 1:
                raise ValueError("LEDGER_FILE_LIMIT")
            if entry.name.endswith(".lock") or entry.name == "current.jsonl":
                continue
            try:
                day = dt.date.fromisoformat(entry.name[:-6])
            except ValueError:
                raise ValueError("UNRECOGNIZED_LEDGER_PAGE")
            if entry.name != day.isoformat() + ".jsonl" or not entry.is_file(follow_symlinks=False):
                raise ValueError("UNSAFE_LEDGER_PAGE")
            result.append((day, entry.path))
    return sorted(result)


def owned_page(path, allow_empty=False):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > MAX_DAY:
        raise ValueError("UNSAFE_RETENTION_PAGE")
    if allow_empty and info.st_size == 0:
        return info
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        first = os.pread(fd, MAX_EVENT + 1, 0).split(b"\n", 1)[0]
        header = json.loads(first.decode("utf-8"))
        if not isinstance(header, dict) or header.get("producer") != PRODUCER or header.get("schema_version") != 1:
            raise ValueError("FOREIGN_RETENTION_PAGE")
        opened, linked = os.fstat(fd), os.lstat(path)
        if (linked.st_dev, linked.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError("RETENTION_PAGE_REPLACED")
        return linked
    finally:
        os.close(fd)


def append(record):
    binding = kitlib_lock.resolve_lock({"namespace": "model-evidence", "name": "events"})
    with kitlib_lock.private_lock({"namespace": "model-evidence", "name": "events"}, deadline_s=3):
        today = dt.datetime.fromisoformat(record["at"].replace("Z", "+00:00")).astimezone(dt.timezone.utc).date()
        oldest = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=RETENTION_DAYS)
        for day, path in pages(binding["dir"]):
            if day < oldest:
                owned_page(path, allow_empty=True)
                os.unlink(path)
        size = len(encoded(record)) + 1
        if size > MAX_EVENT:
            raise ValueError("LEDGER_EVENT_LIMIT")
        path = os.path.join(binding["dir"], today.isoformat() + ".jsonl")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        except FileExistsError:
            pass
        page = owned_page(path, allow_empty=True)
        # One stable append path keeps KL08's persistent JSONL lock bounded across all dates.
        # The dated hard link is the read/retention view; no retained event bytes are rewritten.
        current = os.path.join(binding["dir"], "current.jsonl")
        if os.path.lexists(current):
            active = owned_page(current, allow_empty=True)
            if (active.st_dev, active.st_ino) != (page.st_dev, page.st_ino):
                os.unlink(current)
                os.link(path, current)
        else:
            os.link(path, current)
        def build(current_state):
            if current_state["size"] + size > MAX_DAY:
                raise ValueError("LEDGER_DAY_LIMIT")
            return record
        kitlib_jsonl.append_jsonl(current, build, deadline_s=3, durable=True, state_dir=binding["state"])


def current_claims(tracker):
    intents, claims, budget = {}, {}, MAX_READ
    try:
        binding = kitlib_lock.resolve_lock({"namespace": "model-evidence", "name": "events"})
        for _, path in pages(binding["dir"]):
            if budget <= 0:
                return {}
            result = kitlib_jsonl.read_jsonl(path, max_bytes=budget)
            consumed = min(budget, (result.get("cursor") or {}).get("offset", 0) + result["pending_tail_bytes"])
            budget -= consumed
            if result["errors"] or result["more"] or result["pending_tail_bytes"] or result["missing"]:
                return {}
            for row in result["rows"]:
                if not isinstance(row, dict) or row.get("producer") != PRODUCER or row.get("tracker") != tracker:
                    continue
                if row.get("phase") == "intent":
                    intents[row.get("operation_id")] = row
                elif row.get("phase") == "outcome" and row.get("native_rc") == 0 and row.get("native_timed_out") is not True:
                    intent = intents.get(row.get("operation_id"))
                    if intent is None or hashlib.sha256(encoded(intent)).hexdigest() != row.get("intent_sha256"):
                        return {}
                    for bead in row.get("beads", []):
                        if row.get("kind") == "claim":
                            claims[bead] = row.get("claim_incarnations", {}).get(bead)
                        elif row.get("kind") == "release":
                            claims.pop(bead, None)
        return claims
    except (OSError, ValueError, TypeError, KeyError, kitlib_jsonl.JsonlError, kitlib_lock.PrivateLockError):
        return {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", required=True, choices=("claim", "close", "release"))
    parser.add_argument("--tracker", required=True)
    parser.add_argument("--actor", required=True)
    parser.add_argument("--beads", required=True)
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    if not argv:
        parser.error("missing native argv")
    beads = args.beads.splitlines()
    # Metadata probes may allocate a descriptor the caller deliberately closed.
    # Remember that state before any probe, so the native child still sees it closed.
    stdio_open = []
    for standard in range(3):
        try:
            os.fstat(standard)
            stdio_open.append(True)
        except OSError as error:
            if error.errno != errno.EBADF:
                raise
            stdio_open.append(False)
    tracker = os.path.realpath(args.tracker)
    evidence = observe()
    if args.actor == "UNKNOWN":
        evidence = unknown("ACTOR_BINDING_MISSING")
    if len(beads) > 100:
        beads = beads[:100]
        evidence = unknown("BATCH_TARGET_LIMIT")
    previous = current_claims(tracker)
    operation = str(uuid.uuid4())
    incarnations = {bead: previous.get(bead) for bead in beads}
    if args.kind == "claim":
        # Idempotent self-claims confirm their original author incarnation; reopen/reclaim starts another.
        try:
            before = kitlib_run.run([argv[0], "--db", tracker, "show", *beads, "--json", "--no-auto-import", "--no-auto-flush"],
                                     deadline_s=15, max_output_bytes=1024 * 1024)
            rows = json.loads(before.stdout.decode("utf-8")) if before.rc == 0 and not before.truncated and not before.timed_out else []
            if isinstance(rows, dict):
                rows = [rows]
            states = {row["id"]: row for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)}
            for bead in beads:
                state = states.get(bead)
                if state is not None and (state.get("status") != "in_progress" or state.get("assignee") != args.actor):
                    incarnations[bead] = operation
        except (OSError, ValueError, TypeError):
            pass
    intent = {"schema_version": 1, "producer": PRODUCER, "phase": "intent", "operation_id": operation,
              "at": timestamp(), "kind": args.kind, "actor": args.actor, "tracker": tracker, "beads": beads,
              "attribution": evidence, "native_rc": None, "claim_incarnations": incarnations}
    recorded = False
    try:
        if len(encoded(intent)) + 1 > MAX_EVENT:
            evidence = unknown("EVIDENCE_RECORD_LIMIT")
            intent["attribution"] = evidence
        append(intent)
        recorded = True
    except (OSError, ValueError, TypeError, kitlib_jsonl.JsonlError, kitlib_lock.PrivateLockError) as error:
        warn(error)
    native_env = dict(os.environ)
    native_env["BR_MODEL"] = evidence["model"] if evidence.get("status") == "KNOWN" else "UNKNOWN"
    descriptors, redirects = [], []
    try:
        for standard in range(3):
            if not stdio_open[standard]:
                redirects.append(f"{standard}<&-" if standard == 0 else f"{standard}>&-")
                continue
            try:
                fd = fcntl.fcntl(standard, fcntl.F_DUPFD_CLOEXEC, 3)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
                redirects.append(f"{standard}<&-" if standard == 0 else f"{standard}>&-")
                continue
            descriptors.append(fd)
            redirects.append(f"{standard}<&{fd}" if standard == 0 else f"{standard}>&{fd}")
        prologue = 'exec "$@" ' + " ".join(redirects)
        result = kitlib_run.run(["/bin/sh", "-c", prologue, "model-native", *argv], deadline_s=600,
                               max_output_bytes=0, inherit_fds=descriptors, env=native_env)
    finally:
        for fd in descriptors:
            os.close(fd)
    if recorded:
        corrected = revalidate(evidence)
        outcome = {**intent, "phase": "outcome", "at": timestamp(), "native_rc": result.rc,
                   "native_timed_out": result.timed_out, "attribution": corrected,
                   "intent_sha256": hashlib.sha256(encoded(intent)).hexdigest()}
        if corrected != evidence:
            outcome["correction_of"] = outcome["intent_sha256"]
        try:
            append(outcome)
        except (OSError, ValueError, TypeError, kitlib_jsonl.JsonlError, kitlib_lock.PrivateLockError) as error:
            warn(error)
    if result.rc is not None and result.rc < 0:
        signum = -result.rc
        signal.signal(signum, signal.SIG_DFL)
        os.kill(safe_pid(os.getpid()), signum)
    return result.rc if result.rc is not None else 124


if __name__ == "__main__":
    pysafe.run_main(main)
