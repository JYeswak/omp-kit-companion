#!/usr/bin/env python3
"""kitlib run: the kit's one bounded-run primitive for Python (ompkit-hsfyp, KITLIB-RUN).

J-2026-10-21-17: deadlines, cancellation and memory bounds belong in the
script, not in a call-site ``timeout N``. ``run()`` is the Python half of a
two-language contract; ``src/kitlib/run.ts`` is the TypeScript half, and both
pass the one conformance corpus ``tests/fixtures/kitlib-run/corpus.json``
(``tests/scripts/kitlib_run_test.py`` and ``tests/cli/kitlib-run.test.ts``).

The process mechanics are ``pysafe.run_bounded`` (one implementation, not a
second copy): the child leads a new session (its own process group), stdin is
``/dev/null`` unless bytes are supplied, stdout and stderr are read here under
one deadline with at most ``max_output_bytes`` kept per stream (the rest is
read and discarded so the child never blocks on a full pipe), and at the
deadline the whole group gets SIGTERM, ``grace_s`` seconds, then SIGKILL; the
leader is always reaped. When the leader exits first, group members still
holding the pipes past ``grace_s`` are killed (``killed``), and any member left
after that is swept, so no descendant in the group outlives the call. Only the
group this call created is ever signalled; nothing is found by name.

Optional POSIX resource limits apply to the child (and its descendants) via a
``/bin/sh`` ``ulimit`` prologue that then ``exec``s argv: ``rlimit_cpu_s``
(RLIMIT_CPU, seconds) and ``rlimit_as_bytes`` (RLIMIT_AS, rounded up to KiB).
A limit the platform refuses (macOS cannot lower RLIMIT_AS) fails closed:
the child exits 126 with ``kitlib-run: cannot apply ...`` on stderr and argv
never runs.

Shipped in every kit release as ``<release>/scripts/kitlib_run.py`` beside
``pysafe.py``; consume it the way ``pysafe.py`` documents (released artifact,
never a companion checkout path).
"""
from __future__ import annotations

import math
import os
import sys
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence, Union

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import pysafe  # noqa: E402  (the process-group mechanics; one implementation)

DEFAULT_GRACE_S = 2.0
DEFAULT_MAX_OUTPUT_BYTES = 1 << 20

# $1 = CPU seconds or "-", $2 = address-space KiB or "-", then argv. Mirrors RLIMIT_PROLOGUE in src/kitlib/run.ts.
RLIMIT_PROLOGUE = (
    'cpu=$1; as=$2; shift 2; '
    'if [ "$cpu" != - ]; then ulimit -t "$cpu" || { printf "kitlib-run: cannot apply RLIMIT_CPU=%s\\n" "$cpu" >&2; exit 126; }; fi; '
    'if [ "$as" != - ]; then ulimit -v "$as" || { printf "kitlib-run: cannot apply RLIMIT_AS=%sKiB\\n" "$as" >&2; exit 126; }; fi; '
    'exec "$@"'
)


@dataclass(frozen=True)
class RunResult:
    """``rc``: exit status, ``-signum`` when a signal ended the leader, None if it was not reaped.
    ``killed``: the group was signalled (deadline, or descendants held the pipes past grace).
    ``truncated``: either stream exceeded ``max_output_bytes`` (the cap is per stream)."""

    rc: Optional[int]
    timed_out: bool
    killed: bool
    stdout: bytes
    stderr: bytes
    truncated: bool
    elapsed_s: float


def _limit(name: str, value: Optional[float]) -> str:
    if value is None:
        return "-"
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number, got {value!r}")
    return str(math.ceil(value))


def run(
    argv: Sequence[Union[str, os.PathLike]],
    *,
    deadline_s: float,
    grace_s: float = DEFAULT_GRACE_S,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    stdin: Optional[bytes] = None,
    cwd: Optional[Union[str, os.PathLike]] = None,
    env: Optional[Mapping[str, str]] = None,
    rlimit_cpu_s: Optional[float] = None,
    rlimit_as_bytes: Optional[int] = None,
) -> RunResult:
    """Run ``argv`` (a sequence, never a shell string) under its own deadline,
    process-group cancel and output cap. ``env`` replaces the environment when
    given. Raises ``ValueError``/``TypeError`` for invalid bounds and ``OSError``
    when the executable cannot be spawned; a deadline is a result, never raised."""
    if isinstance(argv, (str, bytes)):
        raise TypeError("kitlib run takes an argv sequence, never a shell string")
    args = [os.fspath(item) for item in argv]
    cpu = _limit("rlimit_cpu_s", rlimit_cpu_s)
    address_kib = _limit("rlimit_as_bytes", None if rlimit_as_bytes is None else rlimit_as_bytes / 1024)
    if args and (cpu != "-" or address_kib != "-"):
        args = ["/bin/sh", "-c", RLIMIT_PROLOGUE, "kitlib-run", cpu, address_kib, *args]
    result = pysafe.run_bounded(args, deadline_s, input=stdin, cap_bytes=max_output_bytes,
                                cwd=cwd, env=None if env is None else dict(env), grace=grace_s)
    timed_out = result.outcome == pysafe.TIMEOUT
    return RunResult(
        rc=result.returncode,
        timed_out=timed_out,
        killed=timed_out or result.orphans_killed,
        stdout=result.stdout,
        stderr=result.stderr,
        truncated=result.stdout_truncated or result.stderr_truncated,
        elapsed_s=result.elapsed,
    )
