#!/usr/bin/env python3
"""SUITEBUDGET1: measured suite outcomes, complete-record validation and Bun timing maps.

Process lifetime is owned by kitlib_run, not a second timeout implementation.
The conservative dependency closure is the complete candidate source tree; unknown
external inputs never gain a reusable closure from a missing field.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
import json
import math
import os
import platform
from pathlib import Path
import resource
import shlex
import signal
import sys
import threading
import time
from typing import Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kitlib_run import run
from kitlib_tmp import owned_tmp
import pysafe
JUDGE_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
JUDGING_FILES = (
    "scripts/full-suite-verdict.sh", "scripts/full-suite-verdict-store.py",
    "scripts/fresh-gate.sh", "scripts/suite-metrics.py",
    "scripts/suite-hermetic-env.sh", "scripts/kitlib_run.py", "scripts/kitlib_tmp.py",
    "scripts/fixed-env.sh",
    "scripts/pysafe.py", "scripts/kitlib-tmp.sh", "scripts/kitlib-proc.sh", "scripts/kitlib-shimpath.sh",
    # SUITESERIAL1 (ompkit-fp72.120.16.264): the suite lease the runner takes and the kitlib lock and process
    # identity it uses, so land's archived judge carries them and a lease change never reuses a verdict.
    "scripts/suite-lease.sh", "scripts/kitlib_lock.py", "scripts/kitlib_proc.py",
    "scripts/test-budget.ts",
    "scripts/kitlib-ratchet-signal-baseline.json",
    ".github/test-budget.json",
)


def judge_identity(root: Path | str, scope: str) -> str:
    """Bind judging paths and bytes, independent of the checkout's location."""
    if scope not in ("full", "focused"):
        raise ValueError("identity scope must be full or focused")
    root = Path(root)
    paths = [name for name in JUDGING_FILES
             if scope == "full" or name != "scripts/full-suite-verdict.sh"]
    if (root / "scripts/gate-ci-only.tsv").exists():
        paths.append("scripts/gate-ci-only.tsv")
    digest = hashlib.sha256(b"SUITEBUDGET1-judge-v1\0" + scope.encode() + b"\0")
    for name in sorted(paths):
        data = (root / name).read_bytes()
        digest.update(name.encode() + b"\0" + str(len(data)).encode() + b"\0")
        digest.update(data)
    return digest.hexdigest()


# Gate transport/custody controls are not suite inputs. In particular a scratch
# relocation, store location or different reserving agent must not invalidate PASS.
# None of these are forwarded by suite_environment().
GATE_INPUTS = (
    "TMPDIR", "AGENT_NAME", "KITLIB_TMP_ROOT",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "FULL_SUITE_VERDICT_CACHE_DIR", "FULL_SUITE_JOBS", "FULL_SUITE_SHELL_JOBS",
    "FULL_SUITE_LEASE_DIR", "FULL_SUITE_LEASE_WAIT_SECS", "FULL_SUITE_LEASE_QUEUE_MAX",
    "FRESH_GATE_REPO", "FRESH_GATE_TEST_WORKERS", "FRESH_GATE_LEDGER",
    "FRESH_GATE_PASSED_IN", "FRESH_GATE_PASSED_OUT", "FRESH_GATE_SKIP_REGEX",
    "RELEASE_VERDICT_ROOT", "RELEASE_VERDICT_COPY",
    "OMP_KIT_REPO", "OMP_KIT_DEVID_SHA1", "OMP_KIT_NOTARY_PROFILE",
    "OMP_KIT_SIGNING_KEYCHAIN", "OMP_KIT_SIGNING_KEYCHAIN_PASSWORD", "OMP_KIT_INSTALL_PREFIX",
    "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "STOREGATE_COMMIT_MODE",
)
SUITE_INPUTS = (
    "FULL_SUITE_RUNTIME_ID", "FULL_SUITE_TIMEOUT_SECS", "OMP_KIT_OMP_SRC_CACHE",
    "OMP_KIT_SUITE_HERMETIC_ENABLE", "OMP_KIT_SUITE_FENCE_ENABLE",
)


