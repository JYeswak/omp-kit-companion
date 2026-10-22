#!/usr/bin/env python3
"""tempsafe_check: refuse temp-dir creation outside kitlib (KITLIB-TMP v1).

ompkit-dhmzg (TEMPGATE1, J-2026-10-22-06). A temp dir made by hand has no
owner record and no exit/signal cleanup, so every killed or forgotten run
leaks it (2026-10-22: 77,299 dirs, 88 GB from kit tests and scripts). Temp
dirs come from kitlib only: ``ownedTmp`` (src/kitlib/tmp.ts), ``owned_tmp``
(scripts/kitlib_tmp.py) or ``kitlib_tmp`` (scripts/kitlib-tmp.sh). Temp files
are created inside an owned dir.

Judged files: .py .ts .tsx .js .mjs .cjs .sh .bash, and extensionless files
whose shebang names sh, bash, dash or python. Rule ``raw-temp`` (one finding
per line, naming every construct found on it):

A path under /tmp is temp creation; a bare "/tmp" (or "/tmp/") value such as
a fake ``cwd: "/tmp"`` creates nothing and is not a finding unless it starts
a path as described per language below.

  TS/JS   mkdtemp( / mkdtempSync( calls and .mkdtemp/.mkdtempSync member
          references (fs.promises.mkdtemp), any tmpdir( call (os.tmpdir()),
          string or template literals starting "/tmp/<more>", and a bare
          "/tmp" or "/tmp/" literal that is the left side of ``+``, the first
          argument of join/resolve (path.join, path.resolve), or a template
          head followed by ``${``. A small lexer blanks comments, string
          bodies and regex literals first, so names inside strings and
          comments never count.
  Python  calls resolving (import aliases followed) to tempfile.mkdtemp,
          mkstemp, mktemp, TemporaryDirectory, gettempdir, gettempdirb, and
          NamedTemporaryFile with a delete= keyword that is not literal True;
          string constants starting "/tmp/<more>", and a bare "/tmp" or
          "/tmp/" constant (AST position) that heads an f-string with more
          parts, is the left side of ``+``, the first argument of a join or
          resolve call (os.path.join), or of Path/PurePath used as the left
          side of ``/`` or with .joinpath.
  Shell   mktemp in command position (line start, after ; & | ( ` { ! or
          then/do/else/if/while/until/exec/command), $TMPDIR / ${TMPDIR...}
          expansions, and /tmp/ path words (a bare /tmp, as in ``cd /tmp``,
          is not). Comments are stripped with quote state carried across
          lines. Quoted-delimiter heredoc bodies are literal text and are
          skipped; unquoted-delimiter bodies are judged only for $(mktemp /
          `mktemp and $TMPDIR, which the shell expands.

Also: ``suppression-no-reason`` (a pragma without a reason of at least two
words and 10 characters), ``suppression-unused`` (a well-formed pragma on a
line with no finding), ``parse-error`` (Python that does not parse) and
``too-large`` (over 4 MiB). Suppression: a comment (``#`` or ``//`` or
``/*``) whose text starts ``tempsafe: <reason>`` on the flagged line.

Limits (declared, not hidden): TS/JS names are matched textually (an aliased
import such as ``import { tmpdir as t }`` then ``t()`` is not seen;
process.env.TMPDIR is not judged); the regex-versus-division decision and
JSX text containing quotes can mislex a line; Python follows import aliases
only (no data flow) and judges NamedTemporaryFile's delete by keyword only;
shell embedded programs (python3 - <<'PY', single-quoted python3 -c / awk
bodies) are not judged as their language, an arithmetic ``<<`` followed by a
name is taken for a heredoc, ``"$dir"/tmp`` (closing quote before /tmp) is
not a path word, and pragmas are not recognised inside heredoc bodies. A bare
"/tmp" that reaches a path only through a variable (``t = "/tmp"`` then
``join(t, x)``) or a non-first join argument is not seen.

Exempt (kitlib itself and this gate): see EXEMPT.

Modes:
  tempsafe_check.py PATH...                  judge files/dirs, every finding
  tempsafe_check.py --tree LABEL PATH ...    same, grouped under LABEL
  tempsafe_check.py --staged [--repo DIR]    pre-commit ratchet: staged files
                                             against HEAD (GIT_INDEX_FILE honoured)
  tempsafe_check.py --head REV [--base REV]  range ratchet (pre-push, CI)
Ratchet: a finding is new when its (rule, line text without comments)
fingerprint occurs more often in the new blob than in the old one (a rename
keeps the old blob as baseline); only the surplus is reported, as the last
occurrences. Untouched pre-existing sites do not block, new ones always do.
--format text|json. Exit 0 clean, 1 findings, 2 usage/infrastructure.
"""
from __future__ import annotations

