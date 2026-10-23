#!/usr/bin/env python3
"""kitlib lock: the kit's one persistent private resource lock for Python (ompkit-lsn3a, KL08).

``private_lock()`` is the Python half of a two-language contract;
``src/kitlib/lock.ts`` ``privateLock()`` is the TypeScript half, and both pass
the one conformance corpus ``tests/fixtures/kitlib-lock/corpus.json``
(``tests/scripts/kitlib_lock_test.py``, ``tests/cli/kitlib-lock.test.ts``).
The two halves take the same ``flock(2)`` on the same inode, so a Python
holder blocks a TypeScript waiter and the other way round.

The domain names a resource, never a lock path: ``{"namespace", "path"}`` (a
filesystem resource, canonicalised with ``os.path.realpath``, so two aliases
of one file are one key) or ``{"namespace", "name"}`` (an abstract
resource). The lock is the separate, persistent file
``<state>/<namespace>/<sha256(key)>.lock``; ``<state>`` is ``state_dir`` when
given, else ``$XDG_STATE_HOME/omp-kit`` (XDG_STATE_HOME must be absolute) or
``~/.local/state/omp-kit``. The state and namespace dirs are created mode
0700 when missing, and every use validates them and the lock file: a
symlink, a non-directory or non-regular file, another uid, any group/other
mode bit or a second hard link refuses with a typed ``PrivateLockError``. The
lock file is opened O_NOFOLLOW, its inode is compared with the path before
the wait and again after the lock is taken, and a replaced inode refuses: a
lock on an orphaned inode would not exclude waiters on the new one. Nothing
is ever unlinked, renamed or truncated, and neither the file's age nor any
pid in it is read: the kernel releases a flock when the last descriptor
closes, so a dead or zombie holder holds nothing and a live one is never
broken.

The wait polls ``LOCK_EX|LOCK_NB`` against a monotonic deadline
(``deadline_s`` >= 0; 0 is one attempt) and refuses ``DEADLINE`` with
evidence (path, key, deadline, waited, attempts). Any exception raised while
waiting (``pysafe.Cancelled``, KeyboardInterrupt) closes the descriptor
before it propagates; the handle is a context manager that releases on exit.
``inherit`` (default False) sets the descriptor's inheritable flag and reads
it back: True lets a child that keeps descriptors (``close_fds=False``, an
``os.exec*``) hold the lock past the owner's release; False keeps it out of
such children. ``pass_fds`` hands it to one child either way. ``release()``
closes the descriptor (never LOCK_UN, so an intentionally inherited child
keeps its hold) and reports whether the path still names the held inode.

POSIX flock on macOS and Linux only; any other platform refuses
``UNSUPPORTED_PLATFORM`` rather than faking a lock. Limits: the namespace dir
is checked by path (no dir_fd), so a same-uid process can race it; a flock is
advisory and per open file description, so ``os.fork`` without exec shares
it.

Shipped in every kit release as ``<release>/scripts/kitlib_lock.py`` beside
``pysafe.py``; consume it the way ``pysafe.py`` documents (released artifact,
never a companion checkout path).
"""
from __future__ import annotations

import errno
import hashlib
import os
import re
import stat
import sys
import time
from typing import Any, Callable, Dict, Mapping, Optional

try:
    import fcntl
except ImportError:  # not POSIX: every call refuses UNSUPPORTED_PLATFORM
    fcntl = None  # type: ignore[assignment]

NAMESPACE_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}")
_POLL_S = 0.025

# Test-only seam: plants and detector bypasses for the conformance corpus. Production code never sets it.
_TESTING: Dict[str, Any] = {"disabled": set(), "expect_uid": None, "skip_inherit": False, "after_lock": None}


class PrivateLockError(Exception):
    """A refusal: ``.code`` (UNSUPPORTED_PLATFORM, INVALID_STATE_DIR, SYMLINK, NOT_DIRECTORY, NOT_REGULAR,
    FOREIGN_UID, PERMISSIVE_MODE, LINKED, INODE_REPLACED, INHERIT_FAILED, DEADLINE, IO_ERROR) and ``.evidence``."""

    def __init__(self, evidence: Dict[str, Any]) -> None:
        super().__init__(f"kitlib-lock: {evidence['code']} {evidence['path']}")
        self.code = evidence["code"]
        self.evidence = evidence


