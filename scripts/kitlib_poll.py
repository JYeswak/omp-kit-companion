#!/usr/bin/env python3
"""kitlib poll: the kit's one bounded condition-polling primitive for Python (ompkit-u6k6t, KL13).

``poll_until(probe, deadline_s=, interval_s=, classify=, cancel=)`` repeats an
owner-supplied observation until the owner's ``classify`` says ``success`` or
``terminal``, the single monotonic budget ``deadline_s`` runs out, or
``cancel`` (a ``threading.Event``) is set. ``src/kitlib/poll.ts`` is the
TypeScript half; both pass ``tests/fixtures/kitlib-poll/corpus.json``.

- One budget: ``deadline_s`` becomes one monotonic deadline exactly once. Probe
  time counts against it; a wall-clock jump neither extends nor shortens it.
- Each attempt gets ``attempt_timeout_s = min(attempt_timeout_s, remaining)``,
  never more than the remaining budget; the probe must honour it. An
  observation arriving after the deadline is recorded, but the outcome is
  ``deadline``, never ``success``.
- No interval sleep after expiry, and no probe after cancellation or after
  ``success``/``terminal``.
- ``probe`` is an explicit owner observation (a GET, a status read, a file
  check), never a replayed mutation: do not submit a job, send mail or re-run
  an accepted write from a probe.
- ``classify`` owns the verdict: domain predicates decide (HTTP 200 with the
  wrong body is ``retry`` or ``terminal``, never ``success`` by status alone).
  ``when_all()`` builds a conjunction classifier and refuses an empty set.
- The returned observation is bounded to ``max_observation_bytes`` of UTF-8
  JSON; a larger one is returned as its truncated JSON text with
  ``observation_truncated=True``.

Shell adapter (same deadline meaning, not the same sleep implementation)::

    python3 -B scripts/kitlib_poll.py --deadline-s N --interval-s M \\
        [--attempt-timeout-s T] [--success-codes 0] [--terminal-codes 3,4] -- <probe argv>

Each attempt runs the probe through ``kitlib_run.run`` bounded by that
attempt's timeout. Exit 0 success, 1 terminal, 124 deadline, 130 cancelled
(SIGINT/SIGTERM; the in-flight probe finishes within its bound, none follows),
2 INVALID_ARGUMENT. One final JSON line on stdout: outcome, attempts,
elapsed_s, observation (rc, timed_out, stdout/stderr tails), observation_truncated.
"""
from __future__ import annotations

import json
import math
import os
import signal as signal_module
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional, Sequence

DEFAULT_MAX_OBSERVATION_BYTES = 4096
VERDICTS = ("success", "terminal", "retry")
DETECTORS = ("probe_time_counts", "monotonic_clock", "empty_conditions", "conjunction", "cancel_check", "stop_on_settle")


class PollError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class ProbeContext:
    attempt: int
    remaining_s: float
    attempt_timeout_s: float
    cancel: Optional[threading.Event]


@dataclass(frozen=True)
class PollResult:
    outcome: str
    observation: Any
    observation_truncated: bool
    attempts: int
    elapsed_s: float


def when_all(success: Sequence[Callable[[Any], bool]], terminal: Sequence[Callable[[Any], bool]] = (),
             *, _bypass: Iterable[str] = ()) -> Callable[[Any], str]:
    """Conjunction classifier: ``terminal`` if any terminal predicate holds, ``success`` if all success predicates hold."""
    off = set(_bypass)
    if not success and "empty_conditions" not in off:
        raise PollError("INVALID_ARGUMENT", "an empty success condition set is refused")
    conjunction = list(success[:1]) if "conjunction" in off else list(success)
    terminal = list(terminal)

    def classify(observation: Any) -> str:
        if any(predicate(observation) for predicate in terminal):
            return "terminal"
        return "success" if all(predicate(observation) for predicate in conjunction) else "retry"
    return classify


def _seconds(name: str, value: Any, allow_zero: bool) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (value == 0 and not allow_zero):
        kind = "non-negative" if allow_zero else "positive"
        raise PollError("INVALID_ARGUMENT", f"{name} must be a {kind} finite number of seconds, got {value!r}")
    return float(value)


def bound_observation(observation: Any, cap: int):
    """Bounds an observation to ``cap`` bytes of UTF-8 JSON, cutting on a character boundary."""
    data = json.dumps(observation, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) <= cap:
        return observation, False
    cut = cap
    while cut > 0 and (data[cut] & 0xC0) == 0x80:
        cut -= 1
    return data[:cut].decode("utf-8"), True


def _default_sleep(seconds: float, cancel: Optional[threading.Event]) -> None:
    if cancel is None:
        time.sleep(seconds)
    else:
        cancel.wait(seconds)