def qualification_environment(*, gate: bool = False) -> dict[str, str]:
    """Construct from empty; the shell policy owns tool order, not the caller."""
    home = os.environ.get("HOME", str(Path.home()))
    policy = Path(__file__).absolute().with_name("fixed-env.sh")
    result = run(["/bin/sh", "-c", '. "$1"; exec /usr/bin/env -0', "fixed-env", str(policy)],
                 env={"HOME": home}, deadline_s=10)
    if result.rc != 0 or result.timed_out or result.truncated:
        raise ValueError("pinned runtime environment is unavailable")
    environment = {"HOME": home}
    for item in result.stdout.decode("utf-8", errors="strict").split("\0"):
        key, separator, value = item.partition("=")
        if separator and key in ("PATH", "LANG", "LC_ALL"):
            environment[key] = value
    if not {"PATH", "LANG", "LC_ALL"}.issubset(environment):
        raise ValueError("pinned runtime environment is incomplete")
    environment.update({
        "FULL_SUITE_RUNTIME_ID": os.environ.get("FULL_SUITE_RUNTIME_ID", ""),
        "FULL_SUITE_TIMEOUT_SECS": os.environ.get("FULL_SUITE_TIMEOUT_SECS", "1800"),
        "OMP_KIT_CC": "0", "OMP_KIT_DISK_OBSERVER": "statfs", "OMP_KIT_OMP_SRC_FETCH": "0",
        "UV_THREADPOOL_SIZE": "4", "TOKIO_WORKER_THREADS": "4", "RAYON_NUM_THREADS": "4",
    })
    for name in (*SUITE_INPUTS, *(GATE_INPUTS if gate else ())):
        if name in os.environ:
            environment[name] = os.environ[name]
    return environment


def suite_environment() -> dict[str, str]:
    """Exactly the runtime-bound inputs; the harness adds its generated paths later."""
    return qualification_environment()


def runtime_parts() -> tuple[str, dict[str, str]]:
    """Bind versions observed under exactly the constructed suite environment."""
    environment = suite_environment()
    bun = run(["bun", "--version"], env=environment, deadline_s=10)
    if bun.rc != 0 or bun.timed_out or bun.truncated:
        raise ValueError("bun version is unavailable or incomplete")
    bun_version = bun.stdout.decode("utf-8", errors="strict").strip()
    if not bun_version:
        raise ValueError("bun version is empty")
    python = run(["python3", "--version"], env=environment, deadline_s=10)
    if python.rc != 0 or python.timed_out or python.truncated:
        raise ValueError("python3 version is unavailable or incomplete")
    python_version = python.stdout.decode("utf-8", errors="strict").strip().removeprefix("Python ")
    if not python_version:
        raise ValueError("python3 version is empty")
    return (f"{platform.system()}/{platform.machine()}/bun-{bun_version}"
            f"/python-{python_version}"), environment