def _on(detector: str) -> bool:
    return detector not in _TESTING["disabled"]


def _supported() -> bool:
    return fcntl is not None and (sys.platform == "darwin" or sys.platform.startswith("linux"))


def resolve_lock(resource: Mapping[str, Any], state_dir: Optional[str] = None) -> Dict[str, str]:
    """The canonical key, its lock file and its dirs; no filesystem change."""
    if not isinstance(resource, Mapping):
        raise TypeError("kitlib-lock: resource must be {namespace, path} or {namespace, name}")
    namespace, path, name = resource.get("namespace"), resource.get("path"), resource.get("name")
    if not isinstance(namespace, str) or NAMESPACE_PATTERN.fullmatch(namespace) is None:
        raise TypeError(f"kitlib-lock: namespace must match {NAMESPACE_PATTERN.pattern}")
    if (path is None) == (name is None):
        raise TypeError("kitlib-lock: give exactly one of path or name")
    if path is not None:
        if not isinstance(path, str) or not path or "\0" in path:
            raise TypeError("kitlib-lock: a resource path must be a non-empty string without NUL")
        key = os.path.realpath(path)
    elif isinstance(name, str) and NAME_PATTERN.fullmatch(name) is not None:
        key = name
    else:
        raise TypeError(f"kitlib-lock: name must match {NAME_PATTERN.pattern}")
    state = _state_root(state_dir)
    directory = os.path.join(state, namespace)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return {"key": key, "state": state, "dir": directory, "path": os.path.join(directory, f"{digest}.lock")}


def _state_root(state_dir: Optional[str]) -> str:
    if state_dir is not None:
        if not isinstance(state_dir, str) or not state_dir.startswith("/"):
            raise PrivateLockError({"code": "INVALID_STATE_DIR", "path": str(state_dir), "reason": "state_dir must be absolute"})
        return state_dir
    xdg = os.environ.get("XDG_STATE_HOME")
    if xdg:
        if not xdg.startswith("/"):
            raise PrivateLockError({"code": "INVALID_STATE_DIR", "path": xdg, "reason": "XDG_STATE_HOME must be absolute"})
        return os.path.join(xdg, "omp-kit")
    return os.path.join(os.path.expanduser("~"), ".local", "state", "omp-kit")


def _io_error(path: str, error: OSError, step: str) -> PrivateLockError:
    name = errno.errorcode.get(error.errno or 0, str(error))
    return PrivateLockError({"code": "IO_ERROR", "path": path, "step": step, "errno": name})


def _check_owner_mode(path: str, info: os.stat_result, which: str) -> None:
    uid = _TESTING["expect_uid"] if _TESTING["expect_uid"] is not None else os.getuid()
    if info.st_uid != uid and _on("owner"):
        raise PrivateLockError({"code": "FOREIGN_UID", "path": path, "which": which, "uid": info.st_uid, "expected_uid": uid})
    if stat.S_IMODE(info.st_mode) & 0o077 and _on("mode"):
        raise PrivateLockError({"code": "PERMISSIVE_MODE", "path": path, "which": which,
                                "mode": format(stat.S_IMODE(info.st_mode), "04o")})


