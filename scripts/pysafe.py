#!/usr/bin/env python3
"""pysafe: cancel-safe, memory-bounded process, HTTP and stdin primitives (stdlib only).

Why this exists (ompkit-xa5s.34, J-2026-10-18-28: "no possibility for it to go
hung"). 2026-10-18: the companion converge lock was held for hours twice (a
``subprocess.run`` with no timeout under a wedged pre-push gate; a ``bun test``
sat at 0 CPU for 32+ minutes with fd 0 a pipe nobody wrote to). The stdlib
bounds are partial. Measured on CPython 3.9 (2026-10-19,
``tests/scripts/pysafe_test.py``): ``subprocess.run(timeout=T)`` kills only
the direct child, so a grandchild keeps running (and holding whatever it
holds) after the call returns; the documented ``communicate(timeout=T)`` ->
``kill()`` -> ``communicate()`` pattern blocks until a grandchild holding the
pipe exits; and a child without ``stdin=`` inherits a possibly writerless
fd 0. ``run_bounded`` starts the child in its own session, gives it
``/dev/null`` as stdin unless input is supplied, reads both pipes itself under
one deadline with a byte cap, and on timeout or cancellation signals the whole
process group (SIGTERM, grace, SIGKILL), then drains for a bounded time and
closes its pipe ends, so no descendant outlives the call or keeps the caller
waiting.

Portability: Python >= 3.9 standard library only; macOS and Linux (POSIX
process groups, ``selectors``). No machine-local tool is required.

Consumption model (sibling-dependency discipline, translated to Python):

* One canonical source: this file in omp-kit-companion ``scripts/``. It is a
  shipped release file (``scripts/package-release.ts``), so every installed kit
  release carries ``<release>/scripts/pysafe.py``.
* Inside omp-kit-companion, scripts import it from their own directory
  (``scripts/``); tests load it by path.
* Outside the companion (omp-kit tracker scripts, ``~/.claude/skills/*/scripts``)
  consume the RELEASED artifact, never the companion checkout: resolve the
  installed launcher and import from its release directory::

      import os, shutil, sys
      _kit = shutil.which("omp-kit")
      if _kit is None:
          raise SystemExit("pysafe: omp-kit is not installed; install a kit release carrying scripts/pysafe.py")
      sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(_kit))), "scripts"))
      import pysafe  # noqa: E402

  A path edge into ``~/Developer/omp-kit-companion`` is the Python analogue of
  a ``[patch]`` override (an unreleased checkout silently substituted for the
  released one) and is not allowed; neither is a vendored copy. When the
  installed release predates this module the import fails with
  ``ModuleNotFoundError``: that is the typed fail-closed outcome, never a stub.
* Commit-time enforcement ships beside it: ``scripts/pysafe_check.py`` (the AST
  checker) and ``scripts/check-staged-pysafe.sh`` (the pre-commit member that
  ``scripts/install-commit-msg-bead.sh`` installs, with these two files copied
  beside it, into a repo's ``hooks.d/pre-commit``).

Cancellation: ``cancel_on_signals()`` turns SIGTERM/SIGINT into a ``Cancelled``
exception in the main thread. Unwinding runs every ``finally``/``with`` exit,
so locks held through context managers are released, every process group
``run_bounded`` still owns is killed, and registered cleanups run LIFO.
``run_main(main)`` wraps a script entry point and exits 128+signum on cancel.

CLI (used by the pre-commit member to supervise the checker)::

    python3 pysafe.py run --timeout SECONDS [--cap BYTES] -- ARGV...

replays the child's captured stdout/stderr and exits with its status, or 124
on timeout (the coreutils ``timeout`` convention).
"""
from __future__ import annotations

import argparse
import math
import os
import selectors
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Iterator, List, Optional, Sequence, Tuple, Union

OK = "OK"
TIMEOUT = "TIMEOUT"
ERROR = "ERROR"

DEFAULT_CAP_BYTES = 1 << 20
DEFAULT_GRACE_S = 2.0
_CHUNK = 65536
_DRAIN_S = 1.0

_groups_lock = threading.Lock()
_live_groups: set = set()


class Cancelled(BaseException):
    """Raised in the main thread by ``cancel_on_signals`` when SIGTERM/SIGINT arrives."""

    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


@dataclass(frozen=True)
class RunResult:
    """Outcome of ``run_bounded``. ``outcome`` is OK or TIMEOUT; never raised as an exception."""

    argv: Tuple[str, ...]
    outcome: str
    returncode: Optional[int]
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool
    elapsed: float
    orphans_killed: bool

    @property
    def ok(self) -> bool:
        return self.outcome == OK and self.returncode == 0

    def text(self, stream: str = "stdout") -> str:
        data = self.stdout if stream == "stdout" else self.stderr
        return data.decode("utf-8", "replace")


