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


class Corpus(unittest.TestCase):
    def _run_case(self, case: dict) -> None:
        marker = f"kitlib-run-py-{os.getpid()}-{secrets.token_hex(6)}"
        with owned_tmp("kitlib-run") as scratch:
            tmp = os.path.realpath(scratch)
            argv = substitute(case["argv"], marker, tmp)
            options = substitute(case["options"], marker, tmp)
            expect = substitute(case["expect"], marker, tmp)
            if isinstance(options.get("stdin"), str):
                options["stdin"] = options["stdin"].encode("utf-8")
            try:
                if expect.get("throws"):
                    with self.assertRaises((OSError, ValueError, TypeError)):
                        kitlib_run.run(argv, **options)
                    return
                rss_before = peak_rss_bytes()
                result = kitlib_run.run(argv, **options)
                rss_growth = peak_rss_bytes() - rss_before
                self._judge(result, expect, rss_growth, marker)
            finally:
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
