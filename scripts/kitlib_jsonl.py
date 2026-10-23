#!/usr/bin/env python3
"""kitlib jsonl: the kit's one locked, complete-write JSONL append and bounded reader for Python (ompkit-ibgvg, KL11).

``append_jsonl()`` / ``read_jsonl()`` are the Python half of a two-language
contract; ``src/kitlib/jsonl.ts`` ``appendJsonl()`` / ``readJsonl()`` is the
TypeScript half, and both pass the one conformance corpus
``tests/fixtures/kitlib-jsonl/corpus.json`` (``tests/scripts/kitlib_jsonl_test.py``,
``tests/cli/kitlib-jsonl.test.ts``). Both serialize through the KL08
``private_lock`` on ``{"namespace": "kitlib-jsonl", "path": path}``, so a
Python and a TypeScript writer exclude each other.

Append, in order, all under the lock:
1. the target (absolute, normalized) is opened O_APPEND|O_NOFOLLOW; a new file
   is created O_EXCL and fchmod'ed to ``mode`` (a subset of 0o644, default
   0o600); an existing file's mode is left alone; a symlink or non-regular
   file is UNSAFE_PATH;
2. the tail is checked: a non-empty file whose last byte is not "\\n" has a
   torn last line. ``torn_tail`` "refuse" (default) refuses TORN_TAIL with
   evidence; "newline" prepends "\\n" so the new record starts on its own line
   and the torn bytes stay as evidence. Nothing is truncated or repaired;
   repair policy belongs to the owning ledger;
3. ``build(state)`` returns the record; domain validation and idempotency live
   there. A raise is BUILD_FAILED and nothing is written. The record is
   serialized compactly (``separators=(",", ":")``, ``ensure_ascii=False``,
   ``allow_nan=False``); a value that does not serialize is INVALID_RECORD;
4. the path must still name the opened inode, else INODE_REPLACED;
5. the whole line is written with a complete-write loop; no progress is
   NO_PROGRESS, an errno WRITE_FAILED (``written`` in evidence);
6. ``durable`` fsyncs; a failure is SYNC_FAILED, and ``durable`` is reported
   true only after the sync returned.
A lock timeout is the KL08 ``PrivateLockError`` with code DEADLINE, unchanged.

``read_jsonl(path, max_bytes, from_cursor)`` returns ``rows``, ``errors``
(line, offset, reason, excerpt; never hidden), ``cursor``, ``more``,
``pending_tail_bytes``, ``reset`` ("rotated" | "truncated" | None) and
``missing``, with the TypeScript semantics.

POSIX only. Shipped beside ``kitlib_lock.py``; consume it as ``pysafe.py`` documents.
"""
from __future__ import annotations

import errno
import json
import os
import stat
import sys
from typing import Any, Callable, Dict, Mapping, Optional

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_lock  # noqa: E402  (the KL08 private lock; one implementation)

TORN_TAIL_POLICIES = ("refuse", "newline")
DEFAULT_MAX_BYTES = 16 * 1024 * 1024
_MODE_MASK = 0o644
_TAIL_EVIDENCE_BYTES = 64
_EXCERPT_CHARS = 120

# Test-only seam: plants and detector bypasses for the conformance corpus. Production code never sets it.
_TESTING: Dict[str, Any] = {"disabled": set(), "write": None, "fsync": None, "before_write": None}


class JsonlError(Exception):
    """A refusal: ``.code`` (INVALID_ARGUMENT, UNSAFE_PATH, TORN_TAIL, BUILD_FAILED, INVALID_RECORD, INODE_REPLACED,
    NO_PROGRESS, WRITE_FAILED, SYNC_FAILED, IO_ERROR) and ``.evidence``."""

    def __init__(self, evidence: Dict[str, Any]) -> None:
        super().__init__(f"kitlib-jsonl: {evidence['code']} {evidence['path']}")
        self.code = evidence["code"]
        self.evidence = evidence


def _on(detector: str) -> bool:
    return detector not in _TESTING["disabled"]


def _errno_name(error: OSError) -> str:
    return errno.errorcode.get(error.errno or 0, str(error))


