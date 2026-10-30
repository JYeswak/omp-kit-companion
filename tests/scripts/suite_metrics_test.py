#!/usr/bin/env python3
"""SUITEBUDGET1 record completeness and merge invariants."""
from __future__ import annotations

from concurrent.futures import Future, TimeoutError as FutureTimeout
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import sys
import threading
from typing import Iterator
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("suite_metrics", ROOT / "scripts/suite-metrics.py")
if spec is None or spec.loader is None:
    raise RuntimeError("suite metrics module unavailable")
metrics = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = metrics
spec.loader.exec_module(metrics)
from kitlib_tmp import owned_tmp
from kitlib_run import RunResult

HELPER = ROOT / "scripts/suite-metrics.py"
JUDGING_FILES = (
    "scripts/full-suite-verdict.sh", "scripts/fresh-gate.sh", "scripts/suite-metrics.py",
    "scripts/full-suite-verdict-store.py",
    "scripts/suite-hermetic-env.sh", "scripts/kitlib_run.py", "scripts/kitlib_tmp.py",
    "scripts/pysafe.py", "scripts/kitlib-tmp.sh", "scripts/test-budget.ts",
    ".github/test-budget.json",
)


def row(path: str, rc: int = 0) -> dict:
    return {"path": path, "runner": "sh", "elapsed_ms": 10.0, "rc": rc,
            "command": ["sh", path], "cpu_user_ms": 1.0, "cpu_system_ms": 1.0,
            "started_ms": 1000, "finished_ms": 1010, "workers": 1, "load_1m": 1.0,
            "judge": {"sha256": metrics.JUDGE_SHA256, "python": sys.version.split()[0]},
            "output_sha256": hashlib.sha256(b"output").hexdigest(),
            "complete": True, "closure": {"kind": "whole-source-tree", "tree": "a" * 40}}


class SuiteMetricsTests(unittest.TestCase):
    def test_missing_declared_file_cannot_certify_complete(self) -> None:
        self.assertFalse(metrics.complete_records([row("a")], ["a", "b"]))

    def test_duplicate_file_cannot_replace_an_omission(self) -> None:
        self.assertFalse(metrics.complete_records([row("a"), row("a")], ["a", "b"]))

    def test_failure_is_retained_in_complete_record(self) -> None:
        self.assertTrue(metrics.complete_records([row("a", 4), row("b")], ["a", "b"]))

    def test_unknown_closure_is_cold(self) -> None:
        r = row("a")
        r["closure"] = None
        self.assertFalse(metrics.complete_records([r], ["a"]))

    def test_invalid_or_incomplete_measurements_are_not_evidence(self) -> None:
        for field, value in (("elapsed_ms", float("nan")), ("rc", None),
                             ("cpu_user_ms", -1), ("complete", False),
                             ("started_ms", None), ("started_ms", float("inf")),
                             ("finished_ms", float("nan")), ("finished_ms", 999),
                             ("output_sha256", "x" * 64), ("output_sha256", "a" * 63),
                             ("judge", None), ("judge", {}),
                             ("judge", {"sha256": metrics.JUDGE_SHA256}),
                             ("judge", {"python": sys.version.split()[0]}),
                             ("judge", {"sha256": "b" * 64, "python": sys.version.split()[0]}),
                             ("judge", {"sha256": metrics.JUDGE_SHA256, "python": "different"})):
            r = row("a")
            r[field] = value
            self.assertFalse(metrics.complete_records([r], ["a"]), field)

    def test_every_required_field_omission_is_cold(self) -> None:
        for field in ("path", "runner", "elapsed_ms", "rc", "command", "cpu_user_ms",
                      "cpu_system_ms", "started_ms", "finished_ms", "complete", "closure",
                      "judge", "output_sha256"):
            with self.subTest(field=field):
                r = row("a")
                del r[field]
                self.assertFalse(metrics.complete_records([r], ["a"]))

    def test_each_judge_field_omission_is_cold(self) -> None:
        for field in ("sha256", "python"):
            r = row("a")
            del r["judge"][field]
            self.assertFalse(metrics.complete_records([r], ["a"]), field)

    def test_merge_refreshes_all_observed_and_preserves_deleted_file(self) -> None:
        previous = {"version": 1, "files": {"gone": 99, "a": 90, "b": 80}}
        merged = metrics.merge_timings(previous, [row("a"), row("b"), row("c")])
        self.assertEqual(merged, {"version": 1, "files": {"gone": 99, "a": 10.0, "b": 10.0, "c": 10.0}})
        self.assertEqual(previous["files"]["a"], 90)


class JudgeIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = owned_tmp("suite-identity-test")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.path)
        for name in JUDGING_FILES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(("fixture " + name).encode())

    def identity_cli(self, scope: str) -> RunResult:
        return metrics.run([sys.executable, str(HELPER), "identity", "--root", str(self.root),
                            "--scope", scope], deadline_s=10)

    def test_cli_prints_only_stable_hex_digest(self) -> None:
        first = self.identity_cli("full")
        second = self.identity_cli("full")
        self.assertEqual((first.rc, second.rc), (0, 0), first.stderr)
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(first.stdout, (metrics.judge_identity(self.root, "full") + "\n").encode())
        self.assertEqual(len(first.stdout), 65)
        self.assertTrue(all(c in b"0123456789abcdef" for c in first.stdout[:-1]))

    def test_relocated_checkout_has_identical_identity(self) -> None:
        relocated = self.root / "relocated"
        for name in JUDGING_FILES:
            path = relocated / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((self.root / name).read_bytes())
        for scope in ("full", "focused"):
            self.assertEqual(metrics.judge_identity(self.root, scope),
                             metrics.judge_identity(relocated, scope))

    def test_every_required_dependency_byte_change_changes_identity(self) -> None:
        for scope in ("full", "focused"):
            for name in JUDGING_FILES:
                if scope == "focused" and name == "scripts/full-suite-verdict.sh":
                    continue
                with self.subTest(scope=scope, path=name):
                    before = metrics.judge_identity(self.root, scope)
                    path = self.root / name
                    original = path.read_bytes()
                    path.write_bytes(original + b"\nchanged")
                    self.assertNotEqual(before, metrics.judge_identity(self.root, scope))
                    path.write_bytes(original)

    def test_missing_required_dependency_fails_closed(self) -> None:
        for scope in ("full", "focused"):
            for name in JUDGING_FILES:
                if scope == "focused" and name == "scripts/full-suite-verdict.sh":
                    continue
                with self.subTest(scope=scope, path=name):
                    path = self.root / name
                    original = path.read_bytes()
                    path.unlink()
                    result = self.identity_cli(scope)
                    self.assertNotEqual(result.rc, 0)
                    self.assertEqual(result.stdout, b"")
                    path.write_bytes(original)

    def test_focused_excludes_full_writer_and_both_bind_optional_registry(self) -> None:
        full = metrics.judge_identity(self.root, "full")
        focused = metrics.judge_identity(self.root, "focused")
        (self.root / "scripts/full-suite-verdict.sh").unlink()
        self.assertEqual(focused, metrics.judge_identity(self.root, "focused"))
        (self.root / "scripts/full-suite-verdict.sh").write_bytes(b"changed")
        self.assertNotEqual(full, metrics.judge_identity(self.root, "full"))
        for content in (b"tests/first.sh\tci\n", b"tests/second.sh\tci\n"):
            before = {scope: metrics.judge_identity(self.root, scope) for scope in ("full", "focused")}
            (self.root / "scripts/gate-ci-only.tsv").write_bytes(content)
            for scope in before:
                self.assertNotEqual(before[scope], metrics.judge_identity(self.root, scope))

    def test_identity_binds_paths_not_just_concatenated_bytes(self) -> None:
        first = self.root / "scripts/fresh-gate.sh"
        second = self.root / "scripts/kitlib_run.py"
        first.write_bytes(b"a")
        second.write_bytes(b"bc")
        before = metrics.judge_identity(self.root, "full")
        first.write_bytes(b"ab")
        second.write_bytes(b"c")
        self.assertNotEqual(before, metrics.judge_identity(self.root, "full"))


