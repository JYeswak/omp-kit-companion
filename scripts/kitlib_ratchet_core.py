#!/usr/bin/env python3
"""kitlib_ratchet_core: the shared engine behind the kitlib adoption ratchets.

ompkit-qwqh1 (KITLIB-RATCHET, J-2026-10-22-07/09). One engine judges every
"use kitlib, never hand-roll it" rule set: TEMPSAFE (scripts/tempsafe_check.py,
pragma ``tempsafe:``) and KITLIB (scripts/kitlib_ratchet.py, pragma
``kitlib:``). This module is a library; it has no CLI of its own.

A rule set (``RuleSet``) supplies its pragma word, its rules and per-language
hints, its exempt set, and one scanner per language. A scanner receives the
file bytes and returns ``Scan(hits, texts, pragmas)``: hits per rule and line
(each the constructs found), the line text without comments (the ratchet
fingerprint and the printed snippet), and every comment as a candidate pragma.
The engine supplies what every rule set shares:

  * selection: judged extensions, shebang languages, exempt paths (an entry
    ending "/" exempts a directory; one whose last segment holds "*" matches
    that segment as a glob inside the named directory);
  * parsing helpers: ``py_source`` (AST, comments, import aliases with
    ``resolve``), ``lex_js`` (comments, strings, templates and regex literals
    blanked), and ``scan_sh`` (comments stripped with quote state carried
    across lines, heredoc bodies routed to their own callback);
  * suppression: a comment whose text starts ``<pragma>: <reason>`` on the
    flagged line; a reason under two words or 10 characters is
    ``suppression-no-reason`` and suppresses nothing; a well-formed pragma on
    a line without a finding is ``suppression-unused``;
  * ``parse-error`` (Python that does not parse) and ``too-large`` (over 4 MiB);
  * the git ratchet: a finding is new when its (rule, line text without
    comments) fingerprint occurs more often in the new blob than in the old
    one (a rename keeps the old blob as baseline); only the surplus is
    reported, as the last occurrences. Untouched sites never block; new ones
    always do;
  * the CLI: PATH..., --tree LABEL PATH, --staged [--repo DIR] (GIT_INDEX_FILE
    honoured), --head REV [--base REV], --format text|json; exit 0 clean,
    1 findings, 2 usage/infrastructure.

Git runs through ``pysafe.run_bounded`` (the process primitive kitlib_run
wraps); only the pysafe runtime library is imported, never pysafe_check.
"""
from __future__ import annotations

import argparse
import ast
import bisect
import fnmatch
import io
import json
import os
import re
import sys
import tokenize
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
# Only the pysafe runtime library is imported, never pysafe_check: a broken or
# hung pysafe_check.py (the staged-pysafe contract plants one) must not take a
# ratchet member down with it.
import pysafe  # noqa: E402

MAX_FILE_BYTES = 4 * 1024 * 1024
GIT_TIMEOUT_S = 30.0
GIT_CAP_BYTES = 64 * 1024 * 1024
SNIPPET_CHARS = 160

EXTENSIONS = {".py": "py", ".ts": "ts", ".tsx": "ts", ".js": "ts", ".mjs": "ts", ".cjs": "ts",
              ".sh": "sh", ".bash": "sh"}
SKIP_DIRS = {"node_modules", "__pycache__", "venv"}

REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^")
REGEX_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw",
               "instanceof", "yield", "await"}
HEREDOC_RE = re.compile(r"<<(-?)[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|\"([A-Za-z_][A-Za-z0-9_]*)\"|\\?([A-Za-z_][A-Za-z0-9_]*))")
SH_CMD_CHARS = set(";&|(`{!")
SH_CMD_WORDS = {"then", "do", "else", "if", "while", "until", "exec", "command"}

# line -> [(col, construct)], one entry per distinct construct (first column kept)
LineHits = Dict[int, List[Tuple[int, str]]]
Pragmas = List[Tuple[int, int, str]]