def poll_until(probe: Callable[[ProbeContext], Any], *, deadline_s: float, interval_s: float,
               classify: Callable[[Any], str], cancel: Optional[threading.Event] = None,
               attempt_timeout_s: Optional[float] = None,
               max_observation_bytes: int = DEFAULT_MAX_OBSERVATION_BYTES,
               _seams: Optional[dict] = None) -> PollResult:
    """Poll ``probe`` under one monotonic budget. ``_seams`` is a test seam only:
    ``now``/``wall_now`` (seconds), ``sleep(seconds, cancel)``, ``bypass`` (detector names)."""
    if not callable(probe) or not callable(classify):
        raise PollError("INVALID_ARGUMENT", "probe and classify must be callables")
    deadline = _seconds("deadline_s", deadline_s, False)
    interval = _seconds("interval_s", interval_s, True)
    per_attempt = math.inf if attempt_timeout_s is None else _seconds("attempt_timeout_s", attempt_timeout_s, False)
    if isinstance(max_observation_bytes, bool) or not isinstance(max_observation_bytes, int) or max_observation_bytes < 0:
        raise PollError("INVALID_ARGUMENT", f"max_observation_bytes must be a non-negative integer, got {max_observation_bytes!r}")
    seams = _seams or {}
    off = set(seams.get("bypass", ()))
    now = seams.get("wall_now", time.time) if "monotonic_clock" in off else seams.get("now", time.monotonic)
    sleep = seams.get("sleep", _default_sleep)
    cancelled = (lambda: cancel is not None and cancel.is_set())

    started = now()
    state = {"slept": 0.0, "attempts": 0, "last": None}

    def remaining() -> float:
        spent = state["slept"] if "probe_time_counts" in off else now() - started
        return deadline - spent

    def finish(outcome: str) -> PollResult:
        observation, truncated = (None, False) if state["attempts"] == 0 else bound_observation(state["last"], max_observation_bytes)
        return PollResult(outcome, observation, truncated, state["attempts"], now() - started)

    while True:
        if cancelled() and "cancel_check" not in off:
            return finish("cancelled")
        left = remaining()
        if left <= 0:
            return finish("deadline")
        state["attempts"] += 1
        state["last"] = probe(ProbeContext(state["attempts"], left, min(per_attempt, left), cancel))
        if cancelled():
            return finish("cancelled")
        if remaining() < 0:
            return finish("deadline")
        verdict = classify(state["last"])
        if verdict not in VERDICTS:
            raise PollError("INVALID_ARGUMENT", f"classify returned {verdict!r}, not one of {VERDICTS}")
        if verdict in ("success", "terminal") and "stop_on_settle" not in off:
            return finish(verdict)
        pause = min(interval, remaining())
        if pause <= 0:
            return finish("deadline")
        before = now()
        sleep(pause, cancel)
        state["slept"] += pause if "probe_time_counts" in off else now() - before
        if cancelled() and "cancel_check" not in off:
            return finish("cancelled")


EXIT_CODES = {"success": 0, "terminal": 1, "deadline": 124, "cancelled": 130}
TAIL_BYTES = 1024


def _codes(name: str, text: str) -> frozenset:
    try:
        codes = frozenset(int(item) for item in text.split(",") if item.strip())
    except ValueError:
        raise PollError("INVALID_ARGUMENT", f"{name} must be comma-separated integers, got {text!r}") from None
    return codes


def main(argv: Sequence[str]) -> int:
    import argparse
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import kitlib_run

    parser = argparse.ArgumentParser(prog="kitlib_poll.py", description="Poll a probe argv under one monotonic budget.")
    parser.add_argument("--deadline-s", type=float, required=True)
    parser.add_argument("--interval-s", type=float, required=True)
    parser.add_argument("--attempt-timeout-s", type=float)
    parser.add_argument("--success-codes", default="0")
    parser.add_argument("--terminal-codes", default="")
    parser.add_argument("--max-observation-bytes", type=int, default=DEFAULT_MAX_OBSERVATION_BYTES)
    parser.add_argument("probe", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    probe_argv = args.probe[1:] if args.probe[:1] == ["--"] else args.probe
    try:
        if not probe_argv:
            raise PollError("INVALID_ARGUMENT", "a probe argv after -- is required")
        success = _codes("--success-codes", args.success_codes)
        terminal = _codes("--terminal-codes", args.terminal_codes)
        if success & terminal:
            raise PollError("INVALID_ARGUMENT", f"codes both success and terminal: {sorted(success & terminal)}")
        classify = when_all([lambda obs: not obs["timed_out"] and obs["rc"] in success],
                            [lambda obs: not obs["timed_out"] and obs["rc"] in terminal]) if success else when_all([])

        def probe(context: ProbeContext) -> dict:
            result = kitlib_run.run(probe_argv, deadline_s=context.attempt_timeout_s, max_output_bytes=TAIL_BYTES)
            return {"rc": result.rc, "timed_out": result.timed_out,
                    "stdout": result.stdout.decode("utf-8", "replace"), "stderr": result.stderr.decode("utf-8", "replace")}

        cancel = threading.Event()
        for signum in (signal_module.SIGINT, signal_module.SIGTERM):
            signal_module.signal(signum, lambda *_: cancel.set())
        result = poll_until(probe, deadline_s=args.deadline_s, interval_s=args.interval_s, classify=classify,
                            cancel=cancel, attempt_timeout_s=args.attempt_timeout_s,
                            max_observation_bytes=args.max_observation_bytes)
    except PollError as error:
        print(json.dumps({"outcome": "error", "code": error.code, "message": str(error)}), flush=True)
        return 2
    print(json.dumps({"outcome": result.outcome, "attempts": result.attempts, "elapsed_s": round(result.elapsed_s, 3),
                      "observation": result.observation, "observation_truncated": result.observation_truncated},
                     ensure_ascii=False), flush=True)
    return EXIT_CODES[result.outcome]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