def environment_digest(environment: dict[str, str]) -> str:
    environment_bytes = json.dumps(environment, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(environment_bytes).hexdigest()


def runtime_identity() -> str:
    """Bind executable versions and the environment inputs admitted to the full-suite runner."""
    prefix, environment = runtime_parts()
    return f"{prefix}/env-{environment_digest(environment)}"


def pin_runtime() -> None:
    """Also cover Python-only verdict-store and storegate invocations."""
    environment = qualification_environment(gate=True)
    os.environ.clear()
    os.environ.update(environment)


def hex_digest(value: object, length: int = 64) -> bool:
    return (isinstance(value, str) and len(value) == length
            and all(c in "0123456789abcdef" for c in value))


def nonnegative(value: object) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def complete_records(rows: object, declared: Sequence[str], *, expected_judge: dict | None = None) -> bool:
    if not isinstance(rows, list) or len(rows) != len(declared) or not declared:
        return False
    producer = expected_judge if expected_judge is not None else {"sha256": JUDGE_SHA256, "python": sys.version.split()[0]}
    if (not isinstance(producer, dict) or not hex_digest(producer.get("sha256"))
            or not isinstance(producer.get("python"), str) or not producer["python"]):
        return False
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            return False
        path = row.get("path")
        if not isinstance(path, str) or path not in declared or path in seen:
            return False
        seen.add(path)
        if row.get("runner") not in ("bun", "sh", "python3") or row.get("complete") is not True:
            return False
        if not all(nonnegative(row.get(k)) for k in ("elapsed_ms", "cpu_user_ms", "cpu_system_ms", "wait_ms", "setup_ms", "run_ms")):
            return False
        if any(not isinstance(row.get(k), int) or isinstance(row.get(k), bool)
               for k in ("started_ms", "finished_ms")):
            return False
        if row.get("phase_basis") != "stage-queue+exec-marker":
            return False
        if row["finished_ms"] < row["started_ms"]:
            return False
        if not isinstance(row.get("rc"), int) or isinstance(row["rc"], bool):
            return False
        command = row.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
            return False
        judge = row.get("judge")
        if (not isinstance(judge, dict) or not hex_digest(judge.get("sha256"))
                or judge["sha256"] != producer["sha256"]
                or judge.get("python") != producer["python"]
                or not hex_digest(row.get("output_sha256"))):
            return False
        closure = row.get("closure")
        if (not isinstance(closure, dict) or closure.get("kind") != "whole-source-tree"
                or not hex_digest(closure.get("tree"), 40)):
            return False
    return seen == set(declared)


def merge_timings(previous: object, rows: list[dict]) -> dict:
    if not isinstance(previous, dict) or previous.get("version") != 1 or not isinstance(previous.get("files"), dict):
        raise ValueError("timing table must be Bun version 1 with a files map")
    files = dict(previous["files"])
    if not all(isinstance(k, str) and nonnegative(v) for k, v in files.items()):
        raise ValueError("timing table contains invalid durations")
    for row in rows:
        if not isinstance(row.get("path"), str) or not nonnegative(row.get("elapsed_ms")):
            raise ValueError("invalid observed timing")
        files[row["path"]] = row.get("native_timing_ms", row["elapsed_ms"])
    return {"version": 1, "files": files}


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp." + str(os.getpid()))
    try:
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sample_load() -> float:
    return os.getloadavg()[0]


def execute(args: argparse.Namespace) -> int:
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise ValueError("run needs an actual command after --")
    if not nonnegative(args.wait_ms):
        raise ValueError("wait duration must be finite and nonnegative")
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    record = Path(args.record)
    record.parent.mkdir(parents=True, exist_ok=True)
    native_log = record.with_suffix(".native.log")
    started_ns = time.time_ns()
    started_ms = started_ns // 1_000_000
    load_1m = sample_load()
    # The native process writes directly to a retained file, never through a
    # helper-owned pipe/sink thread: even SIGKILL of this helper cannot discard
    # bytes the native process already flushed. Exec preserves its PID/group.
    with owned_tmp("suite-hermetic") as scratch:
        helper = str(Path(__file__).resolve().with_name("suite-hermetic-env.sh"))
        exec_marker = Path(scratch) / "exec-boundary.ns"
        wrapped = [
            "sh", helper, "--archive", os.path.abspath(args.cwd),
            "--scratch", scratch, "--suite", args.path,
            "--exec-marker", str(exec_marker),
        ]
        # Tern-backed tests need their OMP source cache despite the isolated suite HOME.
        # The suite fence still denies writes outside its scratch and archive.
        if os.environ.get("OMP_KIT_OMP_SRC_CACHE"):
            wrapped.extend(["--allow-env", "OMP_KIT_OMP_SRC_CACHE"])
        if args.loopback_port is not None:
            wrapped.extend(["--loopback-port", str(args.loopback_port)])
        wrapped.extend(["--", *command])
        with native_log.open("wb", buffering=0) as capture:
            fd = capture.fileno()
            launcher = [
                sys.executable, "-c",
                "import os,sys; fd=int(sys.argv[1]); "
                "os.dup2(fd,1); os.dup2(fd,2); os.close(fd); "
                "os.execvp(sys.argv[2],sys.argv[2:])",
                str(fd), *wrapped,
            ]
            result = run(launcher, cwd=args.cwd, deadline_s=args.deadline,
                         inherit_fds=(fd,), max_output_bytes=1 << 20)
        if not exec_marker.is_file() or exec_marker.is_symlink():
            raise ValueError("suite exec boundary marker is missing")
        exec_ns = int(exec_marker.read_text().strip())
        finished_ns = time.time_ns()
        finished_ms = finished_ns // 1_000_000
        load_1m_end = sample_load()
        if exec_ns < started_ns or finished_ns < exec_ns:
            raise ValueError("suite exec boundary timestamps are out of order")
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    # Cross-process phase markers use wall time; elapsed_ms remains supervisor-measured.
    digest = hashlib.sha256()
    tail = bytearray()
    with native_log.open("rb") as capture:
        while chunk := capture.read(65536):
            digest.update(chunk)
            tail.extend(chunk)
            if len(tail) > 65536:
                del tail[:-65536]
            sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    # A deadline or group kill cannot become complete evidence, even though its
    # partial native bytes remain available to the incomplete-run log collector.
    complete = (result.rc is not None and result.rc >= 0 and not result.timed_out and not result.killed
                and result.stream_dropped_bytes == 0 and result.sink_error is None)
    row = {"path": args.path, "runner": args.runner, "elapsed_ms": result.elapsed_s * 1000,
           "started_ms": started_ms, "finished_ms": finished_ms,
           "wait_ms": args.wait_ms, "setup_ms": (exec_ns - started_ns) / 1_000_000,
           "run_ms": (finished_ns - exec_ns) / 1_000_000,
           "phase_basis": "stage-queue+exec-marker",
           "cpu_user_ms": max(0.0, after.ru_utime - before.ru_utime) * 1000,
           "cpu_system_ms": max(0.0, after.ru_stime - before.ru_stime) * 1000,
           "rc": result.rc, "command": command, "launcher": launcher, "complete": complete,
           "workers": args.workers, "ncpu": os.cpu_count() or 1,
           "load_1m": load_1m, "load_1m_end": load_1m_end,
           "judge": {"sha256": JUDGE_SHA256,
                     "python": sys.version.split()[0]},
           "output_sha256": digest.hexdigest(),
           "closure": {"kind": "whole-source-tree", "tree": args.tree},
           "timed_out": result.timed_out, "killed": result.killed}
    if args.runner == "bun":
        summaries = []
        failures = []
        for line in tail.decode("utf-8", errors="replace").splitlines():
            tokens = line.split()
            if len(tokens) >= 5 and tokens[0] == "Ran" and tokens[1].isdigit() and tokens[2] in ("test", "tests") and tokens[3] == "across":
                summaries.append(int(tokens[1]))
            if len(tokens) == 2 and tokens[0].isdigit() and tokens[1] == "fail":
                failures.append(int(tokens[0]))
        row["test_count"] = summaries[-1] if summaries else 0
        row["test_failures"] = failures[-1] if failures else 0
        if not summaries:
            row["complete"] = complete = False
        for argument in command:
            if argument.startswith("--timings="):
                native = Path(argument.partition("=")[2])
                if native.exists():
                    table = json.loads(native.read_text())
                    duration = table.get("files", {}).get(args.path)
                    if table.get("version") != 1 or not nonnegative(duration):
                        raise ValueError("invalid native Bun timing for " + args.path)
                    row["native_timing_ms"] = duration
                    native.unlink(missing_ok=True)
    atomic_json(Path(args.record), row)
    if not complete:
        print("SUITE_TIMING_INCOMPLETE: " + args.path, file=sys.stderr)
        return 125
    return result.rc if result.rc >= 0 else 128 - result.rc


def collect(args: argparse.Namespace) -> int:
    rows: list[dict] = []
    for path in sorted(Path(args.records).glob("*.json")):
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError("invalid file record: " + str(path))
        rows.append(value)
    declared = Path(args.declared).read_text().splitlines()
    if args.covered:
        covered = json.loads(Path(args.covered).read_text())
        if not isinstance(covered, list):
            raise ValueError("invalid focused timing records")
        rows.extend({**row, "origin": "focused"} for row in covered if row.get("path") in declared)
    if not complete_records(rows, declared):
        raise ValueError("SUITE_TIMING_INCOMPLETE: declared file set differs from complete measured records")
    rows.sort(key=lambda row: row["path"])
    atomic_json(Path(args.output), rows)
    for runner, filename in (("bun", "core-test-timings.json"), ("scripts", "script-test-timings.json")):
        source = Path(args.cwd) / ".github" / filename
        path = Path(args.tables_dir) / filename if args.tables_dir else source
        previous = path if path.exists() else source
        old = json.loads(previous.read_text()) if previous.exists() else {"version": 1, "files": {}}
        observed = [r for r in rows if (r["runner"] == "bun") == (runner == "bun")]
        atomic_json(path, merge_timings(old, observed))
    with open(args.csv, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["stage", "file", "elapsed_s", "rc", "workers", "load_1m", "cpu_user_s", "cpu_system_s", "command", "judge", "closure"])
        for row in rows:
            writer.writerow([row["runner"], row["path"], row["elapsed_ms"] / 1000, row["rc"],
                             row.get("workers", 1), row.get("load_1m", ""),
                             row["cpu_user_ms"] / 1000, row["cpu_system_ms"] / 1000,
                             json.dumps(row["command"]), json.dumps(row.get("judge")), json.dumps(row["closure"])])
    return 0


def watch_parent(fd: int) -> None:
    """EOF cancels this file helper, whose pysafe entry point drains its native group.

    Only the stage retains a writer; native commands never inherit this read end.
    Kernel closure on stage SIGKILL therefore has the same effect as orderly
    stage cancellation, without killing a wrapper before its native run unwinds.
    """
    if fd < 3:
        raise ValueError("parent descriptor must be >= 3")
    os.fstat(fd)

    def guardian() -> None:
        try:
            with os.fdopen(fd, "rb", buffering=0) as parent:
                parent.read(1)
        finally:
            os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=guardian, name="suite-parent-liveness", daemon=True).start()