def meta_rules(pragma: str) -> Dict[str, str]:
    """The rules every rule set shares, worded with its pragma."""
    return {
        "suppression-no-reason": f"{pragma} suppression needs a reason (two or more words, 10+ characters)",
        "suppression-unused": f"{pragma} suppression matches no finding on its line",
        "parse-error": "file does not parse; it cannot be judged",
        "too-large": "file exceeds the 4 MiB judging limit",
    }


class Hits:
    """Findings collected by a scanner: rule -> line -> constructs."""

    def __init__(self) -> None:
        self.by_rule: Dict[str, LineHits] = {}

    def add(self, rule: str, line: int, col: int, construct: str) -> None:
        entries = self.by_rule.setdefault(rule, {}).setdefault(line, [])
        if all(name != construct for _, name in entries):
            entries.append((col, construct))

    def lines(self) -> Set[int]:
        return {line for per_line in self.by_rule.values() for line in per_line}

    def __contains__(self, line: int) -> bool:
        return any(line in per_line for per_line in self.by_rule.values())


@dataclass
class Scan:
    hits: Hits
    texts: Dict[int, str]
    pragmas: Pragmas


@dataclass
class Finding:
    path: str
    line: int
    col: int
    rule: str
    detail: str
    snippet: str
    suppressed: Optional[str] = None

    def key(self) -> Tuple[str, str]:
        return (self.rule, self.snippet)

    def as_json(self) -> dict:
        return {"path": self.path, "line": self.line, "col": self.col, "rule": self.rule,
                "detail": self.detail, "snippet": self.snippet, "suppressed": self.suppressed}


@dataclass
class FileReport:
    path: str
    findings: List[Finding] = field(default_factory=list)

    def active(self) -> List[Finding]:
        return [f for f in self.findings if f.suppressed is None]


class GitError(Exception):
    pass


def _git(repo: str, *args: str) -> bytes:
    result = pysafe.run_bounded(["git", "-C", repo, *args], GIT_TIMEOUT_S, cap_bytes=GIT_CAP_BYTES)
    if result.outcome != pysafe.OK:
        raise GitError(f"git {' '.join(args)}: TIMEOUT after {GIT_TIMEOUT_S:g}s")
    if result.stdout_truncated:
        raise GitError(f"git {' '.join(args)}: output over {GIT_CAP_BYTES} bytes")
    if result.returncode != 0:
        raise GitError(f"git {' '.join(args)}: exit {result.returncode}: {result.text('stderr').strip()}")
    return result.stdout


