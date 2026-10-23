#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_run.py (ompkit-hsfyp, KITLIB-RUN).

Every case comes from tests/fixtures/kitlib-run/corpus.json, the same corpus
tests/cli/kitlib-run.test.ts runs against src/kitlib/run.ts, so the two
languages cannot drift. Each case runs real processes; survivors are found by
a marker unique to the case run in their command lines.
"""
from __future__ import annotations

import importlib.util
import json
import os
import resource
import secrets
import signal
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "tests" / "fixtures" / "kitlib-run" / "corpus.json"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pysafe = _load("pysafe", ROOT / "scripts" / "pysafe.py")
kitlib_run = _load("kitlib_run", ROOT / "scripts" / "kitlib_run.py")
owned_tmp = _load("kitlib_tmp", ROOT / "scripts" / "kitlib_tmp.py").owned_tmp


def substitute(value, marker: str, tmp: str):
    if isinstance(value, str):
        return value.replace("{MARKER}", marker).replace("{TMP}", tmp)
    if isinstance(value, list):
        return [substitute(item, marker, tmp) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, marker, tmp) for key, item in value.items()}
    return value


def substitute_token(value, token: str, text: str):
    if isinstance(value, str):
        return value.replace(token, text)
    if isinstance(value, list):
        return [substitute_token(item, token, text) for item in value]
    if isinstance(value, dict):
        return {key: substitute_token(item, token, text) for key, item in value.items()}
    return value


def marker_pids(marker: str) -> list:
    listing = pysafe.run_bounded(["ps", "-A", "-o", "pid=", "-o", "command="], 10, cap_bytes=8 << 20)
    if listing.outcome != pysafe.OK or listing.returncode != 0:
        raise AssertionError(f"ps failed: {listing.outcome} rc={listing.returncode} {listing.text('stderr')}")
    pids = []
    for line in listing.text().splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and marker in fields[1] and int(fields[0]) != os.getpid():
            pids.append(int(fields[0]))
    return pids


def survivors(marker: str, budget: float = 3.0) -> list:
    """Marker holders still present after ``budget`` s (lets a SIGKILLed member finish dying)."""
    end = time.monotonic() + budget
    while True:
        pids = marker_pids(marker)
        if not pids or time.monotonic() >= end:
            return pids
        time.sleep(0.1)


def peak_rss_bytes() -> int:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == "darwin" else peak * 1024


class Recorder:
    """The corpus ``sink`` directives as an ``on_output``: record, stall or throw."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.chunks: list = []
        self.release = threading.Event()

    def __call__(self, stream: str, chunk: bytes) -> None:
        if self.mode == "stall":
            self.release.wait(120)  # set only after run() returns: the delivery never completes during the run
            return
        if self.mode == "throw":
            raise RuntimeError("planted sink failure")
        self.chunks.append((time.monotonic(), stream, bytes(chunk)))

    def joined(self, stream: str) -> bytes:
        return b"".join(chunk for _, name, chunk in self.chunks if name == stream)


