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
closes its pipe ends, so members of that owned group cannot keep the caller
waiting. Separately grouped descendants still need their own lifecycle owner.

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
import select
import selectors
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import ExitStack, contextmanager
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
_live_groups: dict = {}


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


def _register(owner: "_ChildOwner") -> None:
    with _groups_lock:
        _live_groups[owner.proc.pid] = owner


def _unregister(owner: "_ChildOwner") -> None:
    with _groups_lock:
        if _live_groups.get(owner.proc.pid) is owner:
            del _live_groups[owner.proc.pid]


def _signal_group(pgid: int, signum: int) -> bool:
    try:
        os.killpg(pgid, signum)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def kill_live_groups() -> int:
    """Signal only still-owned, unreaped child groups."""
    with _groups_lock:
        groups = list(_live_groups.values())
    return sum(1 for owner in groups if owner.signal(signal.SIGKILL))


class _ChildOwner:
    """Keep the child's PID reserved until the final group signal, then reap."""

    def __init__(self, proc: subprocess.Popen) -> None:
        self.proc = proc
        self.unreaped = True
        self._signalable = True
        self._waitid = getattr(os, "waitid", None)
        self._queue = None
        self._watched = False
        self._seen_exit = False
        self.stopping = False
        self._waited = False

    def watch(self) -> None:
        if self._waitid is None:
            self._queue = select.kqueue()
            try:
                self._queue.control([select.kevent(
                    self.proc.pid, filter=select.KQ_FILTER_PROC,
                    flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                    fflags=select.KQ_NOTE_EXIT)], 0, 0)
            except ProcessLookupError:
                # Darwin can reject an already-exited, still-unreaped child.
                # It remains our reserved PID until reap(), not lost ownership.
                self._seen_exit = True
            self._watched = True

    def exited(self) -> bool:
        if self._seen_exit or not self.unreaped:
            return True
        if self._waitid is not None:
            try:
                self._seen_exit = self._waitid(
                    os.P_PID, self.proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
            except ChildProcessError:
                self.unreaped = False
                raise RuntimeError("owned child was reaped outside run_bounded") from None
        elif self._watched:
            self._seen_exit = bool(self._queue.control(None, 1, 0))
        return self._seen_exit

    def signal(self, signum: int) -> bool:
        with _groups_lock:
            return self._signalable and self.unreaped and _signal_group(self.proc.pid, signum)

    def terminate(self, pump: Optional["_Pump"], grace: float) -> None:
        self.stopping = True
        self.signal(signal.SIGTERM)
        end = time.monotonic() + grace
        while time.monotonic() < end and not self.exited():
            left = max(0.0, min(end - time.monotonic(), 0.1))
            if pump is not None:
                pump.step(left)
            else:
                time.sleep(max(0, left))
        self.signal(signal.SIGKILL)
        if pump is not None:
            pump.drain(_DRAIN_S)

    def reap(self, budget: float) -> Optional[int]:
        if not self.unreaped or self._waited:
            return self.proc.returncode
        # Exclude registry cancellation before wait can release the PID. A
        # concurrent signal either finishes while it is reserved, or refuses.
        with _groups_lock:
            self._signalable = False
        try:
            result = self.proc.wait(timeout=budget)
        except subprocess.TimeoutExpired:
            self._waited = True
            return None
        self._waited = True
        self.unreaped = False
        return result

    def close(self) -> None:
        if self._queue is not None:
            self._queue.close()


@contextmanager
def _defer_handled_signals() -> Iterator[None]:
    """Defer Python cancellation through acquisition without masking the child."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)
                if callable(signal.getsignal(sig))}
    pending: dict = {}

    def defer(signum: int, frame: object) -> None:
        pending.setdefault(signum, frame)

    try:
        for sig in handlers:
            signal.signal(sig, defer)
        yield
    finally:
        # Mask only while restoring handlers, after the child has been spawned.
        # A second cancellation cannot strand one temporary handler in place,
        # and no child inherits a blocked TERM/INT mask.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, handlers)
        try:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        for sig, frame in pending.items():
            handlers[sig](sig, frame)


class _Pump:
    """Reads stdout/stderr and writes stdin under one selector with per-stream caps.

    ``total_cap`` (optional) also bounds the bytes kept across both streams;
    ``on_chunk(index, chunk)`` (optional) sees every chunk read, index 0 for
    stdout and 1 for stderr, inline in this one drain. It must not block: a
    caller with a slow consumer queues the chunk and returns."""

    def __init__(self, proc: subprocess.Popen, data: Optional[bytes], cap: int,
                 on_chunk: Optional[Callable[[int, bytes], None]] = None,
                 total_cap: Optional[int] = None) -> None:
        self.sel = selectors.DefaultSelector()
        self.cap = cap
        self.on_chunk = on_chunk
        self.total_cap = total_cap
        self.kept = 0
        self.bufs = {}
        self.truncated = {}
        self.order: List[int] = []
        try:
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
        except BaseException:
            self.sel.close()
            raise

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
            if self.total_cap is not None:
                room = min(room, self.total_cap - self.kept)
            if room > 0:
                buf += chunk[:room]
                self.kept += min(room, len(chunk))
            if len(chunk) > room:
                self.truncated[fd] = True
            if self.on_chunk is not None:
                self.on_chunk(self.order.index(fd), chunk)

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


@contextmanager
def _process_run(
    args: Sequence[Union[str, bytes, os.PathLike]], grace: float,
    data: Optional[bytes], cap_bytes: int,
    on_chunk: Optional[Callable[[int, bytes], None]], total_cap: Optional[int],
    **options: object,
) -> Iterator[Tuple[_ChildOwner, _Pump]]:
    """Acquire and unwind one owned process; no policy or verdict lives here."""
    proc = None
    owner = None
    pump = None
    with ExitStack() as resources:
        try:
            with _defer_handled_signals():
                proc = subprocess.Popen(args, **options)
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream is not None:
                        resources.callback(stream.close)
                owner = _ChildOwner(proc)
                resources.callback(owner.close)
                _register(owner)
                resources.callback(_unregister, owner)
                owner.watch()
                pump = _Pump(proc, data, cap_bytes, on_chunk, total_cap)
                resources.callback(pump.close)
            yield owner, pump
        except BaseException:
            if pump is not None:
                pump.on_chunk = None
            if owner is not None and not owner.stopping:
                owner.terminate(pump, grace)
            elif owner is None and proc is not None:
                _signal_group(proc.pid, signal.SIGTERM)
                time.sleep(grace)
            raise
        finally:
            if owner is not None:
                owner.signal(signal.SIGKILL)
                owner.reap(grace)
            elif proc is not None:
                _signal_group(proc.pid, signal.SIGKILL)
                proc.wait(timeout=grace)


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
    pass_fds: Sequence[int] = (),
    on_chunk: Optional[Callable[[int, bytes], None]] = None,
    total_cap: Optional[int] = None,
) -> RunResult:
    """Run ``argv`` with a hard wall-clock bound and capped capture.

    The child gets a new session (its own process group), stdin ``/dev/null``
    unless ``input`` is given, and stdout/stderr pipes read here with at most
    ``cap_bytes`` kept per stream (the rest is read and discarded, so a chatty
    child never blocks on a full pipe and memory stays bounded). At the
    deadline, or when the caller is cancelled, the group gets SIGTERM, ``grace``
    seconds, then SIGKILL; pipes are drained for at most one more second and
    closed. If the leader exits but group members keep the pipes open past
    ``grace``, they are killed (``orphans_killed``); any member left once the
    leader has exited (one that closed or redirected its pipes) is swept with
    SIGKILL, so no descendant in the group outlives the call. Returns a ``RunResult``;
    ``outcome`` is TIMEOUT rather than an exception. ``OSError`` from spawning
    (missing executable) propagates.

    Optional, all off by default: ``pass_fds`` is an explicit allowlist of
    open descriptors (each >= 3) the child inherits at the same number; every
    other descriptor stays closed (``close_fds``). ``total_cap`` bounds the
    bytes kept across both streams beside the per-stream ``cap_bytes``; a
    stream that loses bytes to it reports truncated. ``on_chunk(index, chunk)``
    sees every chunk read (0 stdout, 1 stderr) inside the one drain loop and
    must not block; an exception from it unwinds like a cancellation (the group
    is killed and reaped first).
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
    if isinstance(pass_fds, (str, bytes)):
        raise TypeError("pass_fds must be a sequence of descriptor numbers")
    fds = tuple(pass_fds)
    for fd in fds:
        if isinstance(fd, bool) or not isinstance(fd, int) or fd < 3:
            raise ValueError(f"pass_fds entries must be ints >= 3, got {fd!r}")
        os.fstat(fd)  # a closed descriptor is refused here (OSError), never silently skipped
    if len(set(fds)) != len(fds):
        raise ValueError(f"pass_fds has duplicates: {fds!r}")
    if total_cap is not None and (isinstance(total_cap, bool) or not isinstance(total_cap, int) or total_cap < 0):
        raise ValueError(f"total_cap must be a non-negative int, got {total_cap!r}")
    if on_chunk is not None and not callable(on_chunk):
        raise TypeError("on_chunk must be callable")
    extra = {"pass_fds": fds} if fds else {}
    start = time.monotonic()
    deadline = start + budget
    outcome = OK
    orphans = False
    with _process_run(
        args, grace, bytes(input) if input is not None else None, cap_bytes, on_chunk, total_cap,
        stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
        cwd=cwd, env=env, start_new_session=True, close_fds=True, **extra,
    ) as (owner, pump):
        exited_at = None
        while True:
            now = time.monotonic()
            if now >= deadline:
                outcome = TIMEOUT
                break
            if exited_at is None and owner.exited():
                exited_at = now
            if exited_at is not None:
                if pump.readers == 0:
                    break
                if now - exited_at >= grace:
                    orphans = owner.signal(signal.SIGKILL)
                    pump.drain(_DRAIN_S)
                    break
            pump.step(min(deadline - now, 0.1))
        if outcome == OK:
            # Even on Darwin the leader remains unreaped until this signal;
            # neither its PID nor this owned group ID can have been reused.
            owner.signal(signal.SIGKILL)
        else:
            owner.terminate(pump, grace)
        returncode = owner.reap(grace)
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
