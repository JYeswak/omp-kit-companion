#!/usr/bin/env python3
"""kitlib io: the kit's one atomic byte-replacement primitive for Python (ompkit-67i70, KL06).

``atomic_replace_bytes(path, data, mode=, durability=)`` is the Python half of a
two-language contract; ``src/kitlib/io.ts`` ``atomicReplaceBytes`` is the
TypeScript half, and both pass the one conformance corpus
``tests/fixtures/kitlib-io/corpus.json`` (``tests/scripts/kitlib_io_test.py``
and ``tests/cli/kitlib-io.test.ts``).

Steps: a fresh temp ``.<name>.<pid>.<12 hex>.tmp`` is created in the stage dir
(default: the target's own directory) with O_CREAT|O_EXCL|O_NOFOLLOW, mode
0600; it must be a regular file with one link, owned by this user. It is
fchmod'ed to ``mode`` (the umask never decides the result), every byte is
written, and its size is checked. Durability "file" or "full" fsyncs it. The
caller's ``validate`` runs on the complete temp. Just before rename the temp
name must still be the same inode with one link and the target must still be
absent or a regular file. Then rename (``os.replace``); "full" then fsyncs the
target's directory.

Fixed unsafe-path policy, every refusal an ``AtomicReplaceError`` with a ``code``:

- the path must be absolute and normalized, the target absent or a regular
  file (a symlink, directory or device at the path is UNSAFE_PATH; its parent
  must be a directory);
- a stage dir other than the default must be given explicitly, be a real
  directory and sit on the target's filesystem (else EXDEV; there is never a
  copy fallback, and a rename that fails EXDEV is EXDEV too); when
  ``public_root`` names a public deployment tree, the stage (default or
  explicit) must lie outside it (STAGE_IN_PUBLIC_TREE);
- a temp name that already exists is TEMP_EXISTS, or TEMP_SYMLINK when it is a
  symlink; a temp that gained a second link is TEMP_HARDLINKED; a temp name that
  no longer names our inode is TEMP_REPLACED.

Any failure before the rename removes the temp (only when the name still names
our inode), leaves the target untouched and raises with ``published=False``.
Once the rename has happened the new bytes are visible: a directory fsync
failure raises DIR_SYNC_FAILED with ``published=True`` (the old bytes are
gone), and a ``cancel`` set after the rename is not a cancellation: the
requested durability still runs and the result says ``cancelled_after_publish``.
``durable`` is true only for "full" with both syncs done.

Out of scope by contract: serialization (bytes in, bytes out) and transactions.
Atomic replacement is not a multi-writer transaction: read-modify-write needs
the KL08 lock around the read and this call, or a concurrent update is lost.
The primitive installs no atexit or signal handlers and never changes the umask.

Shipped in every kit release as ``<release>/scripts/kitlib_io.py``; consume it
the way ``pysafe.py`` documents (released artifact, never a companion checkout
path).
"""
from __future__ import annotations

import errno
import os
import secrets
import stat
from dataclasses import dataclass
from typing import Callable, FrozenSet, Optional

DURABILITIES = ("none", "file", "full")
BOUNDARIES = ("temp-created", "written", "file-synced", "validated", "renamed", "directory-synced")
# Only owner rwx and group/other read+execute: the primitive never creates a group- or world-writable file.
_MODE_MASK = 0o755
_TEMP_BASE_CHARS = 32


class AtomicReplaceError(OSError):
    """``code``: the refusal; ``published``: the new bytes are already visible at ``path`` (old bytes gone);
    ``errno_name``: the failing system call's errno name, if any; ``temp_left``: a temp cleanup could not remove."""

    def __init__(self, code: str, path: str, published: bool, detail: str, cause: Optional[BaseException] = None):
        super().__init__(f"kitlib-io: {code}: {path}: {detail}")
        self.code = code
        self.path = path
        self.published = published
        self.durable = False
        number = getattr(cause, "errno", None)
        self.errno_name = errno.errorcode.get(number) if isinstance(number, int) else None
        self.temp_left: Optional[str] = None
        self.__cause__ = cause


