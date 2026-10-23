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
  Shell   mktemp (bare or by absolute path, /usr/bin/mktemp) in command
          position (line start, after ; & | ( ` { ! or
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
``join(t, x)``) or a non-first join argument is not seen, nor is a shell
mktemp reached through a relative or variable path (``"$BIN"/mktemp``).

Exempt (kitlib itself and this gate): see EXEMPT.

The engine (selection, pragmas, ratchet, CLI) is scripts/kitlib_ratchet_core.py,
shared with scripts/kitlib_ratchet.py; this file holds the raw-temp rule set.

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

import ast
import os
import re
import sys
from typing import Dict, List, Optional

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import kitlib_ratchet_core as core  # noqa: E402  (imports only pysafe, never pysafe_check)

MAX_FILE_BYTES = core.MAX_FILE_BYTES
PRAGMA = "tempsafe"

RULES = {"raw-temp": "temp created outside kitlib (no owner record, no signal-safe cleanup)", **core.meta_rules(PRAGMA)}
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

PY_RAW = {"tempfile.mkdtemp", "tempfile.mkstemp", "tempfile.mktemp", "tempfile.TemporaryDirectory",
          "tempfile.gettempdir", "tempfile.gettempdirb"}
PY_NAMED = "tempfile.NamedTemporaryFile"
PATH_FUNCS = {"join", "resolve"}
PATH_CLASSES = {"Path", "PurePath", "PosixPath", "PurePosixPath"}
JS_MKDTEMP_RE = re.compile(r"\bmkdtemp(?:Sync)?[ \t]*\(|\.mkdtemp(?:Sync)?\b")
JS_TMPDIR_RE = re.compile(r"\btmpdir[ \t]*\(")
SH_MKTEMP_RE = re.compile(r"\bmktemp(?![A-Za-z0-9_.-])")
SH_TMPDIR_RE = re.compile(r"\$\{?TMPDIR(?![A-Za-z0-9_])")
TMP_WORD_RE = re.compile(r"/tmp/")
RULE = "raw-temp"


def _detail(rule: str, lang: str, constructs: List[str]) -> str:
    return f"temp created outside kitlib ({', '.join(constructs)}); {HINT[lang]}"


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
def _scan_py(source: bytes, path: str) -> core.Scan:
    parsed = core.py_source(source, path)
    hits = core.Hits()
    inner = set()
    parents: Dict[int, ast.AST] = {}
    for node in ast.walk(parsed.tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node
        if isinstance(node, ast.JoinedStr):
            inner.update(id(value) for value in node.values[1:])
    for node in ast.walk(parsed.tree):
        if isinstance(node, ast.Call):
            name = core.resolve(node.func, parsed.aliases)
            if name in PY_RAW:
                hits.add(RULE, node.lineno, node.col_offset + 1, name)
            elif name == PY_NAMED:
                for keyword in node.keywords:
                    if keyword.arg == "delete" and not (isinstance(keyword.value, ast.Constant)
                                                        and keyword.value.value is True):
                        hits.add(RULE, node.lineno, node.col_offset + 1, PY_NAMED + "(delete=False)")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in inner:
            kind = _tmp_literal_kind(node.value)
            if kind == "under" or (kind == "bare" and _py_builds_path(node, parents)):
                hits.add(RULE, node.lineno, node.col_offset + 1, '"/tmp" path literal')
    return core.Scan(hits, parsed.texts(hits.lines()), parsed.pragmas)


# --- TS/JS ---------------------------------------------------------------
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


def _scan_ts(source: bytes, path: str) -> core.Scan:
    text = source.decode("utf-8", "replace")
    code, bare, strings, comments = core.lex_js(text)
    where = core.js_locator(text)
    hits = core.Hits()
    for number, line in enumerate(code.split("\n"), 1):
        for match in JS_MKDTEMP_RE.finditer(line):
            hits.add(RULE, number, match.start() + 1, "mkdtemp")
        for match in JS_TMPDIR_RE.finditer(line):
            hits.add(RULE, number, match.start() + 1, "tmpdir()")
    for offset, literal, end, interpolated in strings:
        kind = _tmp_literal_kind(literal)
        if kind == "under" or (kind == "bare" and (interpolated or _js_path_head(code, offset, end))):
            line, col = where(offset)
            hits.add(RULE, line, col, '"/tmp" path literal')
    return core.js_scan(text, hits, bare, comments, where)


# --- shell ---------------------------------------------------------------
def _sh_tmp_word(code: str, start: int) -> bool:
    if start == 0:
        return True
    prev = code[start - 1]
    if prev in " \t=:(,'-":
        return True
    if prev == '"':
        return start < 2 or not (code[start - 2].isalnum() or code[start - 2] in '_}$"\'')
    return False


def _sh_code(code: str, number: int, hits: core.Hits) -> None:
    for start, _ in core.sh_command_words(code, SH_MKTEMP_RE):
        if core.sh_command_position(code, start):
            hits.add(RULE, number, start + 1, "mktemp")
    for match in SH_TMPDIR_RE.finditer(code):
        hits.add(RULE, number, match.start() + 1, "$TMPDIR")
    for match in TMP_WORD_RE.finditer(code):
        if _sh_tmp_word(code, match.start()):
            hits.add(RULE, number, match.start() + 1, "/tmp path")


def _sh_heredoc(line: str, number: int, hits: core.Hits) -> None:
    for start, _ in core.sh_command_words(line, SH_MKTEMP_RE):
        if line[:start].endswith(("$(", "`")):
            hits.add(RULE, number, start + 1, "mktemp")
    for match in SH_TMPDIR_RE.finditer(line):
        hits.add(RULE, number, match.start() + 1, "$TMPDIR")


def _scan_sh(source: bytes, path: str) -> core.Scan:
    return core.scan_sh(source.decode("utf-8", "replace"), _sh_code, _sh_heredoc)


RULESET = core.RuleSet(
    prog="tempsafe_check",
    description=__doc__.split("\n\n")[0],
    pragma=PRAGMA,
    rules=RULES,
    exempt=EXEMPT,
    scanners={"py": _scan_py, "ts": _scan_ts, "sh": _scan_sh},
    detail=_detail,
)
language = core.language
is_exempt = RULESET.is_exempt
check_source = RULESET.check_source
check_file = RULESET.check_file
ratchet = RULESET.ratchet
main = RULESET.main


if __name__ == "__main__":
    core.pysafe.run_main(main)