def stage(args: argparse.Namespace) -> int:
    """Run actual file processes; each child owns its CPU accounting and deadline."""
    directory = Path(args.records)
    directory.mkdir(parents=True, exist_ok=True)
    paths = args.paths
    load_wave = getattr(args, "load_wave", False)
    if not paths or (len(set(paths)) != len(paths) and not load_wave):
        raise ValueError("stage requires distinct file paths outside a load wave")
    parent_reader, parent_writer = os.pipe()

    def one(item: tuple[int, str], queued_ns: int) -> tuple[Path, bool]:
        index, path = item
        record = directory / f"{args.runner}-{index}.json"
        logfile = directory / f"{args.runner}-{index}.log"
        runner = ("python3" if path.endswith(".py") else "sh") if args.runner == "scripts" else args.runner
        if runner == "bun":
            # The child sandbox allows archive writes, not the stage's external records directory.
            timing_path = (Path(args.cwd).resolve() / "var" / "agent-tmp"
                           / f"suite-metrics-bun-{os.getpid()}-{index}.timings")
            timing_path.parent.mkdir(parents=True, exist_ok=True)
            command = ["bun", "--config=" + args.bun_config, "test", "--timeout=120000",
                       "--timings=" + str(timing_path),
                       "--update-timings", "./" + path]
        else:
            command = [runner, path]
        child = [sys.executable, str(Path(__file__).resolve()), "run", "--record", str(record),
                 "--path", path, "--runner", runner, "--tree", args.tree,
                 "--cwd", args.cwd, "--deadline", str(args.deadline), "--workers", str(workers),
                 "--parent-fd", str(parent_reader)]
        wait_ms = max(0, time.monotonic_ns() - queued_ns) / 1_000_000
        child.extend(["--wait-ms", repr(wait_ms)])
        if args.loopback_port is not None:
            child.extend(["--loopback-port", str(args.loopback_port)])
        child.extend(["--", *command])
        with logfile.open("wb") as output:
            result = run(child, cwd=args.cwd, deadline_s=args.deadline + 10,
                         on_output=lambda _stream, chunk: output.write(chunk),
                         inherit_fds=(parent_reader,),
                         max_output_bytes=1024, max_sink_queue_bytes=16 << 20)
        return logfile, (result.rc is not None and not result.timed_out and not result.killed
                         and result.stream_dropped_bytes == 0 and result.sink_error is None)

    workers = min(args.workers, len(paths))
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = []
        for item in enumerate(paths):
            futures.append(pool.submit(one, item, time.monotonic_ns()))
        outcomes = [future.result() for future in futures]  # pysafe: each future only invokes the bounded kitlib runner; parent cancellation closes its liveness writer before worker join.
    finally:
        # Do not let executor.__exit__ wait before cancellation reaches file
        # helpers. Close our sole writer first, cancel queued work, then allow
        # each running wrapper to drain its own native group before being reaped.
        os.close(parent_writer)
        try:
            pool.shutdown(wait=True, cancel_futures=True)
        finally:
            os.close(parent_reader)
    rows = []
    incomplete = []
    for index, ((logfile, outer_complete), path) in enumerate(zip(outcomes, paths)):
        with logfile.open("rb") as handle:
            while chunk := handle.read(65536):
                sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        record = directory / f"{args.runner}-{index}.json"
        if not record.exists() or not outer_complete:
            native_log = record.with_suffix(".native.log")
            if native_log.is_file():
                with native_log.open("rb") as handle:
                    while chunk := handle.read(65536):
                        sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            incomplete.append(path)
            continue
        row = json.loads(record.read_text())
        rows.append(row)
        if args.runner != "bun":
            kind = "script-suite" if row["runner"] == "sh" else "python-suite"
            print(("GREEN" if row["rc"] == 0 else "RED") + " " + kind + " " + path, flush=True)
    if incomplete:
        raise ValueError("stage children did not complete: " + ", ".join(incomplete))
    complete = (all(complete_records([row], [path]) for row, path in zip(rows, paths))
                if load_wave else complete_records(rows, paths))
    code = 0 if complete and all(row["rc"] == 0 for row in rows) else 1
    atomic_json(Path(args.summary), {"complete": complete, "rc": code, "workers": workers,
                                   "test_count": sum(row.get("test_count", 0) for row in rows),
                                   "test_failures": sum(row.get("test_failures", 0) for row in rows),
                                   "files": rows})
    return code


