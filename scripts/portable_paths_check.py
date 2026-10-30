#!/usr/bin/env python3
"""Reject new machine-local paths in shipped companion source."""
from __future__ import annotations

import argparse
import ast
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
import json
import sys
from collections.abc import Iterable

from kitlib_ratchet_core import lex_js
from kitlib_run import run as run_command

BASELINE_PATH = "scripts/portable-paths-baseline.json"
SCOPE_ROOTS = frozenset({"src", "extensions", "scripts", "rules-fleet"})
TEST_DIRS = frozenset({"tests", "fixtures", "__tests__"})
DOT_CLAUDE = "." + "claude"
SKILLS = "ski" + "lls"
USER_HOME = "/Users/" + "josh"
CLAUDE_SKILLS = DOT_CLAUDE + "/" + SKILLS
TILDE_CLAUDE_SKILLS = "~/" + CLAUDE_SKILLS
DIRECT_PATTERNS = (TILDE_CLAUDE_SKILLS, USER_HOME, CLAUDE_SKILLS)
MAX_BLOB_BYTES = 32 * 1024 * 1024
MAX_TREE_BYTES = 128 * 1024 * 1024


class CheckError(RuntimeError):
    """A policy input could not be inspected safely."""


@dataclass(frozen=True)
class Finding:
    start_line: int
    end_line: int
    start_offset: int
    end_offset: int


def _git_run(repo: str, args: list[str], *, stdin: bytes | None = None) -> tuple[int, bytes, bytes]:
    try:
        result = run_command(
            ["git", "-C", repo, *args],
            deadline_s=120,
            max_output_bytes=MAX_TREE_BYTES,
            max_total_bytes=MAX_TREE_BYTES,
            stdin=stdin,
        )
    except (OSError, TypeError, ValueError) as exc:
        raise CheckError(f"git {' '.join(args)} failed: {exc}") from exc
    if result.timed_out:
        raise CheckError(f"git {' '.join(args)} timed out")
    if result.truncated or result.total_truncated:
        raise CheckError(f"git {' '.join(args)} output exceeded {MAX_TREE_BYTES} bytes")
    if result.sink_error is not None:
        raise CheckError(f"git {' '.join(args)} output handler failed: {result.sink_error}")
    if result.rc is None:
        raise CheckError(f"git {' '.join(args)} returned no exit code")
    return result.rc, result.stdout, result.stderr


def _git(repo: str, args: list[str], *, stdin: bytes | None = None) -> bytes:
    returncode, stdout, stderr = _git_run(repo, args, stdin=stdin)
    if returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip()
        raise CheckError(f"git {' '.join(args)} exited {returncode}: {detail}")
    return stdout


def _git_optional(repo: str, args: list[str]) -> bytes | None:
    returncode, stdout, _ = _git_run(repo, args)
    return stdout if returncode == 0 else None


def _in_scope(path: str) -> bool:
    parts = path.split("/")
    if not parts or parts[0] not in SCOPE_ROOTS or any(part in TEST_DIRS for part in parts):
        return False
    name = parts[-1]
    return not (
        ".test." in name
        or ".spec." in name
        or name.startswith("test_")
        or name.endswith("_test.py")
    )


def _component(value: str) -> str:
    return value.strip("/")


def _line_starts(text: str) -> list[int]:
    return [0] + [index + 1 for index, char in enumerate(text) if char == "\n"]


def _finding(text: str, starts: list[int], start: int, end: int) -> Finding:
    if not 0 <= start <= end <= len(text):
        raise ValueError("invalid source span")
    first = bisect_right(starts, start)
    last = bisect_right(starts, max(start, end - 1))
    return Finding(first, last, start, end)


def _path_boundary(text: str, end: int) -> bool:
    return (
        end >= len(text)
        or text[end].isspace()
        or text[end] in "/\\'\"`,;:)]}"
    )


def _direct_findings(text: str, starts: list[int]) -> list[Finding]:
    spans: list[tuple[int, int]] = []
    for pattern in DIRECT_PATTERNS:
        offset = 0
        while offset < len(text):
            offset = text.find(pattern, offset)
            if offset < 0:
                break
            end = offset + len(pattern)
            if not _path_boundary(text, end):
                offset += 1
                continue
            if not any(offset < other_end and other_start < end for other_start, other_end in spans):
                spans.append((offset, end))
            offset = end
    return [_finding(text, starts, start, end) for start, end in spans]


