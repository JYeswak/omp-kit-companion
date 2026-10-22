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
exist. Labels match ``^[a-z0-9][a-z0-9-]{0,47}$``. The dir holds a ``.owner``
(mode 0600) in the key=value owner-record form ``src/scratch.ts``
``parseOwnerFile`` accepts: ``pid``, ``label``, ``repo`` (the working
directory), ``created`` (ISO time) and, when given, ``bead`` -- the
identity-free field set, so no ``ps`` spawn per dir (see src/kitlib/tmp.ts).

``cleanup()`` removes the tree and is a no-op the second time. Use it as a
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
import tempfile
import threading
from typing import Dict, Optional

LABEL_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
# Same accept set as the owner parser's ``bead`` field (src/scratch.ts AGENT_PATTERN).
_BEAD_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
_CREATE_ATTEMPTS = 16
_HOOKED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)

_lock = threading.Lock()
_live: Dict[str, int] = {}  # path -> creating pid
_atexit_installed = False
_signals_installed = False
_previous: Dict[int, object] = {}


def cleanup_all_owned_tmp() -> None:
    """Remove every dir this process's ``owned_tmp()`` calls still own."""
    with _lock:
        mine = [path for path, pid in _live.items() if pid == os.getpid()]
        for path in mine:
            del _live[path]
    for path in mine:
        shutil.rmtree(path, ignore_errors=True)


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
        with _lock:
            _live.pop(self.path, None)
        shutil.rmtree(self.path, ignore_errors=True)

    def __enter__(self) -> str:
        return self.path

    def __exit__(self, *exc) -> None:
        self.cleanup()


def owned_tmp(label: str, root: Optional[str] = None, bead: Optional[str] = None) -> OwnedTmp:
    if not isinstance(label, str) or LABEL_PATTERN.fullmatch(label) is None:
        raise ValueError(f"kitlib tmp: label {label!r} is invalid; want ^[a-z0-9][a-z0-9-]{{0,47}}$")
    if bead is not None and (not isinstance(bead, str) or _BEAD_PATTERN.fullmatch(bead) is None):
        raise ValueError(f"kitlib tmp: bead {bead!r} is invalid; want 1-64 chars of A-Za-z0-9._-")
    base = tempfile.gettempdir() if root is None else root
    if not os.path.isdir(base):
        raise NotADirectoryError(f"kitlib tmp: root {base!r} is not a directory")
    _install_hooks()
    pid = os.getpid()
    path = ""
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
    with _lock:
        _live[path] = pid
    created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    lines = [f"pid={pid}", f"label={label}", f"repo={_owner_repo()}", f"created={created}"]
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