def display(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def exempt_match(exempt: Sequence[str], path: str) -> bool:
    posix = path.replace(os.sep, "/")
    for entry in exempt:
        if entry.endswith("/"):
            if posix.startswith(entry) or "/" + entry in posix:
                return True
        elif "*" in entry:
            folder, _, pattern = entry.rpartition("/")
            parent, _, base = posix.rpartition("/")
            if fnmatch.fnmatchcase(base, pattern) and (parent == folder or parent.endswith("/" + folder)):
                return True
        elif posix == entry or posix.endswith("/" + entry):
            return True
    return False


def shebang_language(head: bytes) -> Optional[str]:
    if not head.startswith(b"#!"):
        return None
    words = head[2:].split(b"\n", 1)[0].decode("utf-8", "replace").split()
    if not words:
        return None
    name = os.path.basename(words[0])
    if name == "env":
        rest = [word for word in words[1:] if not word.startswith("-")]
        if not rest:
            return None
        name = rest[0]
    if name in ("sh", "bash", "dash"):
        return "sh"
    if name == "python" or name.startswith("python3"):
        return "py"
    return None


def language(path: str, head: bytes) -> Optional[str]:
    base = os.path.basename(path)
    ext = os.path.splitext(base)[1]
    if ext:
        return EXTENSIONS.get(ext)
    return shebang_language(head)


def collapse(text: str) -> str:
    joined = " ".join(text.split())
    return joined if len(joined) <= SNIPPET_CHARS else joined[:SNIPPET_CHARS] + "..."


# --- Python --------------------------------------------------------------
@dataclass
class PySource:
    tree: ast.AST
    lines: List[str]
    comment_col: Dict[int, int]
    pragmas: Pragmas
    aliases: Dict[str, str]

    def texts(self, hit_lines: Iterable[int]) -> Dict[int, str]:
        return {line: self.lines[line - 1][:self.comment_col.get(line, len(self.lines[line - 1]))]
                for line in hit_lines if line <= len(self.lines)}


def aliases(tree: ast.AST) -> Dict[str, str]:
    """Local name -> dotted import target (``import tempfile as tf``, ``from tempfile import mkdtemp``)."""
    found: Dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                head = alias.name.split(".")[0]
                found[alias.asname or head] = alias.name if alias.asname else head
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            for alias in node.names:
                found[alias.asname or alias.name] = node.module + "." + alias.name
    return found


def resolve(node: ast.AST, names: Mapping[str, str]) -> Optional[str]:
    if isinstance(node, ast.Name):
        return names.get(node.id)
    if isinstance(node, ast.Attribute):
        base = resolve(node.value, names)
        return base + "." + node.attr if base else None
    return None


def py_source(source: bytes, path: str) -> PySource:
    """Parse once for a Python scanner; raises SyntaxError & co (judged as parse-error)."""
    tree = ast.parse(source, filename=path)
    lines = source.decode("utf-8", "replace").split("\n")
    comment_col: Dict[int, int] = {}
    pragmas: Pragmas = []
    for token in tokenize.tokenize(io.BytesIO(source).readline):
        if token.type == tokenize.COMMENT:
            line, col = token.start
            comment_col[line] = col
            pragmas.append((line, col + 1, token.string[1:]))
    return PySource(tree, lines, comment_col, pragmas, aliases(tree))


# --- TS/JS ---------------------------------------------------------------
def _blank(chars: List[str], start: int, end: int) -> None:
    for index in range(start, end):
        if chars[index] != "\n":
            chars[index] = " "


StringLiteral = Tuple[int, str, int, bool]


def lex_js(text: str) -> Tuple[str, str, List[StringLiteral], List[Tuple[int, str]]]:
    """Return (code, bare, strings, comments): ``code`` has comments, string,
    template and regex bodies blanked; ``bare`` has only comments blanked
    (newlines kept in both); ``strings`` are (offset, text, end, interpolated)
    for every quoted literal and the leading chunk of every template (``end``
    is the closing delimiter's offset, ``interpolated`` that a template chunk
    ends at ``${``); ``comments`` are (offset, first-line text)."""
    n = len(text)
    code = list(text)
    bare = list(text)
    strings: List[StringLiteral] = []
    comments: List[Tuple[int, str]] = []
    stack: List[int] = []
    brace = 0
    last = ""
    i = 0
    resume_template = False
    while i < n:
        c = text[i]
        if resume_template or c == "`":
            head = not resume_template
            resume_template = False
            j = i + 1
            while j < n and text[j] != "`" and not text.startswith("${", j):
                j += 2 if text[j] == "\\" else 1
            j = min(j, n)
            if head:
                strings.append((i, text[i + 1:j], j, j < n and text[j] == "$"))
            _blank(code, i + 1, j)
            if j < n and text[j] == "$":
                stack.append(brace)
                brace += 1
                i = j + 2
                last = "{"
            else:
                i = j + 1
                last = "a"
            continue
        if c == "/" and text.startswith("//", i):
            end = text.find("\n", i)
            end = n if end < 0 else end
            comments.append((i, text[i + 2:end]))
            _blank(code, i, end)
            _blank(bare, i, end)
            i = end
            continue
        if c == "/" and text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = n if end < 0 else end + 2
            comments.append((i, text[i + 2:end].split("\n", 1)[0].rstrip("*/ ")))
            _blank(code, i, end)
            _blank(bare, i, end)
            i = end
            continue
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            j = min(j, n)
            strings.append((i, text[i + 1:j], j, False))
            _blank(code, i + 1, j)
            i = j + 1
            last = "a"
            continue
        if c == "/" and (last == "" or last in REGEX_PREV or last in REGEX_WORDS):
            j = i + 1
            in_class = False
            while j < n and text[j] != "\n":
                ch = text[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    break
                j += 1
            if j < n and text[j] == "/":
                _blank(code, i + 1, j)
                i = j + 1
                last = "a"
                continue
        if c.isalnum() or c in "_$":
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] in "_$"):
                j += 1
            word = text[i:j]
            last = word if word in REGEX_WORDS else "a"
            i = j
            continue
        if c == "{":
            brace += 1
        elif c == "}":
            brace -= 1
            if stack and brace == stack[-1]:
                stack.pop()
                resume_template = True
                continue
        if not c.isspace():
            last = c if c not in ")]" else "a"
        i += 1
    return "".join(code), "".join(bare), strings, comments


