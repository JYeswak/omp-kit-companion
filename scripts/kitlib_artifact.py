#!/usr/bin/env python3
"""kitlib artifact: the kit's one bounded, strict local artifact reader and strict JSON/JSONL decoder for Python
(ompkit-gvp4j, KL10).

``read_local_artifact()`` / ``strict_json()`` / ``strict_jsonl()`` / ``reject_unknown_fields()`` are the
Python half of a two-language contract; ``src/kitlib/artifact.ts`` ``readLocalArtifact()`` /
``strictJson()`` / ``strictJsonl()`` / ``rejectUnknownFields()`` is the TypeScript half, and both pass the
one conformance corpus ``tests/fixtures/kitlib-artifact/corpus.json``
(``tests/scripts/kitlib_artifact_test.py``, ``tests/cli/kitlib-artifact.test.ts``).

``read_local_artifact(path, allowed_root=, max_bytes=, file_policy=, distinct_from=)`` checks, in order,
before returning any byte (every refusal an ``ArtifactError`` with ``.code`` and ``.evidence``):
URL-like value NOT_A_PATH; not absolute/normalized or lexically outside the root OUTSIDE_ROOT; MISSING;
a symlink SYMLINK unless ``file_policy["symlinks"] == "follow"``; realpath outside realpath(root)
OUTSIDE_ROOT; opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK, not regular NOT_REGULAR (and, with symlinks refused,
an inode other than the one lstat saw is SYMLINK); ``nlink > 1`` HARDLINK unless
``file_policy["hardlinks"] == "allow"``; the same inode as an existing ``distinct_from`` path COLLISION;
the read itself reads at most ``max_bytes + 1`` bytes, more than ``max_bytes`` is TOO_LARGE; zero bytes
EMPTY; a byte count other than fstat's size CORRUPT. MISSING, EMPTY and CORRUPT stay separate. Returns
``{bytes, path, realpath, dev, ino, size, sha256}``.

``strict_json(data, path=)`` uses its own parser: ``json.loads`` accepts NaN/Infinity and keeps the last
duplicate key, so it is never used here. A refusal is CORRUPT with ``path``, ``line``, ``column`` (1-based,
UTF-8 bytes), ``offset`` and ``reason``: INVALID_UTF8, DUPLICATE_KEY, NONFINITE, TRAILING_GARBAGE, DEPTH or
SYNTAX. ``strict_jsonl(data, path=, max_rows=, max_row_bytes=, validate=)`` returns ``{"rows": [{line,
value}], "errors": [...]}`` and never drops a row silently (BLANK_LINE, ROW_TOO_LARGE, TRUNCATED_ROW,
TOO_MANY_ROWS, EMPTY, VALIDATION). Domain validation stays with the owner's ``validate``;
``reject_unknown_fields(row, allowed)`` is the helper it may call.

Out of scope: writers and domain schemas. POSIX only. Shipped beside the other kitlib modules; consume it
as ``pysafe.py`` documents.
"""
from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import stat
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

DEFAULT_MAX_DEPTH = 512
_CHUNK = 64 * 1024

# Test-only seam: detector bypasses for the conformance corpus. Production code never sets it.
_TESTING: Dict[str, Any] = {"disabled": set()}


class ArtifactError(Exception):
    """A refusal: ``.code`` (INVALID_ARGUMENT, NOT_A_PATH, OUTSIDE_ROOT, MISSING, SYMLINK, NOT_REGULAR, HARDLINK,
    COLLISION, TOO_LARGE, EMPTY, CORRUPT, IO_ERROR) and ``.evidence``."""

    def __init__(self, evidence: Dict[str, Any]) -> None:
        reason = f" ({evidence['reason']})" if evidence.get("reason") else ""
        super().__init__(f"kitlib-artifact: {evidence['code']} {evidence['path']}{reason}")
        self.code = evidence["code"]
        self.evidence = evidence


def _on(detector: str) -> bool:
    return detector not in _TESTING["disabled"]


def _errno_name(error: OSError) -> str:
    return errno.errorcode.get(error.errno or 0, str(error))


def is_url_like(value: str) -> bool:
    """``scheme:`` with an RFC 3986 scheme (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )); no regex."""
    text = value.strip()
    if not text or not ("a" <= text[0].lower() <= "z"):
        return False
    for char in text[1:]:
        if char == ":":
            return True
        if not (char.isascii() and (char.isalnum() or char in "+-.")):
            return False
    return False