def _identifier(char: str) -> bool:
    return char.isalnum() or char in "_$"


def _decode_js_string(value: str) -> str:
    decoded: list[str] = []
    escapes = {
        "b": "\b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "v": "\v",
        "0": "\0",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "`": "`",
        "$": "$",
    }
    index = 0
    while index < len(value):
        char = value[index]
        if char != "\\":
            decoded.append(char)
            index += 1
            continue
        index += 1
        if index >= len(value):
            raise ValueError("dangling JavaScript string escape")
        char = value[index]
        if char in "\r\n":
            if char == "\r" and index + 1 < len(value) and value[index + 1] == "\n":
                index += 1
            index += 1
            continue
        if char in {"x", "u"}:
            if char == "x":
                digits = value[index + 1:index + 3]
                if len(digits) != 2 or any(digit not in "0123456789abcdefABCDEF" for digit in digits):
                    raise ValueError("unsupported JavaScript hex escape")
                decoded.append(chr(int(digits, 16)))
                index += 3
                continue
            if index + 1 < len(value) and value[index + 1] == "{":
                close = value.find("}", index + 2)
                digits = value[index + 2:close] if close >= 0 else ""
                if (
                    not digits
                    or len(digits) > 6
                    or any(digit not in "0123456789abcdefABCDEF" for digit in digits)
                    or int(digits, 16) > 0x10FFFF
                ):
                    raise ValueError("unsupported JavaScript Unicode escape")
                decoded.append(chr(int(digits, 16)))
                index = close + 1
                continue
            digits = value[index + 1:index + 5]
            if len(digits) != 4 or any(digit not in "0123456789abcdefABCDEF" for digit in digits):
                raise ValueError("unsupported JavaScript Unicode escape")
            decoded.append(chr(int(digits, 16)))
            index += 5
            continue
        if char.isdigit():
            if char == "0" and (index + 1 == len(value) or not value[index + 1].isdigit()):
                decoded.append("\0")
                index += 1
                continue
            raise ValueError("unsupported JavaScript numeric escape")
        decoded.append(escapes.get(char, char))
        index += 1
    return "".join(decoded)


def _js_arguments(code: str, start: int, end: int, path: str, starts: list[int], call: int) -> list[tuple[int, int]]:
    """Split arguments after lex_js has blanked comment/string/template/regex bodies."""
    arguments: list[tuple[int, int]] = []
    segment_start = start
    stack: list[str] = []
    pairs = {"(": ")", "[": "]", "{": "}"}
    closing = frozenset(pairs.values())
    for index in range(start, end):
        char = code[index]
        if char in pairs:
            stack.append(pairs[char])
        elif char in closing:
            if not stack or char != stack[-1]:
                line = bisect_right(starts, call)
                raise CheckError(
                    f"{path}:{line}: unsupported nested delimiters in join() arguments; "
                    "resolve through the installed release or a documented config/env setting."
                )
            stack.pop()
        elif char == "," and not stack:
            arguments.append((segment_start, index))
            segment_start = index + 1
    if stack:
        line = bisect_right(starts, call)
        raise CheckError(
            f"{path}:{line}: incomplete nested delimiters in join() arguments; "
            "resolve through the installed release or a documented config/env setting."
        )
    arguments.append((segment_start, end))
    return arguments