class SuiteMetricsNativeLogTests(unittest.TestCase):
    def test_flushed_native_log_survives_child_killing_helper_and_control_replays_raw_bytes(self) -> None:
        with owned_tmp("suite-native-log-test") as directory:
            root = Path(directory)
            fixture = root / "native.py"
            fixture.write_text(
                "import os, signal, sys\n"
                "print('PARTIAL', flush=True)\n"
                "sys.stderr.buffer.write(b'NATIVE-ERR\\x00\\xff\\n')\n"
                "sys.stderr.buffer.flush()\n"
                "print(sys.argv[2], flush=True)\n"
                "if sys.argv[1] == 'kill':\n"
                "    os.kill(os.getppid(), signal.SIGKILL)\n"
            )
            expected = b"PARTIAL\nNATIVE-ERR\x00\xff\nargument with spaces\n"
            for mode in ("control", "kill"):
                with self.subTest(mode=mode):
                    record = root / (mode + ".json")
                    command = [sys.executable, str(fixture), mode, "argument with spaces"]
                    result = metrics.run(
                        [sys.executable, str(HELPER), "run", "--record", str(record),
                         "--path", "native.py", "--runner", "python3", "--cwd", directory,
                         "--tree", "a" * 40, "--deadline", "5", "--", *command],
                        deadline_s=10,
                    )
                    self.assertEqual(result.rc, -signal.SIGKILL if mode == "kill" else 0, result.stderr)
                    # The child flushed before killing its parent: no polling or
                    # helper-side replay is needed for these bytes to survive.
                    captured = record.with_suffix(".native.log").read_bytes()
                    self.assertIn(b"SUITE-HERMETIC suite=native.py ", captured)
                    self.assertTrue(captured.endswith(expected), captured)
                    if mode == "kill":
                        self.assertFalse(record.exists())
                    else:
                        self.assertEqual(result.stdout, captured)
                        measured = json.loads(record.read_text())
                        self.assertTrue(metrics.complete_records([measured], ["native.py"]))
                        self.assertEqual(measured["command"], command)
                        self.assertEqual(measured["launcher"][-len(command):], command)
                        self.assertEqual(measured["output_sha256"], hashlib.sha256(captured).hexdigest())

    def test_stage_replays_native_output_after_helper_dies_and_keeps_other_results(self) -> None:
        with owned_tmp("suite-stage-native-log-test") as directory:
            root = Path(directory)
            (root / "interrupted.py").write_text(
                "import os, signal\n"
                "print('INTERRUPTED-NATIVE-DETAIL', flush=True)\n"
                "os.kill(os.getppid(), signal.SIGKILL)\n"
            )
            (root / "control.py").write_text("print('SUCCESSFUL-CONTROL-DETAIL', flush=True)\n")
            records, summary = root / "records", root / "summary.json"
            result = metrics.run(
                [sys.executable, str(HELPER), "stage", "--records", str(records),
                 "--cwd", directory, "--tree", "a" * 40, "--summary", str(summary),
                 "--runner", "python3", "--workers", "1", "--deadline", "5",
                 "interrupted.py", "control.py"], deadline_s=15,
            )
            self.assertEqual(result.rc, 125, result.stderr)
            self.assertIn(b"INTERRUPTED-NATIVE-DETAIL", result.stdout)
            self.assertIn(b"SUCCESSFUL-CONTROL-DETAIL", result.stdout)
            self.assertFalse((records / "python3-0.json").exists())
            self.assertEqual(json.loads((records / "python3-1.json").read_text())["rc"], 0)
            self.assertFalse(summary.exists())


