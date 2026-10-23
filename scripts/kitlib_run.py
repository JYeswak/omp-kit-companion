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

import collections
import math
import os
import sys
import threading
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence, Union

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import pysafe  # noqa: E402  (the process-group mechanics; one implementation)

DEFAULT_GRACE_S = 2.0
DEFAULT_MAX_OUTPUT_BYTES = 1 << 20
DEFAULT_MAX_SINK_QUEUE_BYTES = 1 << 20
STREAMS = ("stdout", "stderr")
_SINK_POLL_S = 0.5

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
    ``truncated``: a stream lost bytes to ``max_output_bytes`` (per stream) or ``max_total_bytes``.
    ``total_truncated``: the per-stream captures together exceeded ``max_total_bytes``.
    ``captured_bytes``: bytes kept in ``stdout`` + ``stderr``. ``streamed_bytes``: bytes
    ``on_output`` accepted; ``stream_dropped_bytes``: bytes read but never delivered to it
    (queue overflow, sink failure, or still queued when the flush bound ended).
    ``sink_error``: ``repr`` of the first exception ``on_output`` raised, else None."""

    rc: Optional[int]
    timed_out: bool
    killed: bool
    stdout: bytes
    stderr: bytes
    truncated: bool
    elapsed_s: float
    total_truncated: bool = False
    captured_bytes: int = 0
    streamed_bytes: int = 0
    stream_dropped_bytes: int = 0
    sink_error: Optional[str] = None


def _limit(name: str, value: Optional[float]) -> str:
    if value is None:
        return "-"
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number, got {value!r}")
    return str(math.ceil(value))


def _byte_count(name: str, value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative int, got {value!r}")
    return value


class _Sink:
    """Delivers chunks to ``on_output`` on its own thread through a queue of at most
    ``limit`` bytes. ``offer`` runs inside pysafe's one drain loop and never blocks:
    a chunk that does not fit is dropped and counted, so a stalled sink can neither
    stall the drain nor grow memory past ``limit``. The first exception stops delivery."""

    def __init__(self, on_output: Callable[[str, bytes], object], limit: int) -> None:
        self.on_output = on_output
        self.limit = limit
        self.queue: collections.deque = collections.deque()
        self.queued = 0
        self.streamed = 0
        self.dropped = 0
        self.error: Optional[str] = None
        self.closed = False
        self.abandoned = False
        self.cond = threading.Condition()
        self.thread = threading.Thread(target=self._deliver, name="kitlib-run-sink", daemon=True)
        self.thread.start()

    def offer(self, index: int, chunk: bytes) -> None:
        with self.cond:
            if self.error is not None or self.closed or self.queued + len(chunk) > self.limit:
                self.dropped += len(chunk)
                return
            self.queue.append((STREAMS[index], chunk))
            self.queued += len(chunk)
            self.cond.notify()

    def _deliver(self) -> None:
        # Lives until finish() abandons it (bounded by the run plus grace_s); the wait
        # re-checks every _SINK_POLL_S so an abandoned thread never lingers idle.
        while not self.abandoned:
            with self.cond:
                while not self.queue and not self.closed and not self.abandoned:
                    self.cond.wait(_SINK_POLL_S)
                if not self.queue or self.abandoned:
                    return
                stream, chunk = self.queue.popleft()
            try:
                self.on_output(stream, chunk)
            except BaseException as error:  # reported in the result, never raised into the drain
                with self.cond:
                    if not self.abandoned:
                        self.error = repr(error)
                        self.queued -= len(chunk)
                        self.dropped += len(chunk)
                return
            with self.cond:
                if self.abandoned:
                    return  # finish() already counted this chunk as dropped
                self.queued -= len(chunk)
                self.streamed += len(chunk)

    def finish(self, budget: float) -> None:
        """Flush for at most ``budget`` s; whatever was not delivered by then (including a
        chunk still inside a stalled ``on_output`` call) counts as dropped."""
        with self.cond:
            self.closed = True
            self.cond.notify()
        self.thread.join(budget)
        with self.cond:
            self.abandoned = True
            self.dropped += self.queued
            self.queue.clear()
            self.queued = 0


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
    inherit_fds: Sequence[int] = (),
    on_output: Optional[Callable[[str, bytes], object]] = None,
    max_total_bytes: Optional[int] = None,
    max_sink_queue_bytes: int = DEFAULT_MAX_SINK_QUEUE_BYTES,
) -> RunResult:
    """Run ``argv`` (a sequence, never a shell string) under its own deadline,
    process-group cancel and output cap. ``env`` replaces the environment when
    given. Raises ``ValueError``/``TypeError`` for invalid bounds and ``OSError``
    when the executable cannot be spawned (or an ``inherit_fds`` entry is closed);
    a deadline is a result, never raised.

    ``inherit_fds``: explicit allowlist of open descriptors (each >= 3) the child
    inherits at the same number; none by default, and no other descriptor reaches it.
    ``on_output(stream, chunk)``: live raw bytes (``"stdout"``/``"stderr"``) while the
    child runs, beside the bounded capture; see ``_Sink`` for the drop policy. After the
    group is reaped the queue flushes for at most ``grace_s``. ``max_total_bytes``: the
    combined capture budget across both streams (``total_truncated``). Bytes are never
    decoded here; strict UTF-8 is caller policy."""
    if isinstance(argv, (str, bytes)):
        raise TypeError("kitlib run takes an argv sequence, never a shell string")
    args = [os.fspath(item) for item in argv]
    cpu = _limit("rlimit_cpu_s", rlimit_cpu_s)
    address_kib = _limit("rlimit_as_bytes", None if rlimit_as_bytes is None else rlimit_as_bytes / 1024)
    if args and (cpu != "-" or address_kib != "-"):
        args = ["/bin/sh", "-c", RLIMIT_PROLOGUE, "kitlib-run", cpu, address_kib, *args]
    if max_total_bytes is not None:
        _byte_count("max_total_bytes", max_total_bytes)
    _byte_count("max_sink_queue_bytes", max_sink_queue_bytes)
    if on_output is not None and not callable(on_output):
        raise TypeError("on_output must be callable")
    read = [0, 0]
    sink = _Sink(on_output, max_sink_queue_bytes) if on_output is not None else None

    def on_chunk(index: int, chunk: bytes) -> None:
        read[index] += len(chunk)
        if sink is not None:
            sink.offer(index, chunk)

    extra: dict = {}
    if inherit_fds:
        extra["pass_fds"] = tuple(inherit_fds)
    if sink is not None or max_total_bytes is not None:
        extra["on_chunk"] = on_chunk
    if max_total_bytes is not None:
        extra["total_cap"] = max_total_bytes
    try:
        result = pysafe.run_bounded(args, deadline_s, input=stdin, cap_bytes=max_output_bytes,
                                    cwd=cwd, env=None if env is None else dict(env), grace=grace_s, **extra)
    finally:
        if sink is not None:
            sink.finish(grace_s)
    timed_out = result.outcome == pysafe.TIMEOUT
    per_stream = min(read[0], max_output_bytes) + min(read[1], max_output_bytes)
    return RunResult(
        rc=result.returncode,
        timed_out=timed_out,
        killed=timed_out or result.orphans_killed,
        stdout=result.stdout,
        stderr=result.stderr,
        truncated=result.stdout_truncated or result.stderr_truncated,
        elapsed_s=result.elapsed,
        total_truncated=max_total_bytes is not None and per_stream > max_total_bytes,
        captured_bytes=len(result.stdout) + len(result.stderr),
        streamed_bytes=0 if sink is None else sink.streamed,
        stream_dropped_bytes=0 if sink is None else sink.dropped,
        sink_error=None if sink is None else sink.error,
    )