def load(args: argparse.Namespace) -> int:
    """Endorse only changed files, with one bounded K-copy wave per file."""
    if not 2 <= args.workers <= 6:
        raise ValueError("load concurrency must be 2..6")
    changed = set(Path(args.changed_files).read_text().splitlines())
    selected = [path for path in dict.fromkeys(args.paths)
                if path in changed and (Path(args.cwd) / path).is_file()]
    if not selected:
        print("LOADGATE1: no changed focused test files; no copies run", flush=True)
        return 0
    limits = run(["bun", "run", "--no-env-file", "--config=/dev/null",
                  str(Path(__file__).with_name("test-budget.ts")), "--repo", args.policy_root,
                  "--file-limits", "--json"], deadline_s=10)
    if limits.rc != 0 or limits.timed_out or limits.truncated:
        raise ValueError("cannot read canonical changed-file limits: " + limits.stdout.decode(errors="replace")
                         + limits.stderr.decode(errors="replace"))
    policy = json.loads(limits.stdout)
    # At worst K copies serialize their work. ceiling * K is only the outer
    # hang guard; the load verdict comes from native copy failures, not elapsed
    # time. The ordinary focused cap already passed and remains unchanged.
    allowance = args.workers
    env_mode = "scrubbed" if os.environ.get("OMP_KIT_SUITE_HERMETIC_ENABLE") == "1" else "allowlisted"
    for index, path in enumerate(selected):
        ceiling = policy["grandfathered"].get(path, policy["cap_s"])
        directory = Path(args.records) / str(index)
        wave_args = argparse.Namespace(
            cwd=args.cwd, tree=args.tree, records=str(directory), summary=str(directory / "wave.json"),
            runner="bun" if path.endswith((".ts", ".tsx", ".js", ".mts", ".cts")) else "scripts",
            paths=[path] * args.workers, workers=args.workers, deadline=ceiling * allowance,
            bun_config=str(Path(args.cwd) / "bunfig.toml"), loopback_port=None, load_wave=True,
        )
        started = time.monotonic()
        load1 = os.getloadavg()[0]
        with owned_tmp("loadgate-wave", root=str(Path(args.cwd).resolve() / "var" / "agent-tmp")) as scratch:
            inherited_tmp = os.environ.get("TMPDIR")
            os.environ["TMPDIR"] = scratch
            try:
                code = stage(wave_args)
            except (OSError, ValueError, TypeError, KeyError) as error:
                print("LOADGATE1: " + str(error), file=sys.stderr)
                code = 1
            finally:
                if inherited_tmp is None:
                    os.environ.pop("TMPDIR", None)
                else:
                    os.environ["TMPDIR"] = inherited_tmp
        elapsed = round((time.monotonic() - started) * 1000)
        print(f"LOADGATE1 {'GREEN' if code == 0 else 'RED'} file={path} concurrency={args.workers} "
              f"load1={load1:.2f} env={env_mode} load1_end={os.getloadavg()[0]:.2f} "
              f"ceiling_s={ceiling} contention_allowance={allowance} added_ms={elapsed}", flush=True)
        if code != 0:
            print(f"FRESH-GATE: RED: LOADGATE1 file={path} concurrency={args.workers} load1={load1:.2f} env={env_mode}; "
                  "native failing case output above", file=sys.stderr)
            return 1
    return 0