@dataclass(frozen=True)
class AtomicReplaceResult:
    path: str
    published: bool
    durability: str
    file_synced: bool
    directory_synced: bool
    durable: bool  # True only for durability "full" with both the file and directory fsync done
    cancelled_after_publish: bool


def fsync_directory(path: str) -> None:
    """Persist a directory's entries after a rename (O_DIRECTORY|O_NOFOLLOW, as src/mutations.ts fsyncDirectory)."""
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _lstat(path: str) -> Optional[os.stat_result]:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


class IoOps:
    """File-system operations the primitive uses; the test seam subclasses this to inject faults."""

    def temp_name(self, base: str) -> str:
        return f".{base[:_TEMP_BASE_CHARS]}.{os.getpid()}.{secrets.token_hex(6)}.tmp"

    open = staticmethod(os.open)
    write = staticmethod(os.write)
    fsync = staticmethod(os.fsync)
    fchmod = staticmethod(os.fchmod)
    fstat = staticmethod(os.fstat)
    lstat = staticmethod(_lstat)
    stat = staticmethod(os.stat)
    close = staticmethod(os.close)
    rename = staticmethod(os.replace)
    unlink = staticmethod(os.unlink)
    fsync_directory = staticmethod(fsync_directory)


DEFAULT_OPS = IoOps()


def _normalized_absolute(value: object) -> bool:
    return (isinstance(value, str) and value != "" and "\0" not in value and os.path.isabs(value)
            and os.path.normpath(value) == value and not value.startswith("//"))


def atomic_replace_bytes(path: str, data: bytes, *, mode: int, durability: str,
                         stage_dir: Optional[str] = None, public_root: Optional[str] = None,
                         validate: Optional[Callable[[str], None]] = None, cancel=None,
                         on_boundary: Optional[Callable[[str, str], None]] = None) -> AtomicReplaceResult:
    """Atomically replace (or create) ``path`` with exactly ``data``.

    ``mode``: exact permission bits, a subset of 0o755 (0o600 for a private file). ``durability``:
    "none" (rename only), "file" (fsync the bytes before rename) or "full" (also fsync the directory
    after). ``stage_dir``: an explicitly authorized same-filesystem staging dir. ``public_root``: a public
    deployment tree the stage must lie outside of. ``validate(temp_path)`` runs on the complete temp
    before rename; raising refuses publication. ``cancel``: an object with ``is_set()`` (threading.Event),
    honoured until the rename. Raises ``AtomicReplaceError``; see the module docstring."""
    return atomic_replace_bytes_with(DEFAULT_OPS, frozenset(), path, data, mode=mode, durability=durability,
                                     stage_dir=stage_dir, public_root=public_root, validate=validate,
                                     cancel=cancel, on_boundary=on_boundary)


def _cleanup(ops: IoOps, temp: str, identity: Optional[os.stat_result]) -> Optional[str]:
    """Remove our temp when its name still names our inode; return the temp path when it had to stay."""
    try:
        now = ops.lstat(temp)
    except OSError:
        return temp
    if now is None:
        return None
    if identity is None or now.st_dev != identity.st_dev or now.st_ino != identity.st_ino:
        return temp
    try:
        ops.unlink(temp)
        return None
    except OSError:
        return temp