def js_locator(text: str) -> Callable[[int], Tuple[int, int]]:
    """Offset -> (line, column), both 1-based."""
    starts = [0] + [m.end() for m in re.finditer("\n", text)]

    def where(offset: int) -> Tuple[int, int]:
        line = bisect.bisect_right(starts, offset)
        return line, offset - starts[line - 1] + 1

    return where


def js_scan(text: str, hits: Hits, bare: str, comments: List[Tuple[int, str]],
            where: Callable[[int], Tuple[int, int]]) -> Scan:
    """Assemble a TS/JS Scan: snippet texts from ``bare`` (comments blanked)."""
    bare_lines = bare.split("\n")
    texts = {line: bare_lines[line - 1] for line in hits.lines()}
    return Scan(hits, texts, [(*where(offset), body) for offset, body in comments])


# --- shell ---------------------------------------------------------------
def sh_line(line: str, quote: str) -> Tuple[str, Optional[str], str, List[Tuple[str, bool, bool]]]:
    """Split one physical line into (code, comment, quote state after, heredocs opened)."""
    heredocs: List[Tuple[str, bool, bool]] = []
    n = len(line)
    i = 0
    while i < n:
        c = line[i]
        if quote == "'":
            if c == "'":
                quote = ""
        elif quote in ('"', "$'"):
            if c == "\\":
                i += 2
                continue
            if (quote == '"' and c == '"') or (quote == "$'" and c == "'"):
                quote = ""
        elif c == "\\":
            i += 2
            continue
        elif c == "'":
            quote = "$'" if i > 0 and line[i - 1] == "$" else "'"
        elif c == '"':
            quote = '"'
        elif c == "#" and (i == 0 or line[i - 1] in " \t;&|("):
            return line[:i], line[i + 1:], quote, heredocs
        elif c == "<" and line.startswith("<<", i) and not line.startswith("<<<", i):
            match = HEREDOC_RE.match(line, i)
            if match:
                delimiter = match.group(2) or match.group(3) or match.group(4)
                quoted = match.group(4) is None or line[match.start(4) - 1] == "\\"
                heredocs.append((delimiter, match.group(1) == "-", quoted))
                i = match.end()
                continue
        i += 1
    return line, None, quote, heredocs


def sh_command_position(code: str, start: int) -> bool:
    before = code[:start].rstrip(" \t")
    if not before:
        return True
    if before[-1] in SH_CMD_CHARS:
        return True
    word = before.rsplit(None, 1)[-1]
    return word in SH_CMD_WORDS


def _sh_path_char(ch: str) -> bool:
    return ch.isalnum() or ch in "_./-"