def _js_join_findings(text: str, starts: list[int], path: str) -> list[Finding]:
    """Recognize balanced JS/TS ``join`` calls with adjacent static path components.

    This is a bounded token consumer, not a TypeScript parser: it balances
    ``()``, ``[]`` and ``{}``, accepts one closed literal per component, and
    decodes ECMAScript escapes. Malformed calls, invalid escapes and path-like
    interpolated templates fail closed; dynamic values are otherwise opaque.
    """
    code, _, strings, _ = lex_js(text)
    string_offsets = [offset for offset, _, _, _ in strings]
    findings: list[Finding] = []
    search_from = 0
    while search_from < len(code):
        call = code.find("join", search_from)
        if call < 0:
            break
        search_from = call + 4
        if call > 0 and _identifier(code[call - 1]):
            continue
        after_name = call + 4
        while after_name < len(code) and code[after_name].isspace():
            after_name += 1
        if after_name >= len(code) or code[after_name] != "(":
            continue
        depth = 1
        close = after_name + 1
        while close < len(code) and depth:
            if code[close] == "(":
                depth += 1
            elif code[close] == ")":
                depth -= 1
            close += 1
        line = bisect_right(starts, call)
        if depth:
            raise CheckError(
                f"{path}:{line}: incomplete join() call cannot be inspected; "
                "resolve through the installed release or a documented config/env setting."
            )
        args = _js_arguments(code, after_name + 1, close - 1, path, starts, call)
        values: list[str | None] = []
        for arg_start, arg_end in args:
            first = bisect_left(string_offsets, arg_start)
            last = bisect_left(string_offsets, arg_end)
            literals = strings[first:last]
            if len(literals) != 1:
                values.append(None)
                continue
            offset, raw, end, interpolated = literals[0]
            if interpolated:
                component = _component(raw)
                if component.endswith(DOT_CLAUDE) or component.split("/", 1)[0] == SKILLS:
                    raise CheckError(
                        f"{path}:{line}: dynamic template component in join() cannot be inspected; "
                        "resolve through the installed release or a documented config/env setting."
                    )
                values.append(None)
                continue
            delimiter = text[offset]
            if delimiter not in {"'", '"', "`"} or end >= len(text) or text[end] != delimiter:
                raise CheckError(
                    f"{path}:{line}: incomplete JavaScript string in join() cannot be inspected; "
                    "resolve through the installed release or a documented config/env setting."
                )
            try:
                values.append(_decode_js_string(raw))
            except ValueError as exc:
                raise CheckError(
                    f"{path}:{line}: {exc}; resolve through the installed release or a documented "
                    "config/env setting."
                ) from exc
        for left, right in zip(values, values[1:]):
            if left is None or right is None:
                continue
            if _component(left).endswith(DOT_CLAUDE) and _component(right).split("/", 1)[0] == SKILLS:
                findings.append(_finding(text, starts, call, close))
                break
    return findings


def _python_join_findings(text: str, starts: list[int], path: str) -> list[Finding]:
    try:
        tree = ast.parse(text, filename=path)
    except SyntaxError as exc:
        raise CheckError(f"{path}:{exc.lineno or 1}: Python source cannot be parsed for path inspection") from exc
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ""
        if function != "join":
            continue
        values = [arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else None for arg in node.args]
        if not any(
            left is not None
            and right is not None
            and _component(left).endswith(DOT_CLAUDE)
            and _component(right).split("/", 1)[0] == SKILLS
            for left, right in zip(values, values[1:])
        ):
            continue
        first_line = node.lineno
        last_line = getattr(node, "end_lineno", first_line)
        start = starts[first_line - 1]
        end = starts[last_line] if last_line < len(starts) else len(text)
        findings.append(Finding(first_line, last_line, start, end))
    return findings


def _scan(path: str, blob: bytes) -> list[Finding]:
    if b"\0" in blob:
        return []
    if len(blob) > MAX_BLOB_BYTES:
        raise CheckError(f"{path}: source blob exceeds {MAX_BLOB_BYTES} bytes")
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CheckError(f"{path}: source is not UTF-8 and cannot be inspected") from exc
    starts = _line_starts(text)
    findings = _direct_findings(text, starts)
    suffix = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if suffix in {"js", "jsx", "mjs", "cjs", "ts", "tsx"}:
        findings.extend(_js_join_findings(text, starts, path))
    elif suffix == "py":
        findings.extend(_python_join_findings(text, starts, path))
    return sorted(findings, key=lambda item: (item.start_line, item.start_offset, item.end_line))


def _tree_blob(repo: str, revision: str, path: str) -> bytes | None:
    return _git_optional(repo, ["show", f"{revision}:{path}"])


def _index_blob(repo: str, path: str) -> bytes | None:
    return _git_optional(repo, ["show", f":{path}"])


