#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_proc.py (ompkit-5m6ej, KL09).

Every case comes from tests/fixtures/kitlib-proc/corpus.json, the same corpus
tests/cli/kitlib-proc.test.ts runs against src/kitlib/proc.ts. Subjects are
real processes this test forks and tears down; the zombie is a forked child
that exits and is deliberately left unreaped until teardown.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = json.loads((ROOT / "tests" / "fixtures" / "kitlib-proc" / "corpus.json").read_text("utf-8"))
BY_ID = {case["id"]: case for case in CORPUS["cases"]}


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kitlib_proc = _load("kitlib_proc", ROOT / "scripts" / "kitlib_proc.py")


def _fork_sleeper() -> int:
    pid = os.fork()
    if pid == 0:
        try:
            time.sleep(30)
        finally:
            os._exit(0)
    return pid


def _reap(pid: int, budget_s: float = 5.0) -> None:
    """SIGKILL then reap ``pid`` with a bounded WNOHANG poll (real clock: the OS reaps on its own schedule)."""
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    end = time.monotonic() + budget_s
    while True:
        try:
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
                return
        except ChildProcessError:
            return
        if time.monotonic() >= end:
            raise AssertionError(f"child {pid} not reaped within {budget_s}s")
        time.sleep(0.02)


def _start_of(pid: int) -> str:
    seen = kitlib_proc.incarnation(pid)
    if seen is None:
        raise AssertionError(f"no incarnation for running pid {pid}")
    return seen["start"]


def _subject(kind: str):
    """(pid, start, teardown) for a live, dead (reaped) or zombie (unreaped) child."""
    pid = _fork_sleeper()
    start = _start_of(pid)
    if kind == "live":
        return pid, start, lambda: _reap(pid)
    if kind == "dead":
        _reap(pid)
        return pid, start, lambda: None
    os.kill(pid, signal.SIGKILL)
    # zombie: killed, not reaped. Real-clock poll: the OS marks it Z on its own schedule.
    for _ in range(60):
        stat = kitlib_proc.probe_incarnation({"pid": pid, "start": start})["evidence"]["stat"]
        if stat is not None and stat.startswith("Z"):
            break
        time.sleep(0.05)
    return pid, start, lambda: _reap(pid)


def _unreadable(_pid: int):
    return kitlib_proc.PsRead(None, True, "")


def probe_case(case: dict, **seam) -> dict:
    if case["subject"] == "unreadable":
        return kitlib_proc.probe_incarnation({"pid": os.getpid(), "start": CORPUS["wrong_start"]}, ps=_unreadable, **seam)
    pid, start, teardown = _subject(case["subject"])
    try:
        recorded = start if case["recorded"] == "observed" else CORPUS["wrong_start"]
        return kitlib_proc.probe_incarnation({"pid": pid, "start": recorded}, **seam)
    finally:
        teardown()


def passes(case: dict, probe: dict) -> bool:
    return probe["state"] == case["expect"]["state"] and kitlib_proc.is_dead(probe) == case["expect"]["is_dead"]


class Corpus(unittest.TestCase):
    def test_schema(self) -> None:
        self.assertEqual(CORPUS["schema"], "kitlib-proc-corpus.v1")
        self.assertEqual(len(CORPUS["cases"]), 5)

    def test_cases(self) -> None:
        for case in CORPUS["cases"]:
            with self.subTest(case=case["id"]):
                probe = probe_case(case)
                self.assertEqual(probe["state"], case["expect"]["state"], probe)
                self.assertEqual(kitlib_proc.is_dead(probe), case["expect"]["is_dead"])

    def test_planted_negatives(self) -> None:
        for negative in CORPUS["negatives"]:
            with self.subTest(negative=negative["id"]):
                seam = {"detect_zombie": False} if negative["disable"] == "zombie" else {"detect_reuse": False}
                flipped = probe_case(BY_ID[negative["flips"]], **seam)
                self.assertFalse(passes(BY_ID[negative["flips"]], flipped), flipped)
                self.assertFalse(kitlib_proc.is_dead(flipped))
                control = probe_case(BY_ID[negative["control"]], **seam)
                self.assertTrue(passes(BY_ID[negative["control"]], control), control)

    def test_malformed_refused(self) -> None:
        for item in CORPUS["malformed"]:
            with self.subTest(item=item), self.assertRaises(TypeError):
                kitlib_proc.probe_incarnation(item)
        with self.assertRaises(TypeError):
            kitlib_proc.probe_incarnation(None)
        for pid in CORPUS["malformed_pids"]:
            with self.subTest(pid=pid), self.assertRaises(TypeError):
                kitlib_proc.incarnation(pid)

    def test_whitespace_normalized(self) -> None:
        pid, start, teardown = _subject("live")
        try:
            padded = start.replace(" ", "   ", 1)
            self.assertEqual(kitlib_proc.probe_incarnation({"pid": pid, "start": padded})["state"], "live")
        finally:
            teardown()


if __name__ == "__main__":
    unittest.main()