@dataclass(frozen=True)
class HttpResult:
    """Outcome of ``urlopen_bounded``: OK (any HTTP status), TIMEOUT, or ERROR (no response)."""

    outcome: str
    status: Optional[int]
    headers: Tuple[Tuple[str, str], ...]
    body: bytes
    truncated: bool
    error: str


def _check_budget(name: str, value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number of seconds, got {value!r}")
    return float(value)


def _register(pgid: int) -> None:
    with _groups_lock:
        _live_groups.add(pgid)


def _unregister(pgid: int) -> None:
    with _groups_lock:
        _live_groups.discard(pgid)


def _signal_group(pgid: int, signum: int) -> bool:
    try:
        os.killpg(pgid, signum)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def kill_live_groups() -> int:
    """SIGKILL every process group ``run_bounded`` currently owns; returns how many were signalled."""
    with _groups_lock:
        groups = list(_live_groups)
    return sum(1 for pgid in groups if _signal_group(pgid, signal.SIGKILL))


def _leader_exited(proc: subprocess.Popen) -> bool:
    """True once the leader has exited. Where ``os.waitid`` exists (Linux) the
    zombie is left unreaped, so its pid (and so the group id) cannot be reused
    before the group is signalled; macOS Python lacks ``waitid`` and reaps."""
    if proc.returncode is not None:
        return True
    waitid = getattr(os, "waitid", None)
    if waitid is not None:
        try:
            info = waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            return proc.poll() is not None
        return info is not None
    return proc.poll() is not None


def _reap(proc: subprocess.Popen, budget: float) -> Optional[int]:
    try:
        return proc.wait(timeout=budget)
    except subprocess.TimeoutExpired:
        return None


class _Pump:
    """Reads stdout/stderr and writes stdin under one selector with per-stream caps."""

    def __init__(self, proc: subprocess.Popen, data: Optional[bytes], cap: int) -> None:
        self.sel = selectors.DefaultSelector()
        self.cap = cap
        self.bufs = {}
        self.truncated = {}
        self.order: List[int] = []
        for stream in (proc.stdout, proc.stderr):
            if stream is None:
                continue
            fd = stream.fileno()
            os.set_blocking(fd, False)
            self.bufs[fd] = bytearray()
            self.truncated[fd] = False
            self.order.append(fd)
            self.sel.register(fd, selectors.EVENT_READ)
        self.readers = len(self.order)
        self.stdin = proc.stdin
        self.data = memoryview(data) if data is not None else None
        self.pos = 0
        if self.stdin is not None:
            os.set_blocking(self.stdin.fileno(), False)
            if not self.data:
                self._close_stdin()
            else:
                self.sel.register(self.stdin.fileno(), selectors.EVENT_WRITE)

    def _close_stdin(self) -> None:
        if self.stdin is None:
            return
        try:
            self.sel.unregister(self.stdin.fileno())
        except (KeyError, ValueError):
            pass
        try:
            self.stdin.close()
        except OSError:
            pass
        self.stdin = None

    def step(self, wait: float) -> None:
        if not self.sel.get_map():
            time.sleep(min(wait, 0.05))
            return
        for key, _ in self.sel.select(max(0.0, wait)):
            fd = key.fd
            if self.stdin is not None and fd == self.stdin.fileno():
                try:
                    self.pos += os.write(fd, self.data[self.pos:self.pos + _CHUNK])
                except BlockingIOError:
                    continue
                except (BrokenPipeError, OSError):
                    self._close_stdin()
                    continue
                if self.pos >= len(self.data):
                    self._close_stdin()
                continue
            try:
                chunk = os.read(fd, _CHUNK)
            except BlockingIOError:
                continue
            except OSError:
                chunk = b""
            if not chunk:
                self.sel.unregister(fd)
                self.readers -= 1
                continue
            buf = self.bufs[fd]
            room = self.cap - len(buf)
            if room > 0:
                buf += chunk[:room]
            if len(chunk) > room:
                self.truncated[fd] = True

    def drain(self, budget: float) -> None:
        end = time.monotonic() + budget
        while self.readers > 0:
            left = end - time.monotonic()
            if left <= 0:
                return
            self.step(min(left, 0.1))

    def close(self) -> None:
        self._close_stdin()
        self.sel.close()

    def result(self, index: int) -> Tuple[bytes, bool]:
        if index >= len(self.order):
            return b"", False
        fd = self.order[index]
        return bytes(self.bufs[fd]), self.truncated[fd]


def run_bounded(
    argv: Sequence[Union[str, bytes, os.PathLike]],
    timeout: float,
    *,
    input: Optional[bytes] = None,
    cap_bytes: int = DEFAULT_CAP_BYTES,
    cwd: Optional[Union[str, os.PathLike]] = None,
    env: Optional[dict] = None,
    grace: float = DEFAULT_GRACE_S,
    merge_stderr: bool = False,
) -> RunResult:
    """Run ``argv`` with a hard wall-clock bound and capped capture.

    The child gets a new session (its own process group), stdin ``/dev/null``
    unless ``input`` is given, and stdout/stderr pipes read here with at most
    ``cap_bytes`` kept per stream (the rest is read and discarded, so a chatty
    child never blocks on a full pipe and memory stays bounded). At the
    deadline, or when the caller is cancelled, the group gets SIGTERM, ``grace``
    seconds, then SIGKILL; pipes are drained for at most one more second and
    closed. If the leader exits but group members keep the pipes open past
    ``grace``, they are killed (``orphans_killed``). Returns a ``RunResult``;
    ``outcome`` is TIMEOUT rather than an exception. ``OSError`` from spawning
    (missing executable) propagates.
    """
    if isinstance(argv, (str, bytes)):
        raise TypeError("run_bounded takes an argv sequence, never a shell string")
    args = list(argv)
    if not args:
        raise ValueError("run_bounded needs a non-empty argv")
    budget = _check_budget("timeout", timeout)
    grace = _check_budget("grace", grace)
    if isinstance(cap_bytes, bool) or not isinstance(cap_bytes, int) or cap_bytes < 0:
        raise ValueError(f"cap_bytes must be a non-negative int, got {cap_bytes!r}")
    if input is not None and not isinstance(input, (bytes, bytearray, memoryview)):
        raise TypeError("input must be bytes")
    start = time.monotonic()
    deadline = start + budget
    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
        cwd=cwd,
        env=env,
        start_new_session=True,
        close_fds=True,
    )
    pgid = proc.pid
    _register(pgid)
    pump = _Pump(proc, bytes(input) if input is not None else None, cap_bytes)
    outcome = OK
    orphans = False
    settled = False
    try:
        exited_at = None
        while True:
            now = time.monotonic()
            if now >= deadline:
                outcome = TIMEOUT
                break
            if exited_at is None and _leader_exited(proc):
                exited_at = now
            if exited_at is not None:
                if pump.readers == 0:
                    break
                if now - exited_at >= grace:
                    orphans = _signal_group(pgid, signal.SIGKILL)
                    pump.drain(_DRAIN_S)
                    break
            pump.step(min(deadline - now, 0.1))
        if outcome == TIMEOUT:
            _signal_group(pgid, signal.SIGTERM)
            end = time.monotonic() + grace
            while time.monotonic() < end and not _leader_exited(proc):
                pump.step(min(end - time.monotonic(), 0.1))
            _signal_group(pgid, signal.SIGKILL)
            pump.drain(_DRAIN_S)
        returncode = _reap(proc, grace)
        settled = True
    finally:
        if not settled:
            # Cancelled (or any other exception) mid-run: the group dies first.
            _signal_group(pgid, signal.SIGKILL)
            _reap(proc, grace)
        pump.close()
        for stream in (proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        _unregister(pgid)
    out, out_trunc = pump.result(0)
    err, err_trunc = pump.result(1)
    return RunResult(tuple(os.fsdecode(a) for a in args), outcome, returncode, out, err,
                     out_trunc, err_trunc, time.monotonic() - start, orphans)


def read_capped(stream, cap_bytes: int, deadline: Optional[float] = None) -> Tuple[bytes, bool]:
    """Read a binary file-like object in chunks, keeping at most ``cap_bytes``.

    Returns ``(data, truncated)``; stops reading once the cap is exceeded.
    ``deadline`` (a ``time.monotonic()`` value) stops between chunks; it bounds
    total time only when each ``read`` is itself bounded (a socket timeout).
    ``read1`` is preferred where the object has it, so a slow sender returns
    each chunk as it arrives instead of blocking until a full chunk.
    """
    reader = getattr(stream, "read1", None) or stream.read
    buf = bytearray()
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("read_capped: deadline reached")
        chunk = reader(min(_CHUNK, cap_bytes + 1 - len(buf)))
        if not chunk:
            return bytes(buf), False
        buf += chunk
        if len(buf) > cap_bytes:
            return bytes(buf[:cap_bytes]), True


def urlopen_bounded(url, timeout: float, cap_bytes: int = DEFAULT_CAP_BYTES, *,
                    data: Optional[bytes] = None) -> HttpResult:
    """``urllib.request.urlopen`` with a socket timeout, a total deadline between
    reads, and a body cap. HTTP error statuses are responses (outcome OK);
    timeouts are TIMEOUT; connection failures are ERROR. Worst-case overrun of
    the total deadline is one socket timeout (a single slow ``read``)."""
    budget = _check_budget("timeout", timeout)
    deadline = time.monotonic() + budget
    try:
        response = urllib.request.urlopen(url, data=data, timeout=budget)
    except urllib.error.HTTPError as exc:
        response = exc
    except (socket.timeout, TimeoutError):
        return HttpResult(TIMEOUT, None, (), b"", False, "connect timed out")
    except (urllib.error.URLError, OSError) as exc:
        return HttpResult(ERROR, None, (), b"", False, str(getattr(exc, "reason", exc)))
    try:
        status = getattr(response, "status", None) or response.getcode()
        headers = tuple(response.headers.items()) if response.headers is not None else ()
        try:
            body, truncated = read_capped(response, cap_bytes, deadline)
        except (socket.timeout, TimeoutError):
            return HttpResult(TIMEOUT, status, headers, b"", False, "read timed out")
        return HttpResult(OK, status, headers, body, truncated, "")
    finally:
        response.close()


def read_stdin(timeout: float, cap_bytes: int = DEFAULT_CAP_BYTES) -> Tuple[str, bytes, bool]:
    """Read stdin to EOF under a deadline and a byte cap.

    Returns ``(outcome, data, truncated)``: OK at EOF, TIMEOUT when the writer
    neither writes nor closes in time (the 2026-10-18 gate wedge: fd 0 a pipe
    nobody wrote to). A terminal is never read: it returns ``(OK, b"", False)``,
    so an unattended script cannot wait on a human.
    """
    budget = _check_budget("timeout", timeout)
    fd = sys.stdin.fileno()
    if os.isatty(fd):
        return OK, b"", False
    deadline = time.monotonic() + budget
    buf = bytearray()
    truncated = False
    with selectors.DefaultSelector() as sel:
        sel.register(fd, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return TIMEOUT, bytes(buf), truncated
            if not sel.select(min(remaining, 0.25)):
                continue
            chunk = os.read(fd, _CHUNK)
            if not chunk:
                return OK, bytes(buf), truncated
            room = cap_bytes - len(buf)
            if room > 0:
                buf += chunk[:room]
            if len(chunk) > room:
                truncated = True


@contextmanager
def cancel_on_signals(signals: Sequence[int] = (signal.SIGTERM, signal.SIGINT),
                      cleanups: Optional[List[Callable[[], None]]] = None) -> Iterator[List[Callable[[], None]]]:
    """Turn ``signals`` into ``Cancelled`` in the main thread for the block.

    Yields a list; append cleanup callables (for example a lock-file release).
    On any exit from the block, every live ``run_bounded`` group is killed and
    the cleanups run LIFO (each one's exception is suppressed so the rest
    still run), then the previous handlers are restored. Main thread only
    (``signal.signal`` raises ``ValueError`` elsewhere).
    """
    registered: List[Callable[[], None]] = cleanups if cleanups is not None else []
    previous = {}
    fired = []

    def handler(signum, _frame):
        if fired:
            return
        fired.append(signum)
        raise Cancelled(signum)

    for signum in signals:
        previous[signum] = signal.signal(signum, handler)
    try:
        yield registered
    finally:
        try:
            kill_live_groups()
            while registered:
                callback = registered.pop()
                try:
                    callback()
                except Exception:  # noqa: BLE001 - every cleanup must get its turn
                    pass
        finally:
            for signum, old in previous.items():
                signal.signal(signum, old)


def run_main(main: Callable[[], Optional[int]]) -> None:
    """Script entry point: run ``main`` under ``cancel_on_signals`` and exit with
    its status, or 128+signum when cancelled."""
    try:
        with cancel_on_signals():
            code = main()
    except Cancelled as exc:
        sys.exit(128 + exc.signum)
    sys.exit(code or 0)


def _cli(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="pysafe.py", description="Run a command under run_bounded.")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run ARGV with a process-group deadline; exit 124 on timeout")
    run.add_argument("--timeout", type=float, required=True)
    run.add_argument("--cap", type=int, default=DEFAULT_CAP_BYTES)
    run.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = list(args.argv)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("run needs an argv after --")
    result = run_bounded(command, args.timeout, cap_bytes=args.cap)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    if result.stdout_truncated or result.stderr_truncated:
        sys.stderr.write(f"pysafe: output truncated at {args.cap} bytes per stream\n")
    if result.outcome == TIMEOUT:
        sys.stderr.write(f"pysafe: TIMEOUT after {args.timeout:g}s: {' '.join(result.argv)}\n")
        return 124
    return result.returncode if result.returncode is not None else 125


if __name__ == "__main__":
    run_main(lambda: _cli())