class SuiteMetricsCancellationTests(unittest.TestCase):
    @contextmanager
    def running(self, stage: bool, *, file_deadline: float = 30,
                supervisor_deadline: float | None = None
                ) -> Iterator[tuple[Future[RunResult], int, dict[str, socket.socket], Path]]:
        with owned_tmp("suite-cancel-test") as directory:
            root = Path(directory)
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            listener.listen(3)
            listener.settimeout(10)
            port = listener.getsockname()[1]
            fixture = root / "native.py"
            fixture.write_text(
                "import json, os, signal, socket\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "def ready(role):\n"
                f"    conn = socket.create_connection(('127.0.0.1', {port}), timeout=10)\n"
                "    conn.settimeout(None)\n"
                "    conn.sendall((json.dumps({'role': role, 'pid': os.getpid(), "
                "'parent': os.getppid()}) + '\\n').encode())\n"
                "    conn.recv(1)\n"
                "    conn.close()\n"
                "child = os.fork()\n"
                "if child == 0:\n"
                "    ready('descendant')\n"
                "    os._exit(0)\n"
                "ready('native')\n"
                "os.waitpid(child, 0)\n"
                "print('native finished', flush=True)\n"
            )
            (root / "pending.py").write_text("from pathlib import Path\nPath('pending-ran').write_text('ran')\n")
            if stage:
                command = [sys.executable, str(HELPER), "stage", "--records", str(root / "records"),
                           "--summary", str(root / "summary.json"), "--runner", "python3",
                           "--workers", "1", "--cwd", directory, "--tree", "a" * 40,
                           "--deadline", str(file_deadline), "--loopback-port", str(port),
                           "native.py", "pending.py"]
            else:
                command = [sys.executable, str(HELPER), "run", "--record", str(root / "record.json"),
                           "--path", "native.py", "--runner", "python3", "--cwd", directory,
                           "--tree", "a" * 40, "--deadline", str(file_deadline),
                           "--loopback-port", str(port), "--", sys.executable, str(fixture)]
            if supervisor_deadline is not None:
                command = [sys.executable, str(ROOT / "scripts/pysafe.py"), "run",
                           "--timeout", str(supervisor_deadline), "--", *command]
            # Report the runner-owned PID, then exec the real supervisor without
            # changing that PID. This is a test fixture, not a production API.
            command = [
                sys.executable, "-c",
                "import json,os,socket,sys; "
                f"conn=socket.create_connection(('127.0.0.1',{port}),timeout=10); "
                "conn.sendall((json.dumps({'role':'supervisor','pid':os.getpid()})+'\\n').encode()); "
                "conn.close(); os.execv(sys.argv[1],sys.argv[1:])",
                *command,
            ]
            future: Future[RunResult] = Future()

            def supervise() -> None:
                try:
                    future.set_result(metrics.run(command, deadline_s=20))
                except BaseException as error:
                    future.set_exception(error)

            worker = threading.Thread(target=supervise, name="suite-test-supervisor", daemon=True)
            worker.start()
            channels = {}
            pids = {}
            connections = []
            settled = False
            try:
                for _ in range(3):
                    connection, _address = listener.accept()
                    connections.append(connection)
                    connection.settimeout(10)
                    # Native/descendant sockets stay open while blocked in recv.
                    # EOF without a sent token therefore observes its real death.
                    data = bytearray()
                    while not data.endswith(b"\n") and len(data) < 4096:
                        chunk = connection.recv(1)
                        if not chunk:
                            break
                        data.extend(chunk)
                    identity = json.loads(data)
                    if identity["role"] == "supervisor":
                        connection.close()
                    else:
                        channels[identity["role"]] = connection
                    pids[identity["role"]] = identity
                    os.kill(identity["pid"], 0)
                self.assertEqual(set(channels), {"native", "descendant"})
                yield future, pids["supervisor"]["pid"], channels, root
                settled = True
            finally:
                # On regression, drain only groups/PIDs this fixture owns before
                # killing wrappers; cleanup must not leave the planted orphan.
                if not future.done() and "supervisor" in pids:
                    try:
                        os.kill(pids["supervisor"]["pid"], signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                if not settled:
                    if "native" in pids:
                        try:
                            os.killpg(pids["native"]["pid"], signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    for role in ("native", "descendant"):
                        if role not in pids:
                            continue
                        try:
                            os.kill(pids[role]["pid"], signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    if stage and "native" in pids:
                        try:
                            os.kill(pids["native"]["parent"], signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                try:
                    future.result(timeout=25)
                except FutureTimeout:
                    if not future.done() and "supervisor" in pids:
                        try:
                            os.kill(pids["supervisor"]["pid"], signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    future.result(timeout=5)
                finally:
                    worker.join(timeout=1)
                    for connection in connections:
                        connection.close()
                    listener.close()
                    if worker.is_alive():
                        raise RuntimeError("bounded suite supervisor thread did not finish")

    def test_direct_file_term_and_int_kill_actual_descendant(self) -> None:
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signum=signum), self.running(False) as (future, supervisor, channels, root):
                os.kill(supervisor, signum)
                result = future.result(timeout=10)
                self.assertEqual(result.rc, 128 + signum, result.stderr)
                for role, connection in channels.items():
                    self.assertEqual(connection.recv(1), b"", role + " survived cancellation")
                self.assertFalse((root / "record.json").exists())

    def test_stage_signals_and_supervisor_sigkill_kill_descendants_without_starting_pending(self) -> None:
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGKILL):
            with self.subTest(signum=signum), self.running(True) as (future, supervisor, channels, root):
                os.kill(supervisor, signum)
                result = future.result(timeout=10)
                expected = -signal.SIGKILL if signum == signal.SIGKILL else 128 + signum
                self.assertEqual(result.rc, expected, result.stderr)
                for role, connection in channels.items():
                    self.assertEqual(connection.recv(1), b"", role + " survived stage cancellation")
                self.assertFalse((root / "pending-ran").exists())
                self.assertFalse((root / "summary.json").exists())

    def test_native_deadlines_drain_descendants_and_refuse_complete_evidence(self) -> None:
        for stage in (False, True):
            with self.subTest(stage=stage), self.running(stage, file_deadline=4) as (future, _supervisor, channels, root):
                result = future.result(timeout=15)
                self.assertEqual(result.rc, 1 if stage else 125, result.stderr)
                for role, connection in channels.items():
                    self.assertEqual(connection.recv(1), b"", role + " survived file deadline")
                record = root / "records/python3-0.json" if stage else root / "record.json"
                self.assertFalse(json.loads(record.read_text())["complete"])
                if stage:
                    self.assertFalse(json.loads((root / "summary.json").read_text())["complete"])

    def test_outer_budget_expiry_cancels_nested_stage_and_native_groups(self) -> None:
        with self.running(True, supervisor_deadline=4) as (future, _supervisor, channels, root):
            result = future.result(timeout=15)
            self.assertEqual(result.rc, 124, result.stderr)
            for role, connection in channels.items():
                self.assertEqual(connection.recv(1), b"", role + " survived outer budget expiry")
            self.assertFalse((root / "pending-ran").exists())
            self.assertFalse((root / "summary.json").exists())

    def test_normal_file_and_stage_wait_for_children_and_record_complete_evidence(self) -> None:
        for stage in (False, True):
            with self.subTest(stage=stage), self.running(stage) as (future, _supervisor, channels, root):
                channels["descendant"].sendall(b"x")
                channels["native"].sendall(b"x")
                result = future.result(timeout=10)
                self.assertEqual(result.rc, 0, result.stderr)
                self.assertIn(b"native finished", result.stdout)
                if stage:
                    summary = json.loads((root / "summary.json").read_text())
                    self.assertTrue(summary["complete"])
                    self.assertTrue((root / "pending-ran").exists())
                    rows = summary["files"]
                    declared = ["native.py", "pending.py"]
                else:
                    rows = [json.loads((root / "record.json").read_text())]
                    declared = ["native.py"]
                self.assertTrue(metrics.complete_records(rows, declared))


if __name__ == "__main__":
    unittest.main()