import argparse
import ast
import bisect
import io
import json
import os
import re
import sys
import tokenize
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
# Only the pysafe runtime library is imported, never pysafe_check: a broken or
# hung pysafe_check.py (the staged-pysafe contract plants one) must not take
# this member down with it.
import pysafe  # noqa: E402

MAX_FILE_BYTES = 4 * 1024 * 1024
GIT_TIMEOUT_S = 30.0
GIT_CAP_BYTES = 64 * 1024 * 1024
SNIPPET_CHARS = 160
PRAGMA = "tempsafe"

RULES = {
    "raw-temp": "temp created outside kitlib (no owner record, no signal-safe cleanup)",
    "suppression-no-reason": "tempsafe suppression needs a reason (two or more words, 10+ characters)",
    "suppression-unused": "tempsafe suppression matches no finding on its line",
    "parse-error": "file does not parse; it cannot be judged",
    "too-large": "file exceeds the 4 MiB judging limit",
}
HINT = {
    "ts": "use ownedTmp(label) from src/kitlib/tmp.ts",
    "py": "use kitlib_tmp.owned_tmp(label) from scripts/kitlib_tmp.py",
    "sh": "source scripts/kitlib-tmp.sh, then kitlib_tmp VAR LABEL in the current shell (never inside $(...))",
}
# Kitlib's own implementations and this gate with its tests and fixtures.
# An entry ending in "/" exempts every path under that directory.
EXEMPT = (
    "src/kitlib/tmp.ts",
    "scripts/kitlib_tmp.py",
    "scripts/kitlib-tmp.sh",
    "scripts/tempsafe_check.py",
    "tests/scripts/tempsafe_check_test.py",
    "tests/cli/check-staged-tempsafe.test.sh",
    "tests/fixtures/tempsafe/",
)
EXTENSIONS = {".py": "py", ".ts": "ts", ".tsx": "ts", ".js": "ts", ".mjs": "ts", ".cjs": "ts",
              ".sh": "sh", ".bash": "sh"}
SKIP_DIRS = {"node_modules", "__pycache__", "venv"}

PY_RAW = {"tempfile.mkdtemp", "tempfile.mkstemp", "tempfile.mktemp", "tempfile.TemporaryDirectory",
          "tempfile.gettempdir", "tempfile.gettempdirb"}
PY_NAMED = "tempfile.NamedTemporaryFile"
PATH_FUNCS = {"join", "resolve"}
PATH_CLASSES = {"Path", "PurePath", "PosixPath", "PurePosixPath"}
JS_MKDTEMP_RE = re.compile(r"\bmkdtemp(?:Sync)?[ \t]*\(|\.mkdtemp(?:Sync)?\b")
JS_TMPDIR_RE = re.compile(r"\btmpdir[ \t]*\(")
SH_TMPDIR_RE = re.compile(r"\$\{?TMPDIR(?![A-Za-z0-9_])")
TMP_WORD_RE = re.compile(r"/tmp/")
HEREDOC_RE = re.compile(r"<<(-?)[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|\"([A-Za-z_][A-Za-z0-9_]*)\"|\\?([A-Za-z_][A-Za-z0-9_]*))")
REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^")
REGEX_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw",
               "instanceof", "yield", "await"}
SH_CMD_CHARS = set(";&|(`{!")
SH_CMD_WORDS = {"then", "do", "else", "if", "while", "until", "exec", "command"}

Hits = Dict[int, List[Tuple[int, str]]]


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


