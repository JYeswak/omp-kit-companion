#!/usr/bin/env python3
"""Contract tests for scripts/pysafe.py (ompkit-xa5s.34): every bound is observed on real processes, pipes and sockets."""
from __future__ import annotations

import importlib.util
import io
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts" / "pysafe.py"
_spec = importlib.util.spec_from_file_location("pysafe", HELPER)
if _spec is None or _spec.loader is None:
    raise ImportError("cannot load scripts/pysafe.py")
pysafe = importlib.util.module_from_spec(_spec)
sys.modules["pysafe"] = pysafe
_spec.loader.exec_module(pysafe)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_dead(pid: int, budget: float = 3.0) -> bool:
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.05)
    return not alive(pid)


def read_pid(path: Path, budget: float = 3.0) -> int:
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        text = path.read_text() if path.exists() else ""
        if text.strip():
            return int(text.split()[0])
        time.sleep(0.02)
    raise AssertionError(f"no pid written to {path}")


class Scratch(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory(prefix="pysafe-test.")
        self.tmp = Path(self._dir.name)
        self.pids: list = []

    def tearDown(self) -> None:
        for pid in self.pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self._dir.cleanup()


class GrandchildHoldsPipe(Scratch):
    """The planted case: a grandchild inherits stdout and outlives the timeout.

    The two plain-stdlib controls fail the contract run_bounded keeps: the
    documented communicate/kill/communicate pattern stays blocked past its
    timeout, and subprocess.run(timeout=) returns but leaves the grandchild
    running. Reverting run_bounded's process-group kill fails the run_bounded
    tests below the same way."""

    def script(self, pidfile: Path) -> list:
        return ["sh", "-c", f'sleep 30 & echo $! > "{pidfile}"; echo started; exec sleep 30']

    def test_plain_communicate_kill_communicate_hangs_past_its_timeout(self) -> None:
        pidfile = self.tmp / "plain.pid"
        done = threading.Event()

        def plain() -> None:
            proc = subprocess.Popen(self.script(pidfile), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                proc.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()  # pysafe(subprocess-no-timeout): planted control, the documented pattern that hangs
            done.set()

        worker = threading.Thread(target=plain, daemon=True)
        worker.start()
        grandchild = read_pid(pidfile)
        self.pids.append(grandchild)
        # timeout=1 elapsed long ago, yet the second communicate() is blocked on the pipe.
        self.assertFalse(done.wait(4.0), "communicate pattern returned; the planted hang did not reproduce")
        os.kill(grandchild, signal.SIGKILL)
        self.assertTrue(done.wait(5.0), "communicate pattern stayed blocked after the grandchild died")
        worker.join(timeout=5.0)

    def test_plain_subprocess_run_timeout_leaves_the_grandchild_running(self) -> None:
        pidfile = self.tmp / "run.pid"
        with self.assertRaises(subprocess.TimeoutExpired):
            subprocess.run(self.script(pidfile), capture_output=True, stdin=subprocess.DEVNULL, timeout=1)  # pysafe(subprocess-orphan): planted control proving the orphaned grandchild
        grandchild = read_pid(pidfile)
        self.pids.append(grandchild)
        time.sleep(0.5)
        self.assertTrue(alive(grandchild), "plain run() killed the grandchild; the planted orphan did not reproduce")

    def test_run_bounded_times_out_and_kills_the_group(self) -> None:
        pidfile = self.tmp / "bounded.pid"
        start = time.monotonic()
        result = pysafe.run_bounded(self.script(pidfile), 1.0, grace=0.5)
        elapsed = time.monotonic() - start
        grandchild = read_pid(pidfile)
        self.pids.append(grandchild)
        self.assertEqual(result.outcome, pysafe.TIMEOUT)
        self.assertLess(elapsed, 4.0, f"run_bounded took {elapsed:.2f}s")
        self.assertEqual(result.stdout, b"started\n")
        self.assertTrue(wait_dead(grandchild), "grandchild survived the process-group kill")

    def test_leader_exit_with_orphan_holding_pipe_returns(self) -> None:
        pidfile = self.tmp / "orphan.pid"
        start = time.monotonic()
        result = pysafe.run_bounded(["sh", "-c", f'sleep 30 & echo $! > "{pidfile}"; echo done'], 10.0, grace=0.5)
        grandchild = read_pid(pidfile)
        self.pids.append(grandchild)
        self.assertEqual((result.outcome, result.returncode, result.stdout), (pysafe.OK, 0, b"done\n"))
        self.assertTrue(result.orphans_killed)
        self.assertLess(time.monotonic() - start, 4.0)
        self.assertTrue(wait_dead(grandchild))

    def test_escaped_grandchild_cannot_hold_the_caller(self) -> None:
        # A grandchild that leaves the group (its own session) survives killpg;
        # the bounded drain still returns instead of waiting for its EOF.
        pidfile = self.tmp / "escaped.pid"
        code = ("import os,subprocess,sys;"
                "p=subprocess.Popen(['sleep','30'],start_new_session=True,stdin=subprocess.DEVNULL);"
                f"open({str(pidfile)!r},'w').write(str(p.pid));print('x',flush=True);os._exit(0)")
        start = time.monotonic()
        result = pysafe.run_bounded([sys.executable, "-c", code], 10.0, grace=0.5)
        self.pids.append(read_pid(pidfile))
        self.assertEqual(result.outcome, pysafe.OK)
        self.assertLess(time.monotonic() - start, 4.0)


class Stdin(Scratch):
    def test_child_stdin_is_devnull_without_input(self) -> None:
        reader, writer = os.pipe()
        code = ("import sys,time;sys.path.insert(0,%r);import pysafe;"
                "t=time.monotonic();r=pysafe.run_bounded(['cat'],5);"
                "print(r.outcome,r.returncode,len(r.stdout),round(time.monotonic()-t,1))") % str(HELPER.parent)
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=reader, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
        try:
            out, err = proc.communicate(timeout=15)
        finally:
            os.close(reader)
            os.close(writer)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        fields = out.decode().split()
        self.assertEqual(fields[:3], ["OK", "0", "0"], err.decode())
        self.assertLess(float(fields[3]), 2.0)

    def test_plain_run_inherits_a_writerless_stdin_and_times_out(self) -> None:
        reader, writer = os.pipe()
        code = ("import subprocess\n"
                "try:\n"
                "    subprocess.run(['cat'], timeout=1)\n"
                "    print('returned')\n"
                "except subprocess.TimeoutExpired:\n"
                "    print('TIMEOUT')\n")
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=reader, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=15)
        finally:
            os.close(reader)
            os.close(writer)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        self.assertEqual(out.decode().strip(), "TIMEOUT")

    def test_input_is_delivered_and_capture_is_capped(self) -> None:
        payload = b"x" * 300_000
        result = pysafe.run_bounded(["cat"], 10.0, input=payload, cap_bytes=1000)
        self.assertEqual((result.outcome, result.returncode), (pysafe.OK, 0))
        self.assertEqual(result.stdout, b"x" * 1000)
        self.assertTrue(result.stdout_truncated)
        full = pysafe.run_bounded(["cat"], 10.0, input=payload, cap_bytes=len(payload))
        self.assertEqual((full.stdout, full.stdout_truncated), (payload, False))

    def test_read_stdin_times_out_on_writerless_pipe(self) -> None:
        reader, writer = os.pipe()
        code = ("import sys;sys.path.insert(0,%r);import pysafe;"
                "o,d,t=pysafe.read_stdin(1.0);print(o,len(d))") % str(HELPER.parent)
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=reader, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
        try:
            os.write(writer, b"abc")
            out, err = proc.communicate(timeout=15)
        finally:
            os.close(reader)
            os.close(writer)
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        self.assertEqual(out.decode().split(), ["TIMEOUT", "3"], err.decode())

    def test_read_stdin_reads_to_eof(self) -> None:
        code = ("import sys;sys.path.insert(0,%r);import pysafe;"
                "o,d,t=pysafe.read_stdin(5.0, cap_bytes=4);print(o,d.decode(),t)") % str(HELPER.parent)
        result = pysafe.run_bounded([sys.executable, "-c", code], 15.0, input=b"hello")
        self.assertEqual(result.text().split(), ["OK", "hell", "True"], result.text("stderr"))


class Output(Scratch):
    def test_flood_is_capped_and_drained(self) -> None:
        code = "import sys\nfor _ in range(200):\n    sys.stdout.write('y'*65536)\n"
        result = pysafe.run_bounded([sys.executable, "-c", code], 30.0, cap_bytes=4096)
        self.assertEqual((result.outcome, result.returncode, len(result.stdout)), (pysafe.OK, 0, 4096))
        self.assertTrue(result.stdout_truncated)

    def test_stderr_separate_and_merged(self) -> None:
        argv = ["sh", "-c", "echo out; echo err >&2; exit 3"]
        split = pysafe.run_bounded(argv, 5.0)
        self.assertEqual((split.returncode, split.stdout, split.stderr), (3, b"out\n", b"err\n"))
        self.assertFalse(split.ok)
        merged = pysafe.run_bounded(argv, 5.0, merge_stderr=True)
        self.assertEqual(sorted(merged.stdout.split()), [b"err", b"out"])

    def test_rejects_shell_strings_and_bad_budgets(self) -> None:
        with self.assertRaises(TypeError):
            pysafe.run_bounded("echo hi", 1.0)
        for bad in (0, -1, float("inf"), float("nan"), True):
            with self.assertRaises(ValueError):
                pysafe.run_bounded(["true"], bad)

    def test_read_capped(self) -> None:
        self.assertEqual(pysafe.read_capped(io.BytesIO(b"abcdef"), 4), (b"abcd", True))
        self.assertEqual(pysafe.read_capped(io.BytesIO(b"abc"), 4), (b"abc", False))


class Cancellation(Scratch):
    def test_sigterm_kills_children_runs_cleanups_and_exits_143(self) -> None:
        pidfile = self.tmp / "child.pid"
        marker = self.tmp / "released"
        code = (
            "import sys,pathlib;sys.path.insert(0,%r);import pysafe\n"
            "def main():\n"
            "    with pysafe.cancel_on_signals() as cleanups:\n"
            "        cleanups.append(lambda: pathlib.Path(%r).write_text('lock released'))\n"
            "        pysafe.run_bounded(['sh','-c','echo $$ > %s; exec sleep 30'], 60)\n"
            "pysafe.run_main(main)\n"
        ) % (str(HELPER.parent), str(marker), str(pidfile))
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        try:
            child = read_pid(pidfile)
            self.pids.append(child)
            start = time.monotonic()
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
            elapsed = time.monotonic() - start
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        self.assertEqual(proc.returncode, 128 + signal.SIGTERM, proc.stderr.read(65536).decode() if proc.stderr else "")
        self.assertLess(elapsed, 5.0)
        self.assertEqual(marker.read_text(), "lock released")
        self.assertTrue(wait_dead(child), "child process group survived cancellation")
        if proc.stderr:
            proc.stderr.close()

    def test_handlers_restored_after_block(self) -> None:
        before = signal.getsignal(signal.SIGTERM)
        with pysafe.cancel_on_signals():
            self.assertIsNot(signal.getsignal(signal.SIGTERM), before)
        self.assertIs(signal.getsignal(signal.SIGTERM), before)


class Cli(Scratch):
    def test_cli_exit_codes(self) -> None:
        timed = pysafe.run_bounded([sys.executable, str(HELPER), "run", "--timeout", "0.5", "--", "sleep", "30"], 15.0)
        self.assertEqual(timed.returncode, 124, timed.text("stderr"))
        self.assertIn("TIMEOUT", timed.text("stderr"))
        passed = pysafe.run_bounded([sys.executable, str(HELPER), "run", "--timeout", "5", "--", "sh", "-c", "echo a; exit 7"], 15.0)
        self.assertEqual((passed.returncode, passed.stdout), (7, b"a\n"))


class Http(Scratch):
    def serve(self, handler) -> int:
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(4)
        server.settimeout(10)
        port = server.getsockname()[1]

        def loop() -> None:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            try:
                conn.settimeout(10)
                handler(conn)
            except OSError:
                pass
            finally:
                conn.close()
                server.close()

        thread = threading.Thread(target=loop, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 15)
        return port

    def test_silent_server_times_out(self) -> None:
        port = self.serve(lambda conn: time.sleep(3))
        start = time.monotonic()
        result = pysafe.urlopen_bounded(f"http://127.0.0.1:{port}/", 1.0)
        self.assertEqual(result.outcome, pysafe.TIMEOUT)
        self.assertLess(time.monotonic() - start, 2.5)

    def test_drip_feed_stops_at_total_deadline(self) -> None:
        def drip(conn) -> None:
            conn.recv(65536)
            conn.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 1000\r\n\r\n")
            for _ in range(40):
                conn.sendall(b"z")
                time.sleep(0.1)

        port = self.serve(drip)
        start = time.monotonic()
        result = pysafe.urlopen_bounded(f"http://127.0.0.1:{port}/", 1.0)
        self.assertEqual(result.outcome, pysafe.TIMEOUT)
        self.assertLess(time.monotonic() - start, 2.5)

    def test_body_capped_and_error_status_returned(self) -> None:
        def big(conn) -> None:
            conn.recv(65536)
            conn.sendall(b"HTTP/1.0 404 Not Found\r\nContent-Length: 50000\r\n\r\n" + b"q" * 50000)

        port = self.serve(big)
        result = pysafe.urlopen_bounded(f"http://127.0.0.1:{port}/", 5.0, cap_bytes=100)
        self.assertEqual((result.outcome, result.status, len(result.body), result.truncated), (pysafe.OK, 404, 100, True))

    def test_refused_connection_is_error(self) -> None:
        probe = socket.socket()
        probe.settimeout(1.0)
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        result = pysafe.urlopen_bounded(f"http://127.0.0.1:{port}/", 2.0)
        self.assertEqual(result.outcome, pysafe.ERROR)


if __name__ == "__main__":
    unittest.main()
