#!/usr/bin/env python3
"""kitlib tmp: the kit's one owned-temp-dir primitive for Python (ompkit-41l85, KITLIB-TMP v1).

J-2026-10-22-06: 77,299 leaked temp dirs (88 GB) came from kit tests and
scripts that made a temp dir and never removed it, or removed it only on a
normal exit. ``owned_tmp()`` is the Python third of a three-language contract;
``src/kitlib/tmp.ts`` and ``scripts/kitlib-tmp.sh`` are the other two, and all
three pass the one conformance corpus ``tests/fixtures/kitlib-tmp/corpus.json``
(``tests/scripts/kitlib_tmp_test.py``, ``tests/cli/kitlib-tmp.test.ts``).

The dir is ``<root>/<label>.<pid>.<6 random [a-z0-9]>``, mode 0700; ``root``
defaults to ``tempfile.gettempdir()`` (which honours TMPDIR) and must already
exist. Labels match ``^[a-z0-9][a-z0-9-]{0,47}$``. The dir holds a modern
``.owner`` record accepted by ``src/scratch.ts``: ``pid``, ``process_start``,
``label``, ``repo``, ``created_at``, ``argv0`` and, when given, ``bead``.
PID is liveness evidence only; process start disambiguates reuse.
``cleanup()`` removes the tree and is a no-op the second time. If removal
fails (a 0555 dir inside, as installs make ``releases/<v>``), every real dir
inside the owned dir is given owner rwx (symlinks are never followed) and
removal is retried once; ``cleanup()`` raises if that fails too, the registry
hooks never raise. Use it as a
context manager (``with owned_tmp("x") as d:``, ``d`` the path string) or call
``cleanup()``. A per-process registry removes every live dir at ``atexit`` and
on SIGHUP, SIGINT and SIGTERM; after a signal's cleanup the previous Python
handler runs if there was one (SIGINT's default raises KeyboardInterrupt),
otherwise the default action is restored and the signal re-sent, so the
process still dies with it. A signal whose handler was SIG_IGN is left
ignored. Handlers can only be installed from the main thread: a dir made from
another thread before the main thread makes one relies on ``atexit``. A forked
child never removes its parent's dirs. SIGKILL cannot be caught: the dir
survives with its ``.owner``, which is what the reaper reads. A temp FILE goes
inside an owned dir; there is no separate file API.

``auto_cleanup=False`` (ompkit-b3zgu) is for a dir that must outlive the
process: it makes the same dir and ``.owner`` but never enters the registry,
so no atexit or signal hook touches it (none is installed for it);
``cleanup()`` still removes it on demand, and after a crash the scratch
reaper reads its ``.owner`` (dead pid, no open fds) like any other.

Shipped beside ``pysafe.py``; consume it the way ``pysafe.py`` documents
(released artifact, never a companion checkout path).
"""
from __future__ import annotations

import atexit
import datetime
import os
import re
import secrets
import shutil
import signal
import stat
import sys
import tempfile
import threading
from typing import Dict, Optional

from kitlib_proc import incarnation

LABEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
# Same accept set as the owner parser's ``bead`` field (src/scratch.ts AGENT_PATTERN).
_BEAD_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
_CREATE_ATTEMPTS = 16
_HOOKED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)

# Reentrant: the signal handler runs on the main thread and may interrupt a block that already holds it.
_lock = threading.RLock()
_live: Dict[str, int] = {}  # path -> creating pid
_atexit_installed = False
_signals_installed = False
_previous: Dict[int, object] = {}


def _make_dirs_writable(path: str) -> None:
    """Give the owner rwx on ``path`` and every real dir under it; symlinks are never followed or changed."""
    try:
        top = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(top.st_mode):
        return
    os.chmod(path, stat.S_IMODE(top.st_mode) | 0o700)
    for parent, dirnames, _files in os.walk(path, followlinks=False):
        for name in dirnames:
            child = os.path.join(parent, name)
            info = os.lstat(child)
            if stat.S_ISDIR(info.st_mode):
                os.chmod(child, stat.S_IMODE(info.st_mode) | 0o700)