def _display(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def is_exempt(path: str) -> bool:
    posix = path.replace(os.sep, "/")
    for entry in EXEMPT:
        if entry.endswith("/"):
            if posix.startswith(entry) or "/" + entry in posix:
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


def _pragma(body: str) -> Optional[str]:
    """Reason text of a ``tempsafe:`` pragma ('' when malformed), or None when the comment is not one."""
    text = body.strip()
    if not text.startswith(PRAGMA):
        return None
    rest = text[len(PRAGMA):]
    if rest and rest[0] != ":":
        return None
    return rest[1:].strip()


def _collapse(text: str) -> str:
    joined = " ".join(text.split())
    return joined if len(joined) <= SNIPPET_CHARS else joined[:SNIPPET_CHARS] + "..."


def _add(hits: Hits, line: int, col: int, construct: str) -> None:
    entries = hits.setdefault(line, [])
    if all(name != construct for _, name in entries):
        entries.append((col, construct))


def _tmp_literal_kind(text: str) -> Optional[str]:
    """'under' for a path below /tmp ("/tmp/x"), 'bare' for "/tmp" or "/tmp/" alone, else None."""
    if text.startswith("/tmp/") and len(text) > len("/tmp/"):
        return "under"
    return "bare" if text in ("/tmp", "/tmp/") else None


def _callee(func: ast.AST) -> Optional[str]:
    if isinstance(func, ast.Name):
        return func.id
    return func.attr if isinstance(func, ast.Attribute) else None


def _py_builds_path(node: ast.AST, parents: Dict[int, ast.AST]) -> bool:
    """A bare "/tmp" constant that starts a path: f"/tmp/{x}", "/tmp" + x, join("/tmp", ...),
    resolve("/tmp", ...), Path("/tmp") / x, Path("/tmp").joinpath(...)."""
    parent = parents.get(id(node))
    if isinstance(parent, ast.JoinedStr):
        return parent.values[0] is node and len(parent.values) > 1
    if isinstance(parent, ast.BinOp):
        return isinstance(parent.op, ast.Add) and parent.left is node
    if not (isinstance(parent, ast.Call) and parent.args and parent.args[0] is node):
        return False
    name = _callee(parent.func)
    if name in PATH_FUNCS:
        return True
    if name not in PATH_CLASSES:
        return False
    grand = parents.get(id(parent))
    if isinstance(grand, ast.BinOp):
        return isinstance(grand.op, ast.Div) and grand.left is parent
    return isinstance(grand, ast.Attribute) and grand.attr == "joinpath"


# --- Python --------------------------------------------------------------
def _aliases(tree: ast.AST) -> Dict[str, str]:
    """Local name -> dotted import target (``import tempfile as tf``, ``from tempfile import mkdtemp``)."""
    aliases: Dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                head = alias.name.split(".")[0]
                aliases[alias.asname or head] = alias.name if alias.asname else head
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            for alias in node.names:
                aliases[alias.asname or alias.name] = node.module + "." + alias.name
    return aliases


def _resolve(node: ast.AST, aliases: Dict[str, str]) -> Optional[str]:
    if isinstance(node, ast.Name):
        return aliases.get(node.id)
    if isinstance(node, ast.Attribute):
        base = _resolve(node.value, aliases)
        return base + "." + node.attr if base else None
    return None


def _scan_py(source: bytes, path: str) -> Tuple[Hits, Dict[int, str], List[Tuple[int, int, str]]]:
    tree = ast.parse(source, filename=path)
    lines = source.decode("utf-8", "replace").split("\n")
    comment_col: Dict[int, int] = {}
    pragmas: List[Tuple[int, int, str]] = []
    for token in tokenize.tokenize(io.BytesIO(source).readline):
        if token.type == tokenize.COMMENT:
            line, col = token.start
            comment_col[line] = col
            pragmas.append((line, col + 1, token.string[1:]))
    aliases = _aliases(tree)
    hits: Hits = {}
    inner: Set[int] = set()
    parents: Dict[int, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node
        if isinstance(node, ast.JoinedStr):
            inner.update(id(value) for value in node.values[1:])
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _resolve(node.func, aliases)
            if name in PY_RAW:
                _add(hits, node.lineno, node.col_offset + 1, name)
            elif name == PY_NAMED:
                for keyword in node.keywords:
                    if keyword.arg == "delete" and not (isinstance(keyword.value, ast.Constant)
                                                        and keyword.value.value is True):
                        _add(hits, node.lineno, node.col_offset + 1, PY_NAMED + "(delete=False)")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in inner:
            kind = _tmp_literal_kind(node.value)
            if kind == "under" or (kind == "bare" and _py_builds_path(node, parents)):
                _add(hits, node.lineno, node.col_offset + 1, '"/tmp" path literal')
    texts = {line: lines[line - 1][:comment_col.get(line, len(lines[line - 1]))]
             for line in hits if line <= len(lines)}
    return hits, texts, pragmas


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


def _js_path_head(code: str, start: int, end: int) -> bool:
    """A bare "/tmp" literal spanning code[start:end+1] starts a path when it is
    the left side of ``+`` or the first argument of a join/resolve call
    (path.join, path.resolve, join, resolve)."""
    after = code[end + 1:end + 257].lstrip()
    if after.startswith("+") and not after.startswith("++"):
        return True
    before = code[max(0, start - 256):start].rstrip()
    if not before.endswith("("):
        return False
    before = before[:-1].rstrip()
    head = len(before)
    while head > 0 and (before[head - 1].isalnum() or before[head - 1] in "_$"):
        head -= 1
    return before[head:] in PATH_FUNCS


def _scan_ts(text: str) -> Tuple[Hits, Dict[int, str], List[Tuple[int, int, str]]]:
    code, bare, strings, comments = lex_js(text)
    starts = [0] + [m.end() for m in re.finditer("\n", text)]

    def where(offset: int) -> Tuple[int, int]:
        line = bisect.bisect_right(starts, offset)
        return line, offset - starts[line - 1] + 1

    hits: Hits = {}
    code_lines = code.split("\n")
    for number, line in enumerate(code_lines, 1):
        for match in JS_MKDTEMP_RE.finditer(line):
            _add(hits, number, match.start() + 1, "mkdtemp")
        for match in JS_TMPDIR_RE.finditer(line):
            _add(hits, number, match.start() + 1, "tmpdir()")
    for offset, literal, end, interpolated in strings:
        kind = _tmp_literal_kind(literal)
        if kind == "under" or (kind == "bare" and (interpolated or _js_path_head(code, offset, end))):
            line, col = where(offset)
            _add(hits, line, col, '"/tmp" path literal')
    bare_lines = bare.split("\n")
    texts = {line: bare_lines[line - 1] for line in hits}
    pragmas = [(*where(offset), body) for offset, body in comments]
    return hits, texts, pragmas


# --- shell ---------------------------------------------------------------
def _sh_line(line: str, quote: str) -> Tuple[str, Optional[str], str, List[Tuple[str, bool, bool]]]:
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


def _sh_command_position(code: str, start: int) -> bool:
    before = code[:start].rstrip(" \t")
    if not before:
        return True
    if before[-1] in SH_CMD_CHARS:
        return True
    word = before.rsplit(None, 1)[-1]
    return word in SH_CMD_WORDS


def _sh_tmp_word(code: str, start: int) -> bool:
    if start == 0:
        return True
    prev = code[start - 1]
    if prev in " \t=:(,'-":
        return True
    if prev == '"':
        return start < 2 or not (code[start - 2].isalnum() or code[start - 2] in '_}$"\'')
    return False


def _scan_sh(text: str) -> Tuple[Hits, Dict[int, str], List[Tuple[int, int, str]]]:
    hits: Hits = {}
    texts: Dict[int, str] = {}
    pragmas: List[Tuple[int, int, str]] = []
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
                for match in re.finditer(r"\bmktemp\b", line):
                    if line[:match.start()].endswith(("$(", "`")):
                        _add(hits, number, match.start() + 1, "mktemp")
                for match in SH_TMPDIR_RE.finditer(line):
                    _add(hits, number, match.start() + 1, "$TMPDIR")
                if number in hits:
                    texts[number] = line
            continue
        code, comment, quote, opened = _sh_line(line, quote)
        if comment is not None:
            pragmas.append((number, len(code) + 1, comment))
        pending.extend(opened)
        if pending and quote == "":
            body = pending.pop(0)
        for match in re.finditer(r"\bmktemp(?![A-Za-z0-9_.-])", code):
            if _sh_command_position(code, match.start()):
                _add(hits, number, match.start() + 1, "mktemp")
        for match in SH_TMPDIR_RE.finditer(code):
            _add(hits, number, match.start() + 1, "$TMPDIR")
        for match in TMP_WORD_RE.finditer(code):
            if _sh_tmp_word(code, match.start()):
                _add(hits, number, match.start() + 1, "/tmp path")
        if number in hits:
            texts[number] = code
    return hits, texts, pragmas


# --- assembly ------------------------------------------------------------
def check_source(source: bytes, path: str, lang: str) -> FileReport:
    report = FileReport(path)
    if len(source) > MAX_FILE_BYTES:
        report.findings.append(Finding(path, 1, 1, "too-large", RULES["too-large"], f"{len(source)} bytes"))
        return report
    if lang == "py":
        try:
            hits, texts, pragmas = _scan_py(source, path)
        except (SyntaxError, ValueError, RecursionError, tokenize.TokenError) as exc:
            line = getattr(exc, "lineno", None) or 1
            report.findings.append(Finding(path, line, 1, "parse-error", f"{type(exc).__name__}: {exc}",
                                           type(exc).__name__))
            return report
    elif lang == "ts":
        hits, texts, pragmas = _scan_ts(source.decode("utf-8", "replace"))
    else:
        hits, texts, pragmas = _scan_sh(source.decode("utf-8", "replace"))
    reasons: Dict[int, str] = {}
    for line, col, body in pragmas:
        reason = _pragma(body)
        if reason is None:
            continue
        if len(reason) < 10 or len(reason.split()) < 2:
            report.findings.append(Finding(path, line, col, "suppression-no-reason", RULES["suppression-no-reason"],
                                           _collapse(PRAGMA + ":" + reason)))
            continue
        reasons[line] = reason
    for line in sorted(hits):
        entries = sorted(hits[line])
        detail = f"temp created outside kitlib ({', '.join(name for _, name in entries)}); {HINT[lang]}"
        report.findings.append(Finding(path, line, entries[0][0], "raw-temp", detail,
                                       _collapse(texts.get(line, "")), reasons.get(line)))
    for line in sorted(set(reasons) - set(hits)):
        report.findings.append(Finding(path, line, 1, "suppression-unused", RULES["suppression-unused"],
                                       _collapse(reasons[line])))
    report.findings.sort(key=lambda f: (f.line, f.col, f.rule))
    return report


def check_file(path: str) -> Optional[FileReport]:
    """Judge one file; None when it is exempt or not a judged language."""
    if is_exempt(path):
        return None
    with open(path, "rb") as handle:
        source = handle.read(MAX_FILE_BYTES + 1)
    lang = language(path, source[:256])
    return None if lang is None else check_source(source, path, lang)


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


# --- git ratchet ---------------------------------------------------------
def _changed(raw: bytes) -> List[Tuple[Optional[str], str]]:
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
    return [(old, new) for old, new in pairs if not is_exempt(new)]


def ratchet(repo: str, base: Optional[str], head: Optional[str]) -> List[FileReport]:
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
    for old, new in _changed(raw):
        ext = os.path.splitext(os.path.basename(new))[1]
        if ext and ext not in EXTENSIONS:
            continue
        new_source = _git(repo, "cat-file", "blob", (":" if head is None else head + ":") + new)
        lang = language(new, new_source[:256])
        if lang is None:
            continue
        after_active = check_source(new_source, new, lang).active()
        before_keys: Counter = Counter()
        if old is not None and base is not None:
            old_source = _git(repo, "cat-file", "blob", f"{base}:{old}")
            before_keys = Counter(f.key() for f in check_source(old_source, old, lang).active())
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


# --- output --------------------------------------------------------------
def emit_json(groups: Sequence[Tuple[str, List[FileReport]]], out) -> None:
    payload = {"rules": RULES, "groups": []}
    for label, reports in groups:
        active = [len(r.active()) for r in reports]
        payload["groups"].append({
            "label": label,
            "summary": {"files": len(reports), "files_with_findings": sum(1 for n in active if n),
                        "findings": sum(active),
                        "suppressed": sum(len(r.findings) - len(r.active()) for r in reports)},
            "files": [{"path": _display(r.path), "findings": [f.as_json() for f in r.findings]}
                      for r in reports],
        })
    json.dump(payload, out, indent=1, sort_keys=True)
    out.write("\n")


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


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="tempsafe_check.py", description=__doc__.split("\n\n")[0])
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
            groups.append(("changed", ratchet(args.repo, base, None if args.staged else args.head)))
        except GitError as exc:
            sys.stderr.write(f"tempsafe_check: {exc}\n")
            return 2
    else:
        entries: List[Tuple[str, str]] = [(p, p) for p in args.paths] + [(t[0], t[1]) for t in args.tree]
        if not entries:
            parser.error("give PATH arguments, --tree, --staged or --head")
        by_label: Dict[str, List[FileReport]] = {}
        for label, path in entries:
            if not os.path.exists(path):
                sys.stderr.write(f"tempsafe_check: no such path: {path}\n")
                return 2
            bucket = by_label.setdefault(label, [])
            for file_path in iter_files(path):
                report = check_file(file_path)
                if report is not None:
                    bucket.append(report)
        groups = list(by_label.items())
    if args.format == "json":
        emit_json(groups, sys.stdout)
    else:
        for _, reports in groups:
            for report in reports:
                for f in report.active():
                    sys.stdout.write(f"{_display(f.path)}:{f.line}:{f.col}: {f.rule}: {f.detail}: {f.snippet}\n")
    return 1 if any(r.active() for _, reports in groups for r in reports) else 0


if __name__ == "__main__":
    pysafe.run_main(main)