def _tree_counts(repo: str, revision: str) -> dict[str, int]:
    listing = _git(repo, ["ls-tree", "-r", "-z", revision, "--", *sorted(SCOPE_ROOTS)])
    entries: list[tuple[str, bytes]] = []
    for record in listing.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        _, kind, oid = metadata.split()
        path = raw_path.decode("utf-8", "surrogateescape")
        if kind == b"blob" and _in_scope(path):
            entries.append((path, oid))
    if not entries:
        return {}
    packed = _git(repo, ["cat-file", "--batch"], stdin=b"".join(oid + b"\n" for _, oid in entries))
    if len(packed) > MAX_TREE_BYTES:
        raise CheckError(f"{revision}: source tree exceeds {MAX_TREE_BYTES} bytes")
    counts: dict[str, int] = {}
    cursor = 0
    for path, _ in entries:
        header_end = packed.find(b"\n", cursor)
        if header_end < 0:
            raise CheckError(f"{revision}: truncated git cat-file batch header")
        fields = packed[cursor:header_end].split()
        if len(fields) != 3 or fields[1] != b"blob":
            raise CheckError(f"{revision}:{path}: invalid git cat-file batch record")
        size = int(fields[2])
        start = header_end + 1
        end = start + size
        if end >= len(packed) or packed[end:end + 1] != b"\n":
            raise CheckError(f"{revision}:{path}: truncated git cat-file batch body")
        findings = _scan(path, packed[start:end])
        if findings:
            counts[path] = len(findings)
        cursor = end + 1
    return counts


def _parse_baseline(raw: bytes, label: str) -> dict[str, int]:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CheckError(f"{label}: invalid baseline JSON: {exc}") from exc
    if not isinstance(payload, dict) or set(payload) != {"about", "counts", "schema", "totals"}:
        raise CheckError(f"{label}: baseline must contain about, counts, schema, and totals")
    if payload["schema"] != 1 or not isinstance(payload["about"], str):
        raise CheckError(f"{label}: unsupported portable-path baseline schema")
    raw_counts = payload["counts"]
    if not isinstance(raw_counts, dict):
        raise CheckError(f"{label}: counts must be an object")
    counts: dict[str, int] = {}
    for path, count in raw_counts.items():
        if not isinstance(path, str) or not _in_scope(path) or type(count) is not int or count <= 0:
            raise CheckError(f"{label}: invalid baseline entry {path!r}: {count!r}")
        counts[path] = count
    totals = payload["totals"]
    if totals != {"portable-paths": sum(counts.values())}:
        raise CheckError(f"{label}: totals do not match counts")
    return counts




def _read_baseline(raw: bytes | None, label: str) -> dict[str, int]:
    if raw is None:
        raise CheckError(f"{label}: missing {BASELINE_PATH}")
    return _parse_baseline(raw, label)


def _check_shrunk(old: dict[str, int], new: dict[str, int]) -> list[str]:
    return [path for path, count in sorted(new.items()) if count > old.get(path, 0)]


def _added_lines(repo: str, path: str, *, base: str | None = None, head: str | None = None) -> set[int]:
    if base is None:
        args = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", "--", path]
    else:
        if head is None:
            raise CheckError("range diff needs both base and head")
        args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", base, head, "--", path]
    lines = _git(repo, args).decode("utf-8", "replace").splitlines()
    added: set[int] = set()
    current: int | None = None
    in_hunk = False
    for line in lines:
        if line.startswith("@@ "):
            fields = line.split(" ", 3)
            if len(fields) < 3 or not fields[2].startswith("+"):
                current = None
                in_hunk = False
                continue
            try:
                current = int(fields[2][1:].split(",", 1)[0])
            except ValueError as exc:
                raise CheckError(f"malformed diff hunk for {path}: {line}") from exc
            in_hunk = True
        elif not in_hunk or current is None:
            continue
        elif line.startswith("+"):
            added.add(current)
            current += 1
        elif line.startswith("-"):
            continue
        elif line.startswith(" "):
            current += 1
    return added


