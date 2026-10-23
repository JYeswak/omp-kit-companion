#!/usr/bin/env python3
"""kitlib proc: process incarnation and typed liveness evidence (ompkit-5m6ej, KL09).

The liveness half of PIDIDENT1 (ompkit-a0vy1, J-2026-10-21-08: "a pid mismatch
can never cause us another problem"). A bare pid is not an owner: pids are
reused, and ``kill(pid, 0)`` reports zombies alive. An owner is an incarnation
``{"pid", "start"}``, where ``start`` is the process start time from
``ps -o lstart=`` (LC_ALL=C), whitespace-collapsed so the string is stable.

``probe_incarnation()`` returns ``{"state", "evidence"}`` with state one of
``live`` (runs, not Z, recorded start), ``zombie`` (ps state Z), ``reused``
(runs with a different start), ``dead`` (ps does not list it and signal 0 says
ESRCH) or ``unknown`` (unreadable; never dead). ``is_dead()`` is true only for
dead, reused and zombie.

Observation only: no authority, no side effects; the only signal ever sent is
signal 0. POSIX only (macOS, Linux). ``src/kitlib/proc.ts`` is the TypeScript
twin; both pass ``tests/fixtures/kitlib-proc/corpus.json``. ps runs through
the sibling ``kitlib_run`` (bounded, no raw subprocess).
"""
from __future__ import annotations

import os
import sys
from typing import Callable, NamedTuple, Optional

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_run  # noqa: E402  (the bounded-run primitive; one implementation)

PID_MAX = 0x7FFFFFFF
STATES = ("live", "zombie", "reused", "dead", "unknown")
_PS_ENV = {"LC_ALL": "C", "PATH": "/usr/bin:/bin"}


class PsRead(NamedTuple):
    """One ps read; ``rc`` None or ``timed_out`` True means unreadable."""

    rc: Optional[int]
    timed_out: bool
    stdout: str


def _posix_only() -> None:
    if sys.platform not in ("darwin", "linux"):
        raise OSError(f"kitlib proc needs POSIX ps; {sys.platform} is unsupported")


def _check_pid(pid) -> int:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1 or pid > PID_MAX:
        raise TypeError(f"pid must be an integer in 1..{PID_MAX}, got {pid!r}")
    return pid


def normalize_start(start: str) -> str:
    """Collapses whitespace runs so ``Mon Oct  5 ...`` equals ``Mon Oct 5 ...``."""
    return " ".join(start.split())


def _default_ps(pid: int) -> PsRead:
    try:
        result = kitlib_run.run(["ps", "-o", "stat=", "-o", "lstart=", "-p", str(pid)],
                                deadline_s=10, max_output_bytes=4096, env=_PS_ENV)
    except OSError:
        return PsRead(None, False, "")
    return PsRead(result.rc, result.timed_out, result.stdout.decode("utf-8", "replace"))


def _parse_ps(read: PsRead):
    """("listed", (stat, start)) | ("absent", None) | ("unreadable", why)."""
    if read.timed_out or read.rc is None:
        return "unreadable", "ps timed out" if read.timed_out else "ps did not run"
    lines = [line.strip() for line in read.stdout.split("\n") if line.strip()]
    if read.rc != 0:
        if read.rc == 1 and not lines:
            return "absent", None
        return "unreadable", f"ps exited {read.rc}"
    if len(lines) != 1:
        return ("absent", None) if not lines else ("unreadable", f"ps printed {len(lines)} rows")
    fields = lines[0].split()
    if len(fields) != 6:
        return "unreadable", "ps row is not STAT plus lstart"
    return "listed", (fields[0], " ".join(fields[1:]))


def _signal0(pid: int) -> str:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "esrch"
    except PermissionError:
        return "eperm"
    except OSError:
        return "error"
    return "alive"


def incarnation(pid: int, *, ps: Optional[Callable[[int], PsRead]] = None) -> Optional[dict]:
    """``{"pid", "start"}`` for the process now holding ``pid``, or None when not listed or unreadable."""
    _posix_only()
    _check_pid(pid)
    kind, value = _parse_ps((ps or _default_ps)(pid))
    return {"pid": pid, "start": value[1]} if kind == "listed" else None


def probe_incarnation(recorded: dict, *, ps: Optional[Callable[[int], PsRead]] = None,
                      detect_zombie: bool = True, detect_reuse: bool = True) -> dict:
    """Classify a recorded incarnation. ``ps``/``detect_*`` are the test seam."""
    _posix_only()
    if not isinstance(recorded, dict):
        raise TypeError("probe_incarnation takes {'pid', 'start'}")
    pid = _check_pid(recorded.get("pid"))
    start = recorded.get("start")
    if not isinstance(start, str) or not normalize_start(start):
        raise TypeError("start must be a non-empty process start string")
    recorded_start = normalize_start(start)
    evidence = {"pid": pid, "recorded_start": recorded_start, "observed_start": None,
                "stat": None, "signal0": None, "reason": ""}

    def decide(state: str, reason: str) -> dict:
        return {"state": state, "evidence": dict(evidence, reason=reason)}

    kind, value = _parse_ps((ps or _default_ps)(pid))
    if kind == "unreadable":
        return decide("unknown", value)
    if kind == "absent":
        sig = _signal0(pid)
        evidence["signal0"] = None if sig == "error" else sig
        if sig == "esrch":
            return decide("dead", "ps does not list the pid and signal 0 says ESRCH")
        return decide("unknown", f"ps does not list the pid but signal 0 says {sig}")
    stat, observed = value
    evidence["observed_start"] = observed
    evidence["stat"] = stat
    if detect_zombie and stat.startswith("Z"):
        return decide("zombie", "ps state Z: exited, not reaped")
    if detect_reuse and observed != recorded_start:
        return decide("reused", "pid runs with a different start time")
    return decide("live", "pid runs with the recorded start time")


def is_dead(probe) -> bool:
    """True only for dead, reused and zombie; unknown is never dead."""
    state = probe if isinstance(probe, str) else probe["state"]
    return state in ("dead", "reused", "zombie")