def sh_command_words(code: str, pattern: "re.Pattern[str]") -> Iterable[Tuple[int, int]]:
    """(start, end) of command words matching ``pattern``: the bare name or an
    absolute path ending in it (``/usr/bin/mktemp``); a relative path or
    ``$BIN/name`` yields nothing. Each match walks back to the start of its
    path-character run, stopping at the previous match and reusing that run's
    start, so every character is walked at most once (linear in the line)."""
    prev_pos, prev_run = -1, 0
    for match in pattern.finditer(code):
        start = match.start()
        run = start
        while run > 0 and _sh_path_char(code[run - 1]):
            if run == prev_pos:
                run = prev_run
                break
            run -= 1
        prev_pos, prev_run = start, run
        if start and code[start - 1] == "/":
            if code[run] == "/":
                yield run, match.end()
        else:
            yield start, match.end()


ShCodeFn = Callable[[str, int, Hits], None]


def scan_sh(text: str, on_code: ShCodeFn, on_heredoc: ShCodeFn) -> Scan:
    """Walk a shell file: ``on_code(code, line, hits)`` gets each line with its
    comment stripped (quote state carried across lines); ``on_heredoc`` gets
    each body line of an unquoted-delimiter heredoc (quoted bodies are literal
    text and skipped)."""
    hits = Hits()
    texts: Dict[int, str] = {}
    pragmas: Pragmas = []
    quote = ""
    pending: List[Tuple[str, bool, bool]] = []
    body: Optional[Tuple[str, bool, bool]] = None
    for number, line in enumerate(text.split("\n"), 1):
        if body is not None:
            delimiter, strip_tabs, quoted = body
            if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                body = pending.pop(0) if pending else None
                continue
            if not quoted:
                on_heredoc(line, number, hits)
                if number in hits:
                    texts[number] = line
            continue
        code, comment, quote, opened = sh_line(line, quote)
        if comment is not None:
            pragmas.append((number, len(code) + 1, comment))
        pending.extend(opened)
        if pending and quote == "":
            body = pending.pop(0)
        on_code(code, number, hits)
        if number in hits:
            texts[number] = code
    return Scan(hits, texts, pragmas)


# --- rule set ------------------------------------------------------------
Scanner = Callable[[bytes, str], Scan]
DetailFn = Callable[[str, str, List[str]], str]


