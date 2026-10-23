#!/usr/bin/env python3
"""Conformance tests for scripts/kitlib_poll.py (ompkit-u6k6t, KL13).

Every case comes from tests/fixtures/kitlib-poll/corpus.json, the same corpus
tests/cli/kitlib-poll.test.ts runs against src/kitlib/poll.ts. cases run on a
fake clock through the test seam; cli_cases run the shell adapter with real
probes through kitlib run.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "tests" / "fixtures" / "kitlib-poll" / "corpus.json"
POLL = ROOT / "scripts" / "kitlib_poll.py"
EPS = 1e-6


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kitlib_poll = _load("kitlib_poll", POLL)
kitlib_run = _load("kitlib_run", ROOT / "scripts" / "kitlib_run.py")
owned_tmp = _load("kitlib_tmp", ROOT / "scripts" / "kitlib_tmp.py").owned_tmp


class Corpus(unittest.TestCase):
    def _drive(self, case: dict, bypass: list) -> dict:
        clock = {"mono": 1000.0, "wall": 1_700_000_000.0, "calls": 0}
        cancel = threading.Event()
        options = case["options"]
        script = case["script"]

        def predicate(spec):
            return lambda obs: obs.get(spec["key"], object()) == spec["eq"] and type(obs.get(spec["key"])) is type(spec["eq"])

        def probe(context):
            clock["calls"] += 1
            self.assertEqual(context.attempt, clock["calls"])
            self.assertLessEqual(context.attempt_timeout_s, context.remaining_s + EPS)
            if "attempt_timeout_s" in options:
                self.assertLessEqual(context.attempt_timeout_s, options["attempt_timeout_s"])
            step = script[min(clock["calls"], len(script)) - 1]
            timed_out = step["cost_s"] > context.attempt_timeout_s
            cost = context.attempt_timeout_s if timed_out else step["cost_s"]
            clock["mono"] += cost
            clock["wall"] += cost + step.get("wall_jump_s", 0)
            return {"timed_out": True} if timed_out else step["obs"]

        def sleep(seconds, _cancel):
            if case.get("cancel_in_interval_of") == clock["calls"]:
                clock["mono"] += seconds / 2
                clock["wall"] += seconds / 2
                cancel.set()
                return
            clock["mono"] += seconds
            clock["wall"] += seconds

        try:
            classify = kitlib_poll.when_all([predicate(p) for p in case["success"]],
                                            [predicate(p) for p in case.get("terminal", [])], _bypass=bypass)
            result = kitlib_poll.poll_until(probe, classify=classify, cancel=cancel, **options, _seams={
                "now": lambda: clock["mono"], "wall_now": lambda: clock["wall"], "sleep": sleep, "bypass": bypass})
            return {"result": result, "calls": clock["calls"]}
        except kitlib_poll.PollError as error:
            return {"error": error, "calls": clock["calls"]}

    def _judge(self, label: str, got: dict, want: dict) -> None:
        if "throws" in want:
            self.assertIn("error", got, label)
            self.assertEqual(got["error"].code, want["throws"])
            self.assertEqual(got["calls"], 0, f"{label}: probe ran before refusal")
            return
        self.assertNotIn("error", got, label)
        r = got["result"]
        shown = f"{label}: {r!r}"[:400]
        self.assertEqual(r.attempts, got["calls"], shown)
        if "outcome" in want:
            self.assertEqual(r.outcome, want["outcome"], shown)
        if "attempts" in want:
            self.assertEqual(r.attempts, want["attempts"], shown)
        if "min_attempts" in want:
            self.assertGreaterEqual(r.attempts, want["min_attempts"], shown)
        if "elapsed_s" in want:
            self.assertLess(abs(r.elapsed_s - want["elapsed_s"]), EPS, shown)
        if "observation" in want:
            self.assertEqual(r.observation, want["observation"], shown)
        if "observation_truncated" in want:
            self.assertEqual(r.observation_truncated, want["observation_truncated"], shown)
        if "observation_max_bytes" in want:
            self.assertIsInstance(r.observation, str)
            self.assertLessEqual(len(r.observation.encode("utf-8")), want["observation_max_bytes"])

    def _run_case(self, case: dict) -> None:
        self._judge(case["id"], self._drive(case, []), case["expect"])
        if case.get("bypass"):
            self._judge(f"{case['id']} [bypass {case['bypass']}]", self._drive(case, [case["bypass"]]), case["expect_bypassed"])


class Cli(unittest.TestCase):
    def _run_cli(self, case: dict) -> None:
        with owned_tmp("kitlib-poll") as scratch:
            tmp = os.path.realpath(scratch)
            args = [arg.replace("{TMP}", tmp) for arg in case["args"]]
            result = kitlib_run.run([sys.executable, "-B", str(POLL), *args], deadline_s=30)
            final = json.loads(result.stdout.decode("utf-8").strip().splitlines()[-1])
            want = case["expect"]
            shown = f"{case['id']}: rc={result.rc} {final}"
            self.assertEqual(result.rc, want["exit"], shown)
            for key in ("outcome", "attempts", "code"):
                if key in want:
                    self.assertEqual(final.get(key), want[key], shown)
            if "max_elapsed_s" in want:
                self.assertLess(final["elapsed_s"], want["max_elapsed_s"], shown)
            if "stdout" in want:
                self.assertEqual(final["observation"]["stdout"], want["stdout"], shown)


def _install() -> None:
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    if corpus.get("schema") != "kitlib-poll-corpus.v1" or not corpus.get("cases"):
        raise AssertionError("tests/fixtures/kitlib-poll/corpus.json is not a kitlib-poll-corpus.v1 corpus")
    for index, case in enumerate(corpus["cases"]):
        setattr(Corpus, f"test_{index:02d}_{case['id'].replace('-', '_')}", lambda self, case=case: self._run_case(case))
    for index, case in enumerate(corpus["cli_cases"]):
        setattr(Cli, f"test_{index:02d}_{case['id'].replace('-', '_')}", lambda self, case=case: self._run_cli(case))


_install()


class Shape(unittest.TestCase):
    def test_truncation_cuts_on_character_boundary(self) -> None:
        self.assertEqual(kitlib_poll.bound_observation({"s": "€€€€"}, 9), ('{"s":"€', True))

    def test_real_clock_short_budget_ends_in_deadline(self) -> None:
        started = time.monotonic()
        result = kitlib_poll.poll_until(lambda _ctx: {"ready": False}, deadline_s=0.3, interval_s=0.05,
                                        classify=kitlib_poll.when_all([lambda obs: obs["ready"]]))
        self.assertEqual(result.outcome, "deadline")
        self.assertLess(time.monotonic() - started, 2)

    def test_unknown_verdict_refused(self) -> None:
        with self.assertRaises(kitlib_poll.PollError):
            kitlib_poll.poll_until(lambda _ctx: 1, deadline_s=1, interval_s=0, classify=lambda _obs: "maybe")


if __name__ == "__main__":
    unittest.main()