def atomic_replace_bytes_with(ops: IoOps, bypass: FrozenSet[str], path: str, data: bytes, *, mode: int,
                              durability: str, stage_dir: Optional[str] = None, public_root: Optional[str] = None,
                              validate: Optional[Callable[[str], None]] = None, cancel=None,
                              on_boundary: Optional[Callable[[str, str], None]] = None) -> AtomicReplaceResult:
    """Test seam: ``ops`` injects faults and ``bypass`` disables named detectors, so the conformance tests
    can prove each refusal is load-bearing. Production code calls ``atomic_replace_bytes``."""
    shown = path if isinstance(path, str) else repr(path)

    def refuse(code: str, detail: str, cause: Optional[BaseException] = None, published: bool = False):
        raise AtomicReplaceError(code, shown, published, detail, cause)

    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "geteuid"):
        refuse("UNSUPPORTED_PLATFORM", "atomic replacement needs POSIX O_NOFOLLOW and euid")
    if not _normalized_absolute(path) or os.path.basename(path) == "":
        refuse("UNSAFE_PATH", "path must be absolute and normalized")
    if not isinstance(data, (bytes, bytearray, memoryview)):
        refuse("INVALID_ARGUMENT", "data must be bytes; serialization is the caller's")
    data = bytes(data)
    if isinstance(mode, bool) or not isinstance(mode, int) or mode & ~_MODE_MASK:
        refuse("INVALID_ARGUMENT", f"mode must be an explicit subset of 0o755, got {mode!r}")
    if durability not in DURABILITIES:
        refuse("INVALID_ARGUMENT", f"durability must be one of {', '.join(DURABILITIES)}, got {durability!r}")

    parent = os.path.dirname(path)
    try:
        parent_info = ops.stat(parent)
    except OSError as error:
        refuse("UNSAFE_PATH", "parent directory is missing", error)
    if not stat.S_ISDIR(parent_info.st_mode):
        refuse("UNSAFE_PATH", "parent is not a directory")

    def target_safe() -> None:
        target = ops.lstat(path)
        if target is not None and not stat.S_ISREG(target.st_mode) and "target-check" not in bypass:
            refuse("UNSAFE_PATH", "target exists and is not a regular file")

    target_safe()

    stage = parent
    if stage_dir is not None:
        if not _normalized_absolute(stage_dir):
            refuse("STAGE_UNSAFE", "stage_dir must be absolute and normalized")
        info = ops.lstat(stage_dir)
        if info is None or not stat.S_ISDIR(info.st_mode):
            refuse("STAGE_UNSAFE", "stage_dir must be an existing real directory")
        stage = stage_dir
        if ops.stat(stage).st_dev != parent_info.st_dev and "stage-device" not in bypass:
            refuse("EXDEV", "stage_dir is on another filesystem; refusing rather than copying")
    if public_root is not None:
        if not _normalized_absolute(public_root):
            refuse("INVALID_ARGUMENT", "public_root must be absolute and normalized")
        root, real = os.path.realpath(public_root), os.path.realpath(stage)
        if not os.path.isdir(root) or not os.path.isdir(real):  # realpath(strict=) needs 3.10; the kit runs on 3.9
            refuse("INVALID_ARGUMENT", "public_root or stage cannot be resolved")
        inside = real == root or real.startswith(root if root.endswith(os.sep) else root + os.sep)
        if inside and "stage-public" not in bypass:
            refuse("STAGE_IN_PUBLIC_TREE", f"stage {stage} lies inside public tree {public_root}")

    def check_cancel() -> None:
        if cancel is not None and cancel.is_set() and "cancel-check" not in bypass:
            refuse("CANCELLED", "cancelled before publication")

    check_cancel()

    temp = os.path.join(stage, ops.temp_name(os.path.basename(path)))
    if "temp-fresh" in bypass:
        flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC
    else:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
    try:
        fd: Optional[int] = ops.open(temp, flags, 0o600)
    except OSError as error:
        if error.errno in (errno.EEXIST, errno.ELOOP):
            try:
                existing = ops.lstat(temp)
                link = existing is not None and stat.S_ISLNK(existing.st_mode)
            except OSError:
                link = False
            refuse("TEMP_SYMLINK" if link else "TEMP_EXISTS", f"temp {temp} already exists", error)
        refuse("TEMP_CREATE_FAILED", f"cannot create temp {temp}", error)

    identity: Optional[os.stat_result] = None
    published = "publish-flag" in bypass
    file_synced = False
    try:
        identity = ops.fstat(fd)
        if not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.geteuid():
            refuse("TEMP_UNSAFE", "temp is not a regular file owned by this user")
        if identity.st_nlink != 1 and "temp-nlink" not in bypass:
            refuse("TEMP_HARDLINKED", f"temp has {identity.st_nlink} links")
        ops.fchmod(fd, mode)
        if on_boundary:
            on_boundary("temp-created", temp)
        view = memoryview(data)
        offset = 0
        while offset < len(data):
            try:
                written = ops.write(fd, view[offset:])
            except OSError as error:
                if "write-error" in bypass:
                    break
                refuse("WRITE_FAILED", f"write failed after {offset} of {len(data)} bytes", error)
            if written <= 0:
                if "write-progress" in bypass:
                    break
                refuse("PARTIAL_WRITE", f"write made no progress after {offset} of {len(data)} bytes")
            offset += written
        size = ops.fstat(fd).st_size
        if size != len(data) and "size-check" not in bypass:
            refuse("SIZE_MISMATCH", f"temp holds {size} of {len(data)} bytes")
        if on_boundary:
            on_boundary("written", temp)
        check_cancel()
        if durability != "none":
            try:
                ops.fsync(fd)
            except OSError as error:
                if "file-sync-error" not in bypass:
                    refuse("FILE_SYNC_FAILED", "temp fsync failed", error)
            file_synced = True
            if on_boundary:
                on_boundary("file-synced", temp)
        closing, fd = fd, None
        try:
            ops.close(closing)
        except OSError as error:
            refuse("WRITE_FAILED", "temp close failed", error)
        if validate is not None and "validate" not in bypass:
            try:
                validate(temp)
            except Exception as error:  # the caller's validator may raise anything; it refuses publication
                refuse("VALIDATION_FAILED", "validate refused the staged bytes", error)
        if on_boundary:
            on_boundary("validated", temp)
        check_cancel()
        now = ops.lstat(temp)
        swapped = (now is None or not stat.S_ISREG(now.st_mode) or now.st_dev != identity.st_dev
                   or now.st_ino != identity.st_ino)
        if swapped and "temp-identity" not in bypass:
            refuse("TEMP_REPLACED", "temp name no longer names the staged inode")
        if now is not None and now.st_nlink != 1 and "temp-nlink" not in bypass:
            refuse("TEMP_HARDLINKED", f"temp has {now.st_nlink} links before rename")
        target_safe()
        try:
            ops.rename(temp, path)
        except OSError as error:
            if error.errno == errno.EXDEV:
                refuse("EXDEV", "rename crossed filesystems; refusing rather than copying", error, published)
            refuse("RENAME_FAILED", "rename failed", error, published)
        published = True
    except BaseException as error:
        if fd is not None:
            try:
                ops.close(fd)
            except OSError:
                pass  # the original failure wins
        left = _cleanup(ops, temp, identity)
        if isinstance(error, AtomicReplaceError):
            error.temp_left = left
            raise
        if isinstance(error, Exception):
            wrapped = AtomicReplaceError("WRITE_FAILED", shown, published, "unexpected failure before publication", error)
            wrapped.temp_left = left
            raise wrapped from error
        raise  # KeyboardInterrupt/SystemExit before the rename: nothing was published, the temp is gone

    if on_boundary:
        on_boundary("renamed", temp)
    if cancel is not None and cancel.is_set() and "post-publish-cancel" in bypass:
        refuse("CANCELLED", "cancelled between rename and directory fsync", None, True)
    directory_synced = False
    if durability == "full":
        try:
            ops.fsync_directory(parent)
        except OSError as error:
            if "dir-sync-error" not in bypass:
                refuse("DIR_SYNC_FAILED", "published, but the directory fsync failed: the new bytes are visible and "
                       "not durable", error, True)
        directory_synced = True
        if on_boundary:
            on_boundary("directory-synced", temp)
    return AtomicReplaceResult(path=path, published=True, durability=durability, file_synced=file_synced,
                               directory_synced=directory_synced,
                               durable=durability == "full" and file_synced and directory_synced,
                               cancelled_after_publish=cancel is not None and cancel.is_set())