def _inside(child: str, root: str) -> bool:
    return child == root or child.startswith("/" if root == "/" else root + "/")


def _normalized_absolute(path: str) -> bool:
    return "\0" not in path and os.path.isabs(path) and os.path.normpath(path) == path and not path.startswith("//")


def read_local_artifact(path: str, *, allowed_root: str, max_bytes: int,
                        file_policy: Optional[Dict[str, str]] = None,
                        distinct_from: Sequence[str] = ()) -> Dict[str, Any]:
    """Read one bounded local artifact under the root and file policy; see the module docstring."""
    if not isinstance(path, str):
        raise ArtifactError({"code": "INVALID_ARGUMENT", "path": str(path), "reason": "path must be a string"})
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
        raise ArtifactError({"code": "INVALID_ARGUMENT", "path": path, "reason": "max_bytes must be a positive integer"})
    if not isinstance(allowed_root, str) or not _normalized_absolute(allowed_root):
        raise ArtifactError({"code": "INVALID_ARGUMENT", "path": path, "reason": "allowed_root must be absolute and normalized"})
    policy = file_policy or {}
    symlinks = policy.get("symlinks", "refuse")
    hardlinks = policy.get("hardlinks", "refuse")
    if symlinks not in ("refuse", "follow") or hardlinks not in ("refuse", "allow"):
        raise ArtifactError({"code": "INVALID_ARGUMENT", "path": path, "reason": "file_policy values are refuse/follow and refuse/allow"})
    root_real = os.path.realpath(allowed_root)
    if not os.path.isdir(root_real):
        raise ArtifactError({"code": "INVALID_ARGUMENT", "path": path, "reason": "allowed_root must be an existing directory",
                             "allowed_root": allowed_root})

    if is_url_like(path) and _on("url"):
        raise ArtifactError({"code": "NOT_A_PATH", "path": path, "reason": "URL-like value is not a local path"})
    if not _normalized_absolute(path):
        raise ArtifactError({"code": "OUTSIDE_ROOT", "path": path, "reason": "path must be absolute and normalized"})
    if not _inside(path, allowed_root) and _on("root"):
        raise ArtifactError({"code": "OUTSIDE_ROOT", "path": path, "reason": "path is outside allowed_root",
                             "allowed_root": allowed_root})

    try:
        link = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        raise ArtifactError({"code": "MISSING", "path": path}) from None
    except OSError as error:
        raise ArtifactError({"code": "IO_ERROR", "path": path, "step": "lstat", "errno": _errno_name(error)}) from error
    is_link = stat.S_ISLNK(link.st_mode)
    if is_link and symlinks == "refuse" and _on("symlink"):
        raise ArtifactError({"code": "SYMLINK", "path": path, "reason": "symlink refused by file_policy"})
    real = os.path.realpath(path)
    if not os.path.lexists(real):
        raise ArtifactError({"code": "MISSING", "path": path, "reason": "dangling link"})
    if not _inside(real, root_real) and _on("root"):
        raise ArtifactError({"code": "OUTSIDE_ROOT", "path": path, "realpath": real, "reason": "realpath is outside allowed_root",
                             "allowed_root": root_real})

    try:
        fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except (FileNotFoundError, NotADirectoryError):
        raise ArtifactError({"code": "MISSING", "path": path, "reason": "dangling link or vanished before open"}) from None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ArtifactError({"code": "SYMLINK", "path": path, "reason": "replaced by a symlink before open"}) from error
        raise ArtifactError({"code": "IO_ERROR", "path": path, "step": "open", "errno": _errno_name(error)}) from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) and _on("regular"):
            raise ArtifactError({"code": "NOT_REGULAR", "path": path, "reason": "not a regular file"})
        if (symlinks == "refuse" and not is_link and (info.st_dev, info.st_ino) != (link.st_dev, link.st_ino)
                and _on("symlink")):
            raise ArtifactError({"code": "SYMLINK", "path": path, "reason": "path changed between lstat and open"})
        if info.st_nlink > 1 and hardlinks == "refuse" and _on("hardlink"):
            raise ArtifactError({"code": "HARDLINK", "path": path, "nlink": info.st_nlink})
        for other in distinct_from:
            try:
                seen = os.stat(other)
            except OSError:
                continue
            if (seen.st_dev, seen.st_ino) == (info.st_dev, info.st_ino) and _on("collision"):
                raise ArtifactError({"code": "COLLISION", "path": path, "other": other,
                                     "reason": "artifact is the same inode as a distinct path"})
        limit = max_bytes + 1 if _on("bound") else None
        chunks: List[bytes] = []
        total = 0
        while limit is None or total < limit:
            want = _CHUNK if limit is None else min(_CHUNK, limit - total)
            try:
                chunk = os.pread(fd, want, total)
            except OSError as error:
                raise ArtifactError({"code": "IO_ERROR", "path": path, "step": "read", "errno": _errno_name(error)}) from error
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > max_bytes and _on("bound"):
            raise ArtifactError({"code": "TOO_LARGE", "path": path, "max_bytes": max_bytes, "read_bytes": total})
        if total == 0 and _on("empty"):
            raise ArtifactError({"code": "EMPTY", "path": path})
        if total != info.st_size:
            raise ArtifactError({"code": "CORRUPT", "path": path, "reason": "changed while being read",
                                 "size": info.st_size, "read_bytes": total})
        data = b"".join(chunks)
        return {"bytes": data, "path": path, "realpath": real, "dev": info.st_dev, "ino": info.st_ino, "size": total,
                "sha256": hashlib.sha256(data).hexdigest()}
    finally:
        os.close(fd)