class Corpus(unittest.TestCase):
    def _run_case(self, case: dict) -> None:
        marker = f"kitlib-run-py-{os.getpid()}-{secrets.token_hex(6)}"
        opened: list = []
        recorder = Recorder(case["sink"]) if "sink" in case else None
        with owned_tmp("kitlib-run") as scratch:
            tmp = os.path.realpath(scratch)
            try:
                names = {}
                for name in case.get("fds", []):
                    fd = os.open(os.path.join(tmp, name), os.O_RDWR | os.O_CREAT, 0o600)
                    opened.append(fd)
                    names[name] = fd

                def sub(value):
                    value = substitute(value, marker, tmp)
                    for name, fd in names.items():
                        value = substitute_token(value, "{" + f"{name.upper()}FD" + "}", str(fd))
                    return value

                argv = sub(case["argv"])
                options = sub(case["options"])
                expect = sub(case["expect"])
                if isinstance(options.get("stdin"), str):
                    options["stdin"] = options["stdin"].encode("utf-8")
                if "inherit_fds" in options:
                    options["inherit_fds"] = [int(fd) for fd in options["inherit_fds"]]
                if recorder is not None:
                    options["on_output"] = recorder
                if expect.get("throws"):
                    with self.assertRaises((OSError, ValueError, TypeError)):
                        kitlib_run.run(argv, **options)
                    return
                rss_before = peak_rss_bytes()
                result = kitlib_run.run(argv, **options)
                returned_at = time.monotonic()
                rss_growth = peak_rss_bytes() - rss_before
                self._judge(result, expect, rss_growth, marker)
                self._judge_kl02(result, expect, rss_growth, recorder, returned_at)
            finally:
                if recorder is not None:
                    recorder.release.set()
                for fd in opened:
                    os.close(fd)
                for pid in marker_pids(marker):
                    try:
                        os.kill(pid, signal.SIGKILL)  # test hygiene: this case's own marker holders only
                    except ProcessLookupError:
                        pass

    def _judge(self, result, expect: dict, rss_growth: int, marker: str) -> None:
        for key in ("rc", "timed_out", "killed", "truncated"):
            if key in expect:
                self.assertEqual(getattr(result, key), expect[key], f"{key}: {result!r}")
        if "rc_signal" in expect:
            self.assertEqual(result.rc, -int(getattr(signal, expect["rc_signal"])), repr(result))
        for stream in ("stdout", "stderr"):
            if stream in expect:
                self.assertEqual(getattr(result, stream).decode("utf-8", "replace"), expect[stream], repr(result))
        if "stdout_bytes" in expect:
            self.assertEqual(len(result.stdout), expect["stdout_bytes"])
        if "max_elapsed_s" in expect:
            self.assertLess(result.elapsed_s, expect["max_elapsed_s"])
        if "max_parent_rss_growth_bytes" in expect:
            self.assertLess(rss_growth, expect["max_parent_rss_growth_bytes"], f"parent peak RSS grew {rss_growth} bytes")
        if expect.get("no_survivor"):
            self.assertEqual(survivors(marker), [], f"process-group members outlived run(): marker {marker}")

    def _judge_kl02(self, result, expect: dict, rss_growth: int, recorder, returned_at: float) -> None:
        for key in ("total_truncated", "captured_bytes", "streamed_bytes", "stream_dropped_bytes"):
            if key in expect:
                self.assertEqual(getattr(result, key), expect[key], f"{key}: {result!r}"[:2000])
        if "sink_error" in expect:
            self.assertEqual(result.sink_error, expect["sink_error"])
        if "sink_error_contains" in expect:
            self.assertIn(expect["sink_error_contains"], result.sink_error or "")
        if "min_stream_dropped_bytes" in expect:
            self.assertGreaterEqual(result.stream_dropped_bytes, expect["min_stream_dropped_bytes"])
        if "min_parent_rss_growth_bytes" in expect:
            self.assertGreaterEqual(rss_growth, expect["min_parent_rss_growth_bytes"])
        if "stdout_hex" in expect:
            self.assertEqual(result.stdout.hex(), expect["stdout_hex"])
        if "stdout_sorted_lines" in expect:
            self.assertEqual(sorted(result.stdout.decode("utf-8").splitlines()), sorted(expect["stdout_sorted_lines"]))
        for stream in ("stdout", "stderr"):
            if f"streamed_{stream}" in expect:
                self.assertEqual(recorder.joined(stream).decode("utf-8"), expect[f"streamed_{stream}"])
        if "streamed_stdout_hex" in expect:
            self.assertEqual(recorder.joined("stdout").hex(), expect["streamed_stdout_hex"])
        if "first_chunk_lead_s" in expect:
            self.assertTrue(recorder.chunks, "no chunk was streamed")
            self.assertGreaterEqual(returned_at - recorder.chunks[0][0], expect["first_chunk_lead_s"])


def _install_cases() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    if corpus.get("schema") != "kitlib-run-corpus.v1" or not corpus.get("cases"):
        raise AssertionError("tests/fixtures/kitlib-run/corpus.json is not a kitlib-run-corpus.v1 corpus")
    for index, case in enumerate(corpus["cases"]):
        name = f"test_{index:02d}_{case['id'].replace('-', '_')}"
        setattr(Corpus, name, lambda self, case=case: self._run_case(case))


_install_cases()


class Shape(unittest.TestCase):
    def test_shell_string_refused(self) -> None:
        with self.assertRaises(TypeError):
            kitlib_run.run("echo hi", deadline_s=5)

    def test_deadline_is_required(self) -> None:
        with self.assertRaises(TypeError):
            kitlib_run.run(["/bin/sh", "-c", "exit 0"])  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()