def _remove_tree(path: str) -> None:
    """Remove the tree at ``path``. A tree holding a non-writable dir (an install's 0555 ``releases/<v>``)
    cannot be emptied, so on failure every dir inside is made owner-writable and removal is tried once more."""
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        return
    except OSError:
        _make_dirs_writable(path)
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            return


def cleanup_all_owned_tmp() -> None:
    """Remove every dir this process's ``owned_tmp()`` calls still own; best effort, one failure never stops the rest."""
    with _lock:
        mine = [path for path, pid in list(_live.items()) if pid == os.getpid()]
    for path in mine:
        try:
            _remove_tree(path)
        except OSError:
            continue  # left with its .owner for the reaper
        with _lock:
            _live.pop(path, None)


def _on_signal(signum: int, frame) -> None:
    cleanup_all_owned_tmp()
    previous = _previous.get(signum)
    if callable(previous):
        previous(signum, frame)
        return
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def _install_hooks() -> None:
    global _atexit_installed, _signals_installed
    if not _atexit_installed:
        atexit.register(cleanup_all_owned_tmp)
        _atexit_installed = True
    if _signals_installed or threading.current_thread() is not threading.main_thread():
        return
    for signum in _HOOKED_SIGNALS:
        previous = signal.getsignal(signum)
        if previous == signal.SIG_IGN:
            continue
        _previous[signum] = previous
        signal.signal(signum, _on_signal)
    _signals_installed = True


def _owner_repo() -> str:
    try:
        cwd = os.getcwd()
    except OSError:
        return "/"
    return "/" if any(ch in cwd for ch in "\t\r\n") else cwd


class OwnedTmp:
    """One owned dir: ``.path`` and an idempotent ``.cleanup()``; a context manager yielding the path."""

    def __init__(self, path: str) -> None:
        self.path = path

    def cleanup(self) -> None:
        """Remove the tree (a no-op once gone); raises ``OSError`` if it still cannot be removed."""
        _remove_tree(self.path)
        with _lock:
            _live.pop(self.path, None)

    def __enter__(self) -> str:
        return self.path

    def __exit__(self, *exc) -> None:
        self.cleanup()


def owned_tmp(label: str, root: Optional[str] = None, bead: Optional[str] = None,
              auto_cleanup: bool = True) -> OwnedTmp:
    if not isinstance(label, str) or LABEL_PATTERN.fullmatch(label) is None:
        raise ValueError(f"kitlib tmp: label {label!r} is invalid; want ^[a-z0-9][a-z0-9-]{{0,47}}$")
    if bead is not None and (not isinstance(bead, str) or _BEAD_PATTERN.fullmatch(bead) is None):
        raise ValueError(f"kitlib tmp: bead {bead!r} is invalid; want 1-64 chars of A-Za-z0-9._-")
    base = tempfile.gettempdir() if root is None else root
    if not os.path.isdir(base):
        raise NotADirectoryError(f"kitlib tmp: root {base!r} is not a directory")
    identity = incarnation(os.getpid())
    if identity is None:
        raise RuntimeError("kitlib tmp: process identity unavailable")
    pid = identity["pid"]
    if auto_cleanup:
        _install_hooks()
    for attempt in range(_CREATE_ATTEMPTS):
        suffix = "".join(secrets.choice(_SUFFIX_ALPHABET) for _ in range(6))
        candidate = os.path.join(base, f"{label}.{pid}.{suffix}")
        try:
            os.mkdir(candidate, 0o700)
        except FileExistsError:
            if attempt + 1 >= _CREATE_ATTEMPTS:
                raise
            continue
        path = candidate
        break
    if auto_cleanup:
        with _lock:
            _live[path] = pid
    created_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    argv0 = sys.argv[0] if sys.argv and not any(ch in sys.argv[0] for ch in "\\t\\r\\n") else "unknown"
    lines = [f"pid={pid}", f"process_start={identity['start']}", f"label={label}", f"repo={_owner_repo()}",
             f"created_at={created_at}", f"argv0={argv0}"]
    if bead is not None:
        lines.append(f"bead={bead}")
    try:
        os.chmod(path, 0o700)
        owner = os.path.join(path, ".owner")
        fd = os.open(owner, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        os.chmod(owner, 0o600)
    except BaseException:
        OwnedTmp(path).cleanup()
        raise
    return OwnedTmp(path)