class _Fail(Exception):
    def __init__(self, at: int, reason: str, message: str) -> None:
        super().__init__(message)
        self.at, self.reason, self.message = at, reason, message


_SIMPLE_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
_HEX = "0123456789abcdefABCDEF"
_DIGITS = "0123456789"


class _Parser:
    def __init__(self, text: str, max_depth: int) -> None:
        self.text, self.i, self.max_depth = text, 0, max_depth

    def fail(self, reason: str, message: str, at: Optional[int] = None) -> None:
        raise _Fail(self.i if at is None else at, reason, message)

    def peek(self) -> str:
        return self.text[self.i] if self.i < len(self.text) else ""

    def ws(self) -> None:
        text = self.text
        while self.i < len(text) and text[self.i] in " \t\n\r":
            self.i += 1

    def document(self) -> Any:
        self.ws()
        value = self.value()
        self.ws()
        if self.i < len(self.text) and _on("trailing"):
            self.fail("TRAILING_GARBAGE", "data after the JSON value")
        return value

    def value(self) -> Any:
        """One JSON value. Nesting lives on an explicit stack, never the Python stack, so no input depth can raise
        RecursionError: the max_depth guard is exact (``max_depth`` nested containers parse, one more is DEPTH)."""
        text = self.text
        # Each frame is [container, closer, pending key]; the key is None for arrays.
        stack: List[List[Any]] = []
        while self.i < len(text):  # every pass consumes an opener or a scalar, or fails, so input length bounds it
            char = text[self.i]
            if char in "{[":
                if len(stack) >= self.max_depth:
                    self.fail("DEPTH", f"nesting deeper than {self.max_depth}")
                self.i += 1
                self.ws()
                closer = "}" if char == "{" else "]"
                if self.peek() == closer:
                    self.i += 1
                    result: Any = {} if char == "{" else []
                else:
                    frame: List[Any] = [{} if char == "{" else [], closer, None]
                    stack.append(frame)
                    self.member_start(frame)
                    continue
            else:
                result = self.scalar(char)
            # Attach the finished value to its parent, closing every container that ends here.
            while stack:  # every pass pops a container or breaks after a ','
                frame = stack[-1]
                container, closer = frame[0], frame[1]
                if closer == "}":
                    container[frame[2]] = result
                else:
                    container.append(result)
                self.ws()
                char = self.peek()
                if char == ",":
                    self.i += 1
                    self.member_start(frame)
                    break
                if char == closer:
                    self.i += 1
                    result = stack.pop()[0]
                    continue
                self.fail("SYNTAX", f"expected ',' or '{closer}'")
            else:
                return result
        self.fail("SYNTAX", "unexpected end of input")

    def member_start(self, frame: List[Any]) -> None:
        """Advance to the next member's value: past whitespace, and for an object past its key and ':'."""
        if self.i >= len(self.text):
            self.fail("SYNTAX", "unterminated object" if frame[1] == "}" else "unterminated array")
        self.ws()
        if frame[1] != "}":
            return
        if self.peek() != '"':
            self.fail("SYNTAX", "expected a string key")
        key_at = self.i
        key = self.string()
        if key in frame[0] and _on("duplicate-key"):
            self.fail("DUPLICATE_KEY", f"duplicate key {key!r}", key_at)
        self.ws()
        if self.peek() != ":":
            self.fail("SYNTAX", "expected ':'")
        self.i += 1
        self.ws()
        frame[2] = key

    def scalar(self, char: str) -> Any:
        text = self.text
        if char == '"':
            return self.string()
        for token, value in (("NaN", math.nan), ("Infinity", math.inf), ("-Infinity", -math.inf)):
            if text.startswith(token, self.i):
                if _on("nonfinite"):
                    self.fail("NONFINITE", f"{token} is not JSON")
                self.i += len(token)
                return value
        if char == "-" or char in _DIGITS:
            return self.number()
        for token, value in (("true", True), ("false", False), ("null", None)):
            if text.startswith(token, self.i):
                self.i += len(token)
                return value
        self.fail("SYNTAX", f"unexpected character {char!r}")

    def string(self) -> str:
        text = self.text
        self.i += 1
        parts: List[str] = []
        run = self.i
        while self.i < len(text):  # every pass advances self.i or returns/fails
            char = text[self.i]
            if char == '"':
                parts.append(text[run:self.i])
                self.i += 1
                return _join_surrogates("".join(parts))
            if char < " ":
                self.fail("SYNTAX", "control character in string")
            if char != "\\":
                self.i += 1
                continue
            parts.append(text[run:self.i])
            escape = text[self.i + 1:self.i + 2]
            if escape and escape in _SIMPLE_ESCAPES:
                parts.append(_SIMPLE_ESCAPES[escape])
                self.i += 2
            elif escape == "u":
                digits = text[self.i + 2:self.i + 6]
                if len(digits) != 4 or any(d not in _HEX for d in digits):
                    self.fail("SYNTAX", "bad \\u escape")
                parts.append(chr(int(digits, 16)))
                self.i += 6
            else:
                self.fail("SYNTAX", "bad escape")
            run = self.i
        self.fail("SYNTAX", "unterminated string")

    def number(self) -> Any:
        text = self.text
        start = self.i

        def digit() -> bool:
            return self.i < len(text) and text[self.i] in _DIGITS

        if self.peek() == "-":
            self.i += 1
        if self.peek() == "0":
            self.i += 1
        elif digit():
            while digit():
                self.i += 1
        else:
            self.fail("SYNTAX", "bad number")
        is_float = False
        if self.peek() == ".":
            is_float = True
            self.i += 1
            if not digit():
                self.fail("SYNTAX", "bad number")
            while digit():
                self.i += 1
        if self.peek() in ("e", "E"):
            is_float = True
            self.i += 1
            if self.peek() in ("+", "-"):
                self.i += 1
            if not digit():
                self.fail("SYNTAX", "bad number")
            while digit():
                self.i += 1
        token = text[start:self.i]
        value: Any = float(token) if is_float else int(token)
        finite = math.isfinite(value) if is_float else _int_fits_double(value)
        if not finite and _on("nonfinite"):
            self.fail("NONFINITE", "number overflows to a non-finite value", start)
        return value