def judging_file_copies(paths: list[Path]) -> list[str]:
    """Find fixture-local literal closure lists, including script-basename lists."""
    names = {name for path in JUDGING_FILES for name in (path, Path(path).name)}
    findings = []
    for path in paths:
        source = path.read_text()
        matched = {Path(value).name for value in names
                   if any(quote + value + quote in source for quote in ("'", '"'))}
        if len(matched) >= 6:
            findings.append(str(path))
    return findings

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    identity = subs.add_parser("identity")
    identity.add_argument("--root", required=True)
    identity.add_argument("--scope", choices=("full", "focused"), required=True)
    subs.add_parser("runtime")
    subs.add_parser("runtime-environment", help="Print the judged runtime and its admitted environment")
    subs.add_parser("judging-files", help="Print the canonical judged-file closure, one repository-relative path per line")
    subs.add_parser("shell-environment", help="Print a shell-quoted allowlisted env invocation")
    copies = subs.add_parser("check-judging-copies", help="Reject fixture-local literal copies of the judged-file closure")
    copies.add_argument("paths", nargs="+")
    child = subs.add_parser("run")
    child.add_argument("--record", required=True)
    child.add_argument("--path", required=True)
    child.add_argument("--runner", choices=("bun", "sh", "python3"), required=True)
    child.add_argument("--cwd", required=True)
    child.add_argument("--tree", required=True)
    child.add_argument("--deadline", type=float, required=True)
    child.add_argument("--workers", type=int, default=1)
    child.add_argument("--wait-ms", type=float, default=0)
    child.add_argument("--loopback-port", type=int)
    child.add_argument("--parent-fd", type=int)
    child.add_argument("command", nargs=argparse.REMAINDER)
    bundle = subs.add_parser("collect")
    for option in ("records", "declared", "output", "csv", "cwd"):
        bundle.add_argument("--" + option, required=True)
    bundle.add_argument("--covered")
    bundle.add_argument("--tables-dir", help="Persist native timing maps outside a disposable source archive")
    batch = subs.add_parser("stage")
    for option in ("records", "cwd", "tree", "summary"):
        batch.add_argument("--" + option, required=True)
    batch.add_argument("--runner", choices=("bun", "sh", "python3", "scripts"), required=True)
    batch.add_argument("--deadline", type=float, required=True)
    batch.add_argument("--workers", type=int, required=True)
    batch.add_argument("--loopback-port", type=int)
    batch.add_argument("paths", nargs="+")
    batch.add_argument("--bun-config", default="/dev/null")
    stress = subs.add_parser("load")
    for option in ("records", "cwd", "tree", "changed-files", "policy-root"):
        stress.add_argument("--" + option, required=True)
    stress.add_argument("--workers", type=int, default=max(2, min(6, (os.cpu_count() or 4) // 4)))
    stress.add_argument("paths", nargs="*")
    args = parser.parse_args()
    try:
        if args.action == "shell-environment":
            environment = qualification_environment(gate=True)
            print(shlex.join(["/usr/bin/env", "-i", *(f"{key}={value}" for key, value in environment.items())]))
            return 0
        if args.action == "judging-files":
            print("\n".join(JUDGING_FILES))
            return 0
        if args.action == "check-judging-copies":
            findings = judging_file_copies([Path(path) for path in args.paths])
            for path in findings:
                print("JUDGECLOSURE1: literal judging closure: " + path, file=sys.stderr)
            return int(bool(findings))
        if args.action == "identity":
            print(judge_identity(args.root, args.scope))
            return 0
        if args.action == "runtime":
            pin_runtime()
            print(runtime_identity())
            return 0
        if args.action == "runtime-environment":
            pin_runtime()
            prefix, environment = runtime_parts()
            print(json.dumps({"runtime": f"{prefix}/env-{environment_digest(environment)}",
                              "environment": environment}, sort_keys=True))
            return 0
        if args.action == "run":
            if args.parent_fd is not None:
                watch_parent(args.parent_fd)
            return execute(args)
        if args.action == "stage":
            if args.workers < 1 or args.deadline <= 0:
                raise ValueError("workers and deadline must be positive")
            return stage(args)
        if args.action == "load":
            return load(args)
        return collect(args)
    except (OSError, ValueError, TypeError, KeyError) as error:
        print("SUITE_TIMING_INVALID: " + str(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    pysafe.run_main(main)