def _check_path(path: Any) -> str:
    if not isinstance(path, str) or "\0" in path or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise JsonlError({"code": "UNSAFE_PATH", "path": str(path), "reason": "path must be absolute and normalized"})
    return path


def _open_target(path: str, mode: int):
    base = os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW
    created = False
    try:
        fd = os.open(path, base | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
    except FileExistsError:
        try:
            fd = os.open(path, base)
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.EISDIR):
                raise JsonlError({"code": "UNSAFE_PATH", "path": path,
                                  "reason": "symlink" if error.errno == errno.ELOOP else "not a regular file"}) from error
            raise JsonlError({"code": "IO_ERROR", "path": path, "step": "open", "errno": _errno_name(error)}) from error
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise JsonlError({"code": "UNSAFE_PATH", "path": path, "reason": "symlink"}) from error
        raise JsonlError({"code": "IO_ERROR", "path": path, "step": "create", "errno": _errno_name(error)}) from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise JsonlError({"code": "UNSAFE_PATH", "path": path, "reason": "not a regular file"})
        if created:
            os.fchmod(fd, mode)
    except BaseException:
        os.close(fd)
        raise
    return fd, created


def _pread_all(fd: int, length: int, offset: int) -> bytes:
    chunks = []
    got = 0
    while got < length:
        chunk = os.pread(fd, length - got, offset + got)
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def append_jsonl(path: str, build: Callable[[Dict[str, Any]], Any], *, deadline_s: float, torn_tail: str = "refuse",
                 durable: bool = False, mode: int = 0o600, state_dir: Optional[str] = None) -> Dict[str, Any]:
    """Append one record as a complete line under the KL08 lock; see the module docstring."""
    if not callable(build):
        raise JsonlError({"code": "INVALID_ARGUMENT", "path": str(path), "reason": "build must be callable"})
    if torn_tail not in TORN_TAIL_POLICIES:
        raise JsonlError({"code": "INVALID_ARGUMENT", "path": str(path),
                          "reason": f"torn_tail must be one of {', '.join(TORN_TAIL_POLICIES)}"})
    if not isinstance(durable, bool):
        raise JsonlError({"code": "INVALID_ARGUMENT", "path": str(path), "reason": "durable must be a boolean"})
    if isinstance(mode, bool) or not isinstance(mode, int) or mode & ~_MODE_MASK:
        raise JsonlError({"code": "INVALID_ARGUMENT", "path": str(path), "reason": "mode must be a subset of 0o644"})
    _check_path(path)

    with kitlib_lock.private_lock({"namespace": "kitlib-jsonl", "path": path}, deadline_s=deadline_s,
                                  state_dir=state_dir) as lock:
        fd, created = _open_target(path, mode)
        try:
            opened = os.fstat(fd)
            size = opened.st_size
            tail = _pread_all(fd, min(size, _TAIL_EVIDENCE_BYTES), size - min(size, _TAIL_EVIDENCE_BYTES)) if size else b""
            torn = bool(tail) and not tail.endswith(b"\n")
            if torn and torn_tail == "refuse" and _on("torn-tail"):
                raise JsonlError({"code": "TORN_TAIL", "path": path, "size": size,
                                  "tail": tail.decode("utf-8", "replace"), "tail_bytes": len(tail)})
            prefix = torn and torn_tail == "newline"

            try:
                record = build({"path": path, "size": size, "created": created, "torn": torn})
            except Exception as error:  # the caller's validation refused: nothing is written
                if _on("build"):
                    raise JsonlError({"code": "BUILD_FAILED", "path": path, "message": str(error)}) from error
                record = None
            try:
                text = json.dumps(record, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
            except (TypeError, ValueError) as error:
                raise JsonlError({"code": "INVALID_RECORD", "path": path, "message": str(error)}) from error
            line = (("\n" if prefix else "") + text + "\n").encode("utf-8")

            before_write = _TESTING["before_write"]
            if before_write is not None:
                before_write(path)
            try:
                now: Optional[os.stat_result] = os.lstat(path)
            except OSError:
                now = None
            if (now is None or (now.st_dev, now.st_ino) != (opened.st_dev, opened.st_ino)) and _on("inode"):
                raise JsonlError({"code": "INODE_REPLACED", "path": path, "dev": opened.st_dev, "ino": opened.st_ino,
                                  "now_ino": None if now is None else now.st_ino})

            offset = os.fstat(fd).st_size
            write = _TESTING["write"] or (lambda f, data: os.write(f, data))
            view = memoryview(line)
            written = 0
            while written < len(line):
                try:
                    count = write(fd, view[written:])
                except OSError as error:
                    raise JsonlError({"code": "WRITE_FAILED", "path": path, "errno": _errno_name(error),
                                      "written": written, "bytes": len(line)}) from error
                if count <= 0:
                    if _on("progress"):
                        raise JsonlError({"code": "NO_PROGRESS", "path": path, "written": written, "bytes": len(line)})
                    break
                written += count

            synced = False
            if durable:
                try:
                    (_TESTING["fsync"] or os.fsync)(fd)
                    synced = True
                except OSError as error:
                    if _on("sync"):
                        raise JsonlError({"code": "SYNC_FAILED", "path": path, "errno": _errno_name(error),
                                          "written": written, "durable": False}) from error
                    synced = True
            return {"path": path, "offset": offset, "bytes": written, "created": created, "torn_prefixed": prefix,
                    "durable": synced, "waited_s": lock.waited_s}
        finally:
            os.close(fd)


def read_jsonl(path: str, max_bytes: int = DEFAULT_MAX_BYTES,
               from_cursor: Optional[Mapping[str, int]] = None) -> Dict[str, Any]:
    """Read complete JSONL lines from a cursor, bounded by ``max_bytes``; see the module docstring."""
    _check_path(path)
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
        raise JsonlError({"code": "INVALID_ARGUMENT", "path": path, "reason": "max_bytes must be a positive integer"})
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {"rows": [], "errors": [], "cursor": None, "reset": None if from_cursor is None else "rotated",
                "more": False, "pending_tail_bytes": 0, "missing": True}
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise JsonlError({"code": "UNSAFE_PATH", "path": path, "reason": "symlink"}) from error
        raise JsonlError({"code": "IO_ERROR", "path": path, "step": "open", "errno": _errno_name(error)}) from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise JsonlError({"code": "UNSAFE_PATH", "path": path, "reason": "not a regular file"})
        offset, line, reset = 0, 0, None
        if from_cursor is not None:
            if (from_cursor["dev"], from_cursor["ino"]) != (info.st_dev, info.st_ino):
                reset = "rotated"
            elif from_cursor["offset"] > info.st_size:
                reset = "truncated"
            else:
                offset, line = from_cursor["offset"], from_cursor["line"]
        window = _pread_all(fd, min(max_bytes, info.st_size - offset), offset)
        rows, errors = [], []
        start = 0
        for raw in window.split(b"\n")[:-1]:  # complete lines only; the last part is the unterminated tail
            line += 1
            at, start = offset + start, start + len(raw) + 1
            if not raw:
                errors.append({"line": line, "offset": at, "reason": "BLANK_LINE", "excerpt": ""})
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                errors.append({"line": line, "offset": at, "reason": "INVALID_UTF8",
                               "excerpt": raw.decode("utf-8", "replace")[:_EXCERPT_CHARS]})
                continue
            if not text.strip():
                errors.append({"line": line, "offset": at, "reason": "BLANK_LINE", "excerpt": text[:_EXCERPT_CHARS]})
                continue
            try:
                rows.append(json.loads(text))
            except ValueError:
                errors.append({"line": line, "offset": at, "reason": "INVALID_JSON", "excerpt": text[:_EXCERPT_CHARS]})
        consumed = offset + start
        remaining = info.st_size - consumed
        window_full = len(window) == max_bytes and offset + len(window) < info.st_size
        if start == 0 and len(window) == max_bytes and remaining > 0:
            errors.append({"line": line + 1, "offset": consumed, "reason": "LINE_EXCEEDS_MAX_BYTES",
                           "excerpt": window.decode("utf-8", "replace")[:_EXCERPT_CHARS]})
        return {"rows": rows, "errors": errors,
                "cursor": {"dev": info.st_dev, "ino": info.st_ino, "offset": consumed, "line": line},
                "reset": reset, "more": window_full, "pending_tail_bytes": 0 if window_full else remaining,
                "missing": False}
    finally:
        os.close(fd)