def _private_dir(path: str, parents: bool) -> None:
    """Refuse a symlink, a non-directory, another uid or any group/other bit; create the dir 0700 when missing."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        try:
            if parents:
                os.makedirs(os.path.dirname(path), exist_ok=True)
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
        except OSError as error:
            raise _io_error(path, error, "mkdir") from error
        try:
            info = os.lstat(path)
        except OSError as error:
            raise _io_error(path, error, "lstat") from error
    except OSError as error:
        raise _io_error(path, error, "lstat") from error
    if stat.S_ISLNK(info.st_mode):
        if _on("symlink"):
            raise PrivateLockError({"code": "SYMLINK", "path": path, "which": "directory"})
        try:
            info = os.stat(path)
        except OSError as error:
            raise _io_error(path, error, "stat") from error
    if not stat.S_ISDIR(info.st_mode) and _on("type"):
        raise PrivateLockError({"code": "NOT_DIRECTORY", "path": path})
    _check_owner_mode(path, info, "directory")


def _same_inode(path: str, held: os.stat_result) -> bool:
    try:
        now = os.lstat(path) if _on("symlink") else os.stat(path)
    except OSError:
        return False
    return (now.st_dev, now.st_ino) == (held.st_dev, held.st_ino)


class PrivateLock:
    """A held lock: ``fd``, ``path``, ``key``, ``dev``, ``ino``, ``waited_s`` and ``release()``; a context manager."""

    def __init__(self, fd: int, path: str, key: str, held: os.stat_result, waited_s: float) -> None:
        self.fd = fd
        self.path = path
        self.key = key
        self.dev = held.st_dev
        self.ino = held.st_ino
        self.waited_s = waited_s
        self._held = held
        self._open = True

    def release(self) -> str:
        """Close the descriptor; RELEASED, INODE_REPLACED (the path no longer names the held inode) or ALREADY_RELEASED."""
        if not self._open:
            return "ALREADY_RELEASED"
        intact = _same_inode(self.path, self._held) or not _on("inode")
        self._open = False
        os.close(self.fd)
        return "RELEASED" if intact else "INODE_REPLACED"

    def __enter__(self) -> "PrivateLock":
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


def private_lock(resource: Mapping[str, Any], *, deadline_s: float, inherit: bool = False,
                 state_dir: Optional[str] = None) -> PrivateLock:
    """Acquire the persistent private lock for ``resource`` within ``deadline_s`` seconds or raise PrivateLockError."""
    if isinstance(deadline_s, bool) or not isinstance(deadline_s, (int, float)) or not deadline_s >= 0 \
            or deadline_s == float("inf"):
        raise TypeError("kitlib-lock: deadline_s must be a finite number >= 0")
    if not isinstance(inherit, bool):
        raise TypeError("kitlib-lock: inherit must be a boolean")
    resolved = resolve_lock(resource, state_dir)
    lock_path = resolved["path"]
    if not _supported():
        raise PrivateLockError({"code": "UNSUPPORTED_PLATFORM", "path": lock_path, "platform": sys.platform})
    _private_dir(resolved["state"], parents=state_dir is None)
    _private_dir(resolved["dir"], parents=False)
    flags = os.O_CREAT | os.O_RDWR | (os.O_NOFOLLOW if _on("symlink") else 0)
    try:
        fd = os.open(lock_path, flags, 0o600)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise PrivateLockError({"code": "SYMLINK", "path": lock_path, "which": "lock-file"}) from error
        raise _io_error(lock_path, error, "open") from error
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) and _on("type"):
            raise PrivateLockError({"code": "NOT_REGULAR", "path": lock_path})
        _check_owner_mode(lock_path, opened, "lock-file")
        if opened.st_nlink != 1 and _on("links"):
            raise PrivateLockError({"code": "LINKED", "path": lock_path, "nlink": opened.st_nlink})
        if not _same_inode(lock_path, opened) and _on("inode"):
            raise PrivateLockError({"code": "INODE_REPLACED", "path": lock_path, "step": "open"})

        started = time.monotonic()
        deadline = started + deadline_s
        attempts = 0
        while True:
            attempts += 1
            try:
                if _on("flock"):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (BlockingIOError, InterruptedError):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PrivateLockError({
                        "code": "DEADLINE", "path": lock_path, "key": resolved["key"],
                        "namespace": resource["namespace"], "deadline_s": deadline_s,
                        "waited_s": time.monotonic() - started, "attempts": attempts,
                    }) from None
                time.sleep(min(_POLL_S, remaining))
            except OSError as error:
                raise _io_error(lock_path, error, "flock") from error
        waited = time.monotonic() - started

        after_lock: Optional[Callable[[str], None]] = _TESTING["after_lock"]
        if after_lock is not None:
            after_lock(lock_path)
        if not _same_inode(lock_path, opened) and _on("inode"):
            raise PrivateLockError({"code": "INODE_REPLACED", "path": lock_path, "step": "locked"})

        if not (inherit and _TESTING["skip_inherit"]):
            os.set_inheritable(fd, inherit)
        if os.get_inheritable(fd) != inherit and _on("inherit"):
            raise PrivateLockError({"code": "INHERIT_FAILED", "path": lock_path, "inherit": inherit,
                                    "cloexec": not os.get_inheritable(fd)})
        return PrivateLock(fd, lock_path, resolved["key"], opened, waited)
    except BaseException:
        os.close(fd)
        raise