def _changed_paths(repo: str, *, base: str | None = None, head: str | None = None) -> list[str]:
    if base is None:
        raw = _git(repo, ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"])
    else:
        if head is None:
            raise CheckError("range path query needs both base and head")
        raw = _git(repo, ["diff", "--name-only", "--no-renames", "-z", base, head, "--"])
    return [item.decode("utf-8", "surrogateescape") for item in raw.split(b"\0") if item]


def _report(path: str, finding: Finding) -> None:
    print(
        f"PORTABLEPATHS: REFUSED: {path}:{finding.start_line} adds a machine-specific path reference; "
        "resolve through the installed release or a documented config/env setting.",
        file=sys.stderr,
    )


def _check_added(repo: str, paths: Iterable[str], *, base: str | None = None, head: str | None = None) -> bool:
    refused = False
    for path in sorted(set(paths)):
        if not _in_scope(path):
            continue
        added = _added_lines(repo, path, base=base, head=head)
        blob = _index_blob(repo, path) if base is None else _tree_blob(repo, head or "", path)
        if blob is None:
            continue
        for finding in _scan(path, blob):
            if any(finding.start_line <= line <= finding.end_line for line in added):
                _report(path, finding)
                refused = True
    return refused


def _check_observed(
    repo: str,
    counts: dict[str, int],
    paths: Iterable[str],
    *,
    revision: str | None = None,
    staged: bool = False,
) -> bool:
    refused = False
    for path in sorted(set(paths)):
        blob = _index_blob(repo, path) if staged else _tree_blob(repo, revision or "", path)
        findings = _scan(path, blob) if blob is not None else []
        allowed = counts.get(path, 0)
        if len(findings) <= allowed:
            continue
        _report(path, findings[allowed])
        refused = True
    return refused


def _check_staged(repo: str) -> int:
    old_raw = _tree_blob(repo, "HEAD", BASELINE_PATH)
    bootstrap = old_raw is None
    old_counts = _tree_counts(repo, "HEAD") if bootstrap else _read_baseline(old_raw, "HEAD")
    new_counts = _read_baseline(_index_blob(repo, BASELINE_PATH), "index")
    if bootstrap and new_counts != old_counts:
        print(f"PORTABLEPATHS: REFUSED: {BASELINE_PATH} must exactly inventory the pre-existing source paths.", file=sys.stderr)
        return 1
    raised = _check_shrunk(old_counts, new_counts)
    if raised:
        for path in raised:
            print(f"PORTABLEPATHS: REFUSED: {BASELINE_PATH} adds or raises allowlist entry {path}; this ratchet only shrinks.", file=sys.stderr)
    paths = set(old_counts) | set(new_counts)
    observed_bad = _check_observed(repo, new_counts, paths, staged=True)
    added_bad = _check_added(repo, _changed_paths(repo), base=None)
    return 1 if raised or observed_bad or added_bad else 0


def _check_range(repo: str, base: str, head: str) -> int:
    _git(repo, ["rev-parse", "--verify", f"{base}^{{commit}}"])
    _git(repo, ["rev-parse", "--verify", f"{head}^{{commit}}"])
    old_raw = _tree_blob(repo, base, BASELINE_PATH)
    bootstrap = old_raw is None
    old_counts = _tree_counts(repo, base) if bootstrap else _read_baseline(old_raw, base)
    new_counts = _read_baseline(_tree_blob(repo, head, BASELINE_PATH), head)
    if bootstrap and new_counts != old_counts:
        print(f"PORTABLEPATHS: REFUSED: {BASELINE_PATH} must exactly inventory the pre-existing source paths.", file=sys.stderr)
        return 1
    raised = _check_shrunk(old_counts, new_counts)
    if raised:
        for path in raised:
            print(f"PORTABLEPATHS: REFUSED: {BASELINE_PATH} adds or raises allowlist entry {path}; this ratchet only shrinks.", file=sys.stderr)
    paths = set(old_counts) | set(new_counts)
    observed_bad = _check_observed(repo, new_counts, paths, revision=head)
    added_bad = _check_added(repo, _changed_paths(repo, base=base, head=head), base=base, head=head)
    return 1 if raised or observed_bad or added_bad else 0


def _check_head(repo: str, head: str) -> int:
    _git(repo, ["rev-parse", "--verify", f"{head}^{{commit}}"])
    counts = _read_baseline(_tree_blob(repo, head, BASELINE_PATH), head)
    observed = _tree_counts(repo, head)
    if observed != counts:
        for path in sorted(set(observed) | set(counts)):
            if observed.get(path, 0) != counts.get(path, 0):
                print(f"PORTABLEPATHS: REFUSED: {BASELINE_PATH} does not match the no-base source inventory at {path}.", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--base")
    parser.add_argument("--head")
    args = parser.parse_args(argv)
    try:
        if args.staged and args.base is None and args.head is None:
            return _check_staged(args.repo)
        if not args.staged and args.base is not None and args.head is not None:
            return _check_range(args.repo, args.base, args.head)
        if not args.staged and args.base is None and args.head is not None:
            return _check_head(args.repo, args.head)
        raise CheckError("select exactly one of --staged, --base/--head, or --head")
    except CheckError as exc:
        print(f"PORTABLEPATHS: REFUSED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