def _int_fits_double(value: int) -> bool:
    try:
        float(value)
    except OverflowError:
        return False
    return True


def _join_surrogates(text: str) -> str:
    """Combine escaped UTF-16 surrogate pairs into one code point (what JavaScript strings show); lone ones stay."""
    if not any("\ud800" <= char <= "\udbff" for char in text):
        return text
    out: List[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if "\ud800" <= char <= "\udbff" and index + 1 < len(text) and "\udc00" <= text[index + 1] <= "\udfff":
            out.append(chr(0x10000 + ((ord(char) - 0xD800) << 10) + (ord(text[index + 1]) - 0xDC00)))
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _position(data: bytes, offset: int, base: int):
    line = 1 + data.count(b"\n", base, offset)
    line_start = data.rfind(b"\n", base, offset)
    return line, offset - (base if line_start < 0 else line_start + 1) + 1


def _decode_range(data: bytes, start: int, end: int, max_depth: int) -> Dict[str, Any]:
    raw = data[start:end]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        if _on("utf8"):
            return {"offset": start + error.start, "reason": "INVALID_UTF8", "message": "invalid UTF-8"}
        text = raw.decode("utf-8", "replace")
    try:
        return {"value": _Parser(text, max_depth).document()}
    except _Fail as failure:
        return {"offset": start + len(text[:failure.at].encode("utf-8", "surrogatepass")), "reason": failure.reason,
                "message": failure.message}


def strict_json(data: bytes, *, path: str, max_depth: int = DEFAULT_MAX_DEPTH) -> Any:
    """Decode one strict JSON document; see the module docstring."""
    if not isinstance(path, str):
        raise ArtifactError({"code": "INVALID_ARGUMENT", "path": str(path), "reason": "path is required"})
    result = _decode_range(bytes(data), 0, len(data), max_depth)
    if "value" in result:
        return result["value"]
    line, column = _position(bytes(data), result["offset"], 0)
    raise ArtifactError({"code": "CORRUPT", "path": path, "line": line, "column": column, "offset": result["offset"],
                         "reason": result["reason"], "message": result["message"]})


def strict_jsonl(data: bytes, *, path: str, max_rows: Optional[int] = None, max_row_bytes: Optional[int] = None,
                 max_depth: int = DEFAULT_MAX_DEPTH,
                 validate: Optional[Callable[[Any], List[str]]] = None) -> Dict[str, Any]:
    """Decode strict JSONL rows, reporting every refused row; see the module docstring."""
    if not isinstance(path, str):
        raise ArtifactError({"code": "INVALID_ARGUMENT", "path": str(path), "reason": "path is required"})
    for name, value, low in (("max_rows", max_rows, 0), ("max_row_bytes", max_row_bytes, 1)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < low):
            raise ArtifactError({"code": "INVALID_ARGUMENT", "path": path, "reason": f"{name} must be an integer >= {low}"})
    data = bytes(data)
    rows: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []

    def push(line: int, offset: int, column: int, reason: str, message: str) -> None:
        errors.append({"path": path, "line": line, "column": column, "offset": offset, "reason": reason, "message": message})

    if not data:
        if _on("empty"):
            push(1, 0, 1, "EMPTY", "no rows: empty input")
        return {"rows": rows, "errors": errors}
    start = line = accepted = 0
    while start < len(data):
        end = data.find(b"\n", start)
        terminated = end >= 0
        if not terminated:
            end = len(data)
        line += 1
        row_start, start = start, end + 1
        if not terminated and _on("truncated-row"):
            push(line, row_start, 1, "TRUNCATED_ROW", f"unterminated last row ({end - row_start} bytes)")
            break
        if max_row_bytes is not None and end - row_start > max_row_bytes and _on("row-size"):
            push(line, row_start, 1, "ROW_TOO_LARGE", f"row is {end - row_start} bytes; limit {max_row_bytes}")
            continue
        if not data[row_start:end].strip(b" \t\r"):
            push(line, row_start, 1, "BLANK_LINE", "blank line")
            continue
        if max_rows is not None and accepted >= max_rows:
            if _on("max-rows"):
                push(line, row_start, 1, "TOO_MANY_ROWS", f"more than {max_rows} rows; nothing from this line on was read")
            break
        result = _decode_range(data, row_start, end, max_depth)
        if "value" not in result:
            push(line, result["offset"], result["offset"] - row_start + 1, result["reason"], result["message"])
            continue
        accepted += 1
        rows.append({"line": line, "value": result["value"]})
        for message in (validate(result["value"]) if validate is not None else []):
            push(line, row_start, 1, "VALIDATION", message)
    return {"rows": rows, "errors": errors}


def reject_unknown_fields(row: Any, allowed: Iterable[str]) -> List[str]:
    """Owner-validator helper: one message per key of ``row`` not in ``allowed`` (a non-object row is one message)."""
    if not isinstance(row, dict):
        return ["row is not an object"]
    if not _on("unknown-field"):
        return []
    known = set(allowed)
    return [f"unknown field {json.dumps(key, ensure_ascii=False)}" for key in row if key not in known]