@dataclass(frozen=True)
class RuleSet:
    """One ratchet: ``prog`` names the CLI and its stderr prefix, ``pragma``
    the suppression word, ``rules`` every rule id with its description (the
    meta rules included), ``detail(rule, lang, constructs)`` a finding's text,
    ``scanners`` one per judged language ("py", "ts", "sh")."""
    prog: str
    description: str
    pragma: str
    rules: Mapping[str, str]
    exempt: Tuple[str, ...]
    scanners: Mapping[str, Scanner]
    detail: DetailFn

    def is_exempt(self, path: str) -> bool:
        return exempt_match(self.exempt, path)

    def _pragma(self, body: str) -> Optional[str]:
        """Reason text of a pragma ('' when malformed), or None when the comment is not one."""
        text = body.strip()
        if not text.startswith(self.pragma):
            return None
        rest = text[len(self.pragma):]
        if rest and rest[0] != ":":
            return None
        return rest[1:].strip()

    def check_source(self, source: bytes, path: str, lang: str) -> FileReport:
        report = FileReport(path)
        if len(source) > MAX_FILE_BYTES:
            report.findings.append(Finding(path, 1, 1, "too-large", self.rules["too-large"], f"{len(source)} bytes"))
            return report
        try:
            scan = self.scanners[lang](source, path)
        except (SyntaxError, ValueError, RecursionError, tokenize.TokenError) as exc:
            if lang != "py":
                raise
            line = getattr(exc, "lineno", None) or 1
            report.findings.append(Finding(path, line, 1, "parse-error", f"{type(exc).__name__}: {exc}",
                                           type(exc).__name__))
            return report
        reasons: Dict[int, str] = {}
        for line, col, body in scan.pragmas:
            reason = self._pragma(body)
            if reason is None:
                continue
            if len(reason) < 10 or len(reason.split()) < 2:
                report.findings.append(Finding(path, line, col, "suppression-no-reason",
                                               self.rules["suppression-no-reason"],
                                               collapse(self.pragma + ":" + reason)))
                continue
            reasons[line] = reason
        for rule, per_line in scan.hits.by_rule.items():
            for line in sorted(per_line):
                entries = sorted(per_line[line])
                report.findings.append(Finding(path, line, entries[0][0], rule,
                                               self.detail(rule, lang, [name for _, name in entries]),
                                               collapse(scan.texts.get(line, "")), reasons.get(line)))
        for line in sorted(set(reasons) - scan.hits.lines()):
            report.findings.append(Finding(path, line, 1, "suppression-unused", self.rules["suppression-unused"],
                                           collapse(reasons[line])))
        report.findings.sort(key=lambda f: (f.line, f.col, f.rule))
        return report

    def check_file(self, path: str) -> Optional[FileReport]:
        """Judge one file; None when it is exempt or not a judged language."""
        if self.is_exempt(path):
            return None
        with open(path, "rb") as handle:
            source = handle.read(MAX_FILE_BYTES + 1)
        lang = language(path, source[:256])
        return None if lang is None else self.check_source(source, path, lang)

    def changed(self, raw: bytes) -> List[Tuple[Optional[str], str]]:
        """Parse ``--name-status -z -M`` into (old_path, new_path) pairs for A/M/R/T entries."""
        items = raw.split(b"\0")
        pairs: List[Tuple[Optional[str], str]] = []
        index = 0
        while index < len(items) and items[index]:
            status = items[index].decode()
            if status.startswith("R") or status.startswith("C"):
                old, new = items[index + 1].decode(), items[index + 2].decode()
                index += 3
                pairs.append((old if status.startswith("R") else None, new))
                continue
            path = items[index + 1].decode()
            index += 2
            if status in ("A", "M", "T"):
                pairs.append((path if status != "A" else None, path))
        return [(old, new) for old, new in pairs if not self.is_exempt(new)]

    def ratchet(self, repo: str, base: Optional[str], head: Optional[str]) -> List[FileReport]:
        """head=None judges the index (staged) against base (HEAD)."""
        if head is None:
            if base is not None:
                raw = _git(repo, "diff", "--cached", "--name-status", "-z", "-M", "--diff-filter=AMRT", base)
            else:
                raw = _git(repo, "diff", "--cached", "--name-status", "-z", "--diff-filter=AMRT")
        elif base is not None:
            raw = _git(repo, "diff", "--name-status", "-z", "-M", "--diff-filter=AMRT", base, head)
        else:
            raw = _git(repo, "diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-z", "-M",
                       "--diff-filter=AMRT", head)
        reports: List[FileReport] = []
        for old, new in self.changed(raw):
            ext = os.path.splitext(os.path.basename(new))[1]
            if ext and ext not in EXTENSIONS:
                continue
            new_source = _git(repo, "cat-file", "blob", (":" if head is None else head + ":") + new)
            lang = language(new, new_source[:256])
            if lang is None:
                continue
            after_active = self.check_source(new_source, new, lang).active()
            before_keys: Counter = Counter()
            if old is not None and base is not None:
                old_source = _git(repo, "cat-file", "blob", f"{base}:{old}")
                before_keys = Counter(f.key() for f in self.check_source(old_source, old, lang).active())
            after_keys = Counter(f.key() for f in after_active)
            seen: Counter = Counter()
            report = FileReport(new)
            for finding in after_active:
                key = finding.key()
                extra = after_keys[key] - before_keys.get(key, 0)
                seen[key] += 1
                if extra > 0 and seen[key] > after_keys[key] - extra:
                    if after_keys[key] > extra:
                        finding.detail += f" ({extra} new of {after_keys[key]} identical)"
                    report.findings.append(finding)
            reports.append(report)
        return reports

    def emit_json(self, groups: Sequence[Tuple[str, List[FileReport]]], out) -> None:
        payload = {"rules": dict(self.rules), "groups": []}
        for label, reports in groups:
            active = [len(r.active()) for r in reports]
            payload["groups"].append({
                "label": label,
                "summary": {"files": len(reports), "files_with_findings": sum(1 for n in active if n),
                            "findings": sum(active),
                            "suppressed": sum(len(r.findings) - len(r.active()) for r in reports)},
                "files": [{"path": display(r.path), "findings": [f.as_json() for f in r.findings]}
                          for r in reports],
            })
        json.dump(payload, out, indent=1, sort_keys=True)
        out.write("\n")

    def main(self, argv: Optional[Sequence[str]] = None) -> int:
        parser = argparse.ArgumentParser(prog=self.prog + ".py", description=self.description)
        parser.add_argument("paths", nargs="*")
        parser.add_argument("--tree", nargs=2, action="append", default=[], metavar=("LABEL", "PATH"))
        parser.add_argument("--staged", action="store_true")
        parser.add_argument("--base")
        parser.add_argument("--head")
        parser.add_argument("--repo", default=".")
        parser.add_argument("--format", choices=("text", "json"), default="text")
        args = parser.parse_args(argv)
        groups: List[Tuple[str, List[FileReport]]] = []
        if args.staged or args.head:
            if args.paths or args.tree or (args.staged and args.head):
                parser.error("--staged/--head take no paths and exclude each other")
            try:
                base = _base_rev(args.repo, args)
                groups.append(("changed", self.ratchet(args.repo, base, None if args.staged else args.head)))
            except GitError as exc:
                sys.stderr.write(f"{self.prog}: {exc}\n")
                return 2
        else:
            entries: List[Tuple[str, str]] = [(p, p) for p in args.paths] + [(t[0], t[1]) for t in args.tree]
            if not entries:
                parser.error("give PATH arguments, --tree, --staged or --head")
            by_label: Dict[str, List[FileReport]] = {}
            for label, path in entries:
                if not os.path.exists(path):
                    sys.stderr.write(f"{self.prog}: no such path: {path}\n")
                    return 2
                bucket = by_label.setdefault(label, [])
                for file_path in iter_files(path):
                    report = self.check_file(file_path)
                    if report is not None:
                        bucket.append(report)
            groups = list(by_label.items())
        if args.format == "json":
            self.emit_json(groups, sys.stdout)
        else:
            for _, reports in groups:
                for report in reports:
                    for f in report.active():
                        sys.stdout.write(f"{display(f.path)}:{f.line}:{f.col}: {f.rule}: {f.detail}: {f.snippet}\n")
        return 1 if any(r.active() for _, reports in groups for r in reports) else 0


def iter_files(path: str) -> Iterable[str]:
    if os.path.isfile(path):
        yield path
        return
    for root, dirs, files in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
        for name in sorted(files):
            full = os.path.join(root, name)
            if not os.path.islink(full):
                yield full


def _base_rev(repo: str, args: argparse.Namespace) -> Optional[str]:
    base = args.base
    if args.staged and base is None:
        probe = pysafe.run_bounded(["git", "-C", repo, "rev-parse", "-q", "--verify", "HEAD^{commit}"],
                                   GIT_TIMEOUT_S, cap_bytes=4096)
        if probe.outcome != pysafe.OK:
            raise GitError("git rev-parse HEAD: TIMEOUT")
        base = "HEAD" if probe.returncode == 0 else None
    if args.head and base is None:
        parent = pysafe.run_bounded(["git", "-C", repo, "rev-parse", "-q", "--verify", args.head + "^"],
                                    GIT_TIMEOUT_S, cap_bytes=4096)
        if parent.outcome == pysafe.OK and parent.returncode == 0:
            base = parent.text().strip()
    return base
